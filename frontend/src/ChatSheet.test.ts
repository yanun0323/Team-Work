import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Chats } from './DrawerTabs'
import { useStore } from './core/store'
import { describe, expect, it } from 'vitest'
import { attachable, splitAttachments } from './attachments'
import { seedWorld } from './core/data/seed'
import { airportSkills, canHandOff, chatSkill, chatTaskDraft, createAirportChat, createChat, deleteTeam, handOffChat, readChat, REPLY_TIME, rewindChat, sayInChat, setChatMind, steerChat, stopChat, tick, unqueueChat } from './core/domain/sim'
import { chatMindOf, chatSign, chatWho } from './crew'
import { prereqsOf } from './prereqs'
import { teamAlerts, teamReplicas, waitingTab } from './core/model'

// the mock world comes with a meeting; these count and list only the chats they make
const bare = () => {
  const w = seedWorld()
  w.chats = {}
  return w
}

const setup = () => {
  const w = bare()
  const teamId = Object.keys(w.teams)[0]
  const r = teamReplicas(w, teamId)[0]
  return { w, teamId, r, chat: createChat(w, { teamId, replicaId: r.id, text: '第一句\n第二行' }) }
}

describe('chats', () => {
  it('counts unread chats and tasks waiting for a reply apart', () => {
    const { w, teamId, chat } = setup()
    const tasks = teamAlerts(w, teamId).waitingTasks
    delete w.chats[chat.id].replyAt
    w.chats[chat.id].unread = true
    expect(teamAlerts(w, teamId)).toEqual({ waitingChats: 1, waitingTasks: tasks })
    const task = Object.values(w.tasks).find((x) => x.teamId === teamId && x.stage === 'running')!
    task.stage = 'awaitMerge'
    expect(teamAlerts(w, teamId)).toEqual({ waitingChats: 1, waitingTasks: tasks + 1 })
  })

  it('leaves a chat still replying out of the unread count', () => {
    const { w, teamId, chat } = setup()
    w.chats[chat.id].unread = true
    w.chats[chat.id].replyAt = w.now
    expect(teamAlerts(w, teamId).waitingChats).toBe(0)
    delete w.chats[chat.id].replyAt
    expect(teamAlerts(w, teamId).waitingChats).toBe(1)
  })

  it('keeps counting a chat already read while it still waits on the user', () => {
    const { w, teamId, chat } = setup()
    const c = w.chats[chat.id]
    delete c.replyAt
    c.unread = false
    c.question = { options: ['A', 'B'] }
    expect(teamAlerts(w, teamId).waitingChats).toBe(1)
    delete c.question
    expect(teamAlerts(w, teamId).waitingChats).toBe(0)
  })

  it('finds the tab with something waiting, tasks before chats', () => {
    const { w, teamId, chat } = setup()
    for (const t of Object.values(w.tasks)) if (t.teamId === teamId) t.stage = 'cancelled'
    w.chats[chat.id].unread = false
    expect(waitingTab(w, teamId)).toBeUndefined()
    w.chats[chat.id].unread = true
    expect(waitingTab(w, teamId)).toBe('chats')
    // read, but still waiting on an answer
    w.chats[chat.id].unread = false
    w.chats[chat.id].question = { options: [] }
    expect(waitingTab(w, teamId)).toBe('chats')
    const task = Object.values(w.tasks).find((x) => x.teamId === teamId)!
    task.stage = 'awaitMerge'
    expect(waitingTab(w, teamId)).toBe('tasks')
    expect(waitingTab(w, teamId, 'chats')).toBe('chats')
    w.chats[chat.id].question = undefined
    expect(waitingTab(w, teamId, 'chats')).toBe('tasks')
  })

  it('queue what is said while replying, steered first, and send it when the reply ends', () => {
    const { w, chat } = setup()
    for (const text of ['排隊', '轉向', '收回']) sayInChat(w, chat.id, text)
    const c = w.chats[chat.id]
    expect(c.messages).toHaveLength(1)
    steerChat(w, chat.id, c.queue![1].id)
    unqueueChat(w, chat.id, c.queue![2].id)
    expect(c.queue!.map((q) => [q.text, !!q.steer])).toEqual([['轉向', true], ['排隊', false]])
    tick(w, REPLY_TIME)
    expect(c.messages.at(-1)?.text).toBe('轉向')
    tick(w, REPLY_TIME)
    expect(c.messages.filter((m) => m.from === 'user').map((m) => m.text)).toEqual(['第一句\n第二行', '轉向', '排隊'])
    expect(c.queue).toEqual([])
  })

  it('wait in the queue after a stop until steered, which sends it now', () => {
    const { w, chat } = setup()
    sayInChat(w, chat.id, '之後')
    stopChat(w, chat.id)
    const c = w.chats[chat.id]
    expect(c.queue).toHaveLength(1)
    steerChat(w, chat.id, c.queue![0].id)
    expect(c.messages.at(-1)?.text).toBe('之後')
    expect(c.replyAt).toBeDefined()
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
    expect(handOffChat(w, chat.id, 0, chat.replicaId)?.unread).toBeUndefined()
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
    // still writing: the message it answers can be forked, and the original goes on
    const early = handOffChat(w, chat.id, 0, chat.replicaId)!
    expect(early.replyAt).toBeUndefined()
    expect(chat.replyAt).toBeDefined()
    for (let i = 0; i < 60; i++) tick(w, 0.1)
    sayInChat(w, chat.id, '再一句')
    for (let i = 0; i < 60; i++) tick(w, 0.1)
    const fork = handOffChat(w, chat.id, 1, chat.replicaId)!
    expect(fork.id).not.toBe(chat.id)
    expect(fork.messages.map((m) => m.from)).toEqual(['user', 'agent'])
    expect(fork.replyAt).toBeUndefined()
    expect(chat.messages).toHaveLength(4)
    sayInChat(w, fork.id, '分支')
    expect(fork.messages).toHaveLength(3)
    expect(chat.messages).toHaveLength(4)
    expect(handOffChat(w, chat.id, 2, chat.replicaId)!.messages).toHaveLength(3)

    const m = (from: 'user' | 'agent' | 'tool') => ({ at: 0, from, text: '' })
    const turn = [m('user'), m('agent'), m('tool'), m('agent'), m('tool'), m('user')]
    expect(turn.map((_, i) => canHandOff(turn, i))).toEqual([true, false, false, true, false, true])
    // a reply still being written has no end to fork at, but what came before does
    expect(turn.map((_, i) => canHandOff(turn, i, true))).toEqual([true, false, false, true, false, true])
    const writing = [...turn, m('agent')]
    expect(canHandOff(writing, 6, true)).toBe(false)
    expect(canHandOff(writing, 6)).toBe(true)
    chat.messages.push(m('agent'))
    chat.replyAt = 0
    expect(handOffChat(w, chat.id, chat.messages.length - 1, chat.replicaId)).toBeUndefined()
  })

  it('hand off to another employee of the company, who takes over from there', () => {
    const { w, teamId, r, chat } = setup()
    const other = teamReplicas(w, teamId).find((x) => x.id !== r.id)!
    for (let i = 0; i < 60; i++) tick(w, 0.1)
    sayInChat(w, chat.id, '再一句')
    for (let i = 0; i < 60; i++) tick(w, 0.1)
    expect(handOffChat(w, chat.id, 2, 'nobody')).toBeUndefined()
    // from the user's message: the other one answers it
    const got = handOffChat(w, chat.id, 2, other.id)!
    expect(got).toMatchObject({ replicaId: other.id, name: other.name, model: other.model, handoffs: [{ before: 2, replicaId: r.id, name: r.name }] })
    expect(got.effort).toBeUndefined()
    expect(chat.handoffs).toBeUndefined()
    // and handed back after Bea's reply, the line goes after it
    for (let i = 0; i < 60; i++) tick(w, 0.1)
    sayInChat(w, got.id, '第三句')
    for (let i = 0; i < 60; i++) tick(w, 0.1)
    const back = handOffChat(w, got.id, got.messages.length - 1, r.id)!
    expect(back.handoffs?.map((h) => [h.before, h.name])).toEqual([[2, r.name], [back.messages.length, other.name]])
    rewindChat(w, back.id, 0)
    expect(back.handoffs?.map((h) => h.before)).toEqual([0, 0])
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
    const w = bare()
    return { w, chat: createAirportChat(w, { model: 'm', effort: 'default', text: '你好' }) }
  }

  it('reply with no employee, and count as unread for the airport alone', () => {
    const { w, chat } = start()
    tick(w, REPLY_TIME)
    expect(chatSign(w.chats[chat.id])).toBe('unread')
    expect(teamAlerts(w, '')).toEqual({ waitingChats: 1, waitingTasks: 0 })
    expect(teamAlerts(w, Object.keys(w.teams)[0]).waitingChats).toBe(0)
    readChat(w, chat.id)
    expect(teamAlerts(w, '').waitingChats).toBe(0)
  })

  it('go on and fork though no employee is behind them', () => {
    const { w, chat } = start()
    tick(w, REPLY_TIME)
    sayInChat(w, chat.id, '再一句')
    expect(w.chats[chat.id].replyAt).toBeDefined()
    tick(w, REPLY_TIME)
    expect(handOffChat(w, chat.id, 0, chat.replicaId)?.teamId).toBe('')
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

  it('offer the airport staff\'s skills and open them', () => {
    const { w, chat } = start()
    const names = airportSkills(w).map((s) => s.name)
    expect(names.length).toBeGreaterThan(0)
    expect(chatSkill(w, chat.id, names[0]).name).toBe(names[0])
    expect(() => chatSkill(w, chat.id, 'nope')).toThrow()
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
    delete w.chats['chat-meeting']
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

describe('a meeting on the list', () => {
  it('stacks the faces with the chair in front and lists the names in place of the model', () => {
    const w = useStore.getState().world
    delete w.chats['chat-meeting']
    const teamId = Object.keys(w.teams)[0]
    const [ada, bea, cy, dee] = teamReplicas(w, teamId)
    const chat = createChat(w, { teamId, replicaId: ada.id, guests: [bea, cy, dee].filter(Boolean).map((r) => r.id), text: '嗨' })
    try {
      const html = renderToStaticMarkup(createElement(Chats, { teamId, open: null, onOpen: () => {} }))
      const row = html.slice(html.indexOf('fx-faces-stack'))
      const names = [ada, bea, cy, dee].filter(Boolean).map((r) => r.name)
      expect(row).toContain(names.join('、'))
      expect(row).not.toContain(chatMindOf(w, chat))
      // the first three, the deepest first so the chair lies on top, and no more
      const stack = row.slice(0, row.indexOf('fx-row-main'))
      const faces = [...stack.matchAll(/class="pixel-face"[^>]*aria-label="([^"]*)"/g)].map((m) => m[1])
      expect(faces).toEqual(names.slice(0, 3).reverse())
      expect(stack).not.toMatch(/>\+\d/)
    } finally {
      delete w.chats[chat.id]
    }
  })
})
