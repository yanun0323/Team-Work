import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Chats } from './DrawerTabs'
import { useStore } from './core/store'
import { describe, expect, it } from 'vitest'
import { attachable, splitAttachments } from './attachments'
import { seedWorld } from './core/data/seed'
import { canFork, chatTaskDraft, createAirportChat, createChat, deleteTeam, forkChat, readChat, REPLY_TIME, rewindChat, sayInChat, setChatMind, stopChat, tick } from './core/domain/sim'
import { chatMindOf, chatSign, chatWho } from './crew'
import { prereqsOf } from './prereqs'
import { teamAlerts, teamReplicas } from './core/model'

const setup = () => {
  const w = seedWorld()
  const teamId = Object.keys(w.teams)[0]
  const r = teamReplicas(w, teamId)[0]
  return { w, teamId, r, chat: createChat(w, { teamId, replicaId: r.id, text: '第一句\n第二行' }) }
}

describe('chats', () => {
  it('counts unread chats and tasks waiting for a reply apart', () => {
    const { w, teamId, chat } = setup()
    const tasks = teamAlerts(w, teamId).waitingTasks
    w.chats[chat.id].unread = true
    expect(teamAlerts(w, teamId)).toEqual({ unreadChats: 1, waitingTasks: tasks })
    const task = Object.values(w.tasks).find((x) => x.teamId === teamId && x.stage === 'running')!
    task.stage = 'awaitMerge'
    expect(teamAlerts(w, teamId)).toEqual({ unreadChats: 1, waitingTasks: tasks + 1 })
  })

  it('signs a reply being written, then unread until it is read', () => {
    const { w, chat } = setup()
    expect(chatSign(w.chats[chat.id])).toBe('replying')
    tick(w, REPLY_TIME)
    expect(chatSign(w.chats[chat.id])).toBe('unread')
    readChat(w, chat.id)
    expect(chatSign(w.chats[chat.id])).toBeUndefined()
  })

  it('signs an open question over unread, and starts a fork read', () => {
    const { w, chat } = setup()
    w.chats[chat.id].question = { options: [] }
    tick(w, REPLY_TIME)
    expect(chatSign(w.chats[chat.id])).toBe('question')
    expect(forkChat(w, chat.id, 0)?.unread).toBeUndefined()
  })

  it('begin with the first message, on the model of their employee, and get a reply', () => {
    const { w, r, chat } = setup()
    expect(chat).toMatchObject({ replicaId: r.id, name: r.name, model: r.model })
    expect(chat.messages.map((m) => m.from)).toEqual(['user'])
    expect(chat.replyAt).toBeDefined()
    for (let i = 0; i < 60; i++) tick(w, 0.1)
    expect(w.chats[chat.id].replyAt).toBeUndefined()
    expect(w.chats[chat.id].messages.at(-1)?.from).toBe('agent')
  })

  it('fork into a copy of their own, only at the end of a reply or at the user\'s message', () => {
    const { w, chat } = setup()
    expect(forkChat(w, chat.id, 0)).toBeUndefined() // still writing
    for (let i = 0; i < 60; i++) tick(w, 0.1)
    sayInChat(w, chat.id, '再一句')
    for (let i = 0; i < 60; i++) tick(w, 0.1)
    const fork = forkChat(w, chat.id, 1)!
    expect(fork.id).not.toBe(chat.id)
    expect(fork.messages.map((m) => m.from)).toEqual(['user', 'agent'])
    expect(fork.replyAt).toBeUndefined()
    expect(chat.messages).toHaveLength(4)
    sayInChat(w, fork.id, '分支')
    expect(fork.messages).toHaveLength(3)
    expect(chat.messages).toHaveLength(4)
    expect(forkChat(w, chat.id, 2)!.messages).toHaveLength(3)

    const m = (from: 'user' | 'agent' | 'tool') => ({ at: 0, from, text: '' })
    const turn = [m('user'), m('agent'), m('tool'), m('agent'), m('tool'), m('user')]
    expect(turn.map((_, i) => canFork(turn, i))).toEqual([true, false, false, true, false, true])
  })

  it('take no message while writing, and go on after a stop without the reply', () => {
    const { w, chat } = setup()
    sayInChat(w, chat.id, '插話')
    expect(chat.messages).toHaveLength(1)
    stopChat(w, chat.id)
    for (let i = 0; i < 60; i++) tick(w, 0.1)
    expect(chat.messages).toHaveLength(1)
    sayInChat(w, chat.id, '繼續')
    expect(chat.messages).toHaveLength(2)
  })

  it('take back a message with all after it, and go on from there', () => {
    const { w, chat } = setup()
    for (let i = 0; i < 60; i++) tick(w, 0.1)
    sayInChat(w, chat.id, '有圖', [{ name: 'a.png', url: 'data:image/png;base64,AAAA' }])
    expect(chat.messages.at(-1)?.images).toHaveLength(1)
    expect(chat.replyAt).toBeDefined()
    rewindChat(w, chat.id, 1) // the employee's: nothing happens
    expect(chat.messages).toHaveLength(3)
    rewindChat(w, chat.id, 2)
    expect(chat.messages.map((m) => m.from)).toEqual(['user', 'agent'])
    expect(chat.replyAt).toBeUndefined()
    rewindChat(w, chat.id, 0)
    expect(chat.messages).toEqual([])
    sayInChat(w, chat.id, '只有圖', [{ name: 'a.png', url: 'data:image/png;base64,AAAA' }])
    expect(chat.messages).toHaveLength(1)
  })

  it('accept files as well as images, within count and size limits', () => {
    const file = (type: string, size: number) => ({ type, size }) as File
    expect(attachable([file('image/png', 10)], 6)).toMatchObject({ refused: false })
    expect(attachable([file('application/pdf', 10), file('', 0)], 6)).toMatchObject({ refused: false })
    expect(attachable([file('image/png', 4 << 20)], 6)).toMatchObject({ fit: [], refused: true })
    expect(attachable([file('application/pdf', 25 << 20)], 6)).toMatchObject({ refused: false })
    expect(attachable([file('application/pdf', (25 << 20) + 1)], 6)).toMatchObject({ fit: [], refused: true })
    expect(attachable([file('image/png', 1), file('image/png', 1)], 1).fit).toHaveLength(1)
  })

  it('keeps file-only messages and separates previews from downloadable files', () => {
    const { w, chat } = setup()
    stopChat(w, chat.id)
    const file = { name: 'spec.txt', url: 'data:text/plain;base64,aGk=' }
    const image = { name: 'shot.png', url: 'data:image/png;base64,AAAA' }
    expect(splitAttachments([file, image])).toEqual({ files: [file], images: [image] })
    sayInChat(w, chat.id, '', [], [file])
    expect(chat.messages.at(-1)).toMatchObject({ text: '', files: [file] })
    rewindChat(w, chat.id, 1)
    expect(chat.messages).toHaveLength(1)
    sayInChat(w, chat.id, '', [], [file])
    expect(chat.messages.at(-1)?.files).toEqual([file])
  })

  it('write a task from what the user said, and go with their company', () => {
    const { w, teamId, chat } = setup()
    expect(chatTaskDraft(w, chat.id)).toEqual({ title: '第一句', description: '第一句\n第二行' })
    deleteTeam(w, teamId)
    expect(w.chats).toEqual({})
  })
})

describe('a question from the employee', () => {
  it('stays open until the next message, which answers it', () => {
    const { w, chat } = setup()
    for (let i = 0; i < 60; i++) tick(w, 0.1)
    sayInChat(w, chat.id, '可以嗎？')
    for (let i = 0; i < 60; i++) tick(w, 0.1)
    expect(chat.question?.options).toHaveLength(2)
    expect(chat.messages.at(-1)?.from).toBe('agent')
    sayInChat(w, chat.id, chat.question!.options[0])
    expect(chat.question).toBeUndefined()
    for (let i = 0; i < 60; i++) tick(w, 0.1)
    expect(chat.question).toBeUndefined()
  })
})

describe('airport chats', () => {
  const start = () => {
    const w = seedWorld()
    return { w, chat: createAirportChat(w, { model: 'm', effort: 'default', text: '你好' }) }
  }

  it('reply with no employee, and count as unread for the airport alone', () => {
    const { w, chat } = start()
    tick(w, REPLY_TIME)
    expect(chatSign(w.chats[chat.id])).toBe('unread')
    expect(teamAlerts(w, '')).toEqual({ unreadChats: 1, waitingTasks: 0 })
    expect(teamAlerts(w, Object.keys(w.teams)[0]).unreadChats).toBe(0)
    readChat(w, chat.id)
    expect(teamAlerts(w, '').unreadChats).toBe(0)
  })

  it('go on and fork though no employee is behind them', () => {
    const { w, chat } = start()
    tick(w, REPLY_TIME)
    sayInChat(w, chat.id, '再一句')
    expect(w.chats[chat.id].replyAt).toBeDefined()
    tick(w, REPLY_TIME)
    expect(forkChat(w, chat.id, 0)?.teamId).toBe('')
  })

  it('change model between replies only', () => {
    const { w, chat } = start()
    setChatMind(w, chat.id, 'n', 'high')
    expect(w.chats[chat.id].model).toBe('m')
    tick(w, REPLY_TIME)
    setChatMind(w, chat.id, 'n', 'high')
    expect(chatMindOf(w, w.chats[chat.id])).toBe('n · high')
    expect(chatWho(w, w.chats[chat.id]).name).toBe('機場服務人員')
  })

  it('leave company chats on their model', () => {
    const { w, teamId, r, chat } = setup()
    tick(w, REPLY_TIME)
    setChatMind(w, chat.id, 'n', 'high')
    expect(w.chats[chat.id].model).toBe(r.model)
    expect(teamId).toBeTruthy()
  })

  it('need only a model provider', () => {
    const w = seedWorld()
    expect(prereqsOf(w, '', 'airportChats', null)).toEqual([])
    w.providers = {}
    expect(prereqsOf(w, '', 'airportChats', null).map((x) => x.id)).toEqual(['provider'])
  })
})

describe('the chat list', () => {
  it('puts the sign before the face', () => {
    // rendered on the server, the store gives its first state: the chat has to go in there
    const w = useStore.getState().world
    const teamId = Object.keys(w.teams)[0]
    const chat = createChat(w, { teamId, replicaId: teamReplicas(w, teamId)[0].id, text: '嗨' })
    delete chat.replyAt
    chat.unread = true
    try {
      const html = renderToStaticMarkup(createElement(Chats, { teamId, open: null, onOpen: () => {} }))
      expect(html.indexOf('fx-chat-unread')).toBeGreaterThan(-1)
      expect(html.indexOf('fx-chat-unread')).toBeLessThan(html.indexOf('<svg'))
    } finally {
      delete w.chats[chat.id]
    }
  })
})
