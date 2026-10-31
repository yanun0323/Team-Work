import { describe, expect, it } from 'vitest'
import { attachable } from './ChatSheet'
import { seedWorld } from './core/data/seed'
import { chatTaskDraft, createChat, deleteTeam, rewindChat, sayInChat, stopChat, tick } from './core/domain/sim'
import { teamReplicas } from './core/model'

const setup = () => {
  const w = seedWorld()
  const teamId = Object.keys(w.teams)[0]
  const r = teamReplicas(w, teamId)[0]
  return { w, teamId, r, chat: createChat(w, { teamId, replicaId: r.id, text: '第一句\n第二行' }) }
}

describe('chats', () => {
  it('begin with the first message, on the model of their employee, and get a reply', () => {
    const { w, r, chat } = setup()
    expect(chat).toMatchObject({ replicaId: r.id, name: r.name, model: r.model })
    expect(chat.messages.map((m) => m.from)).toEqual(['user'])
    expect(chat.replyAt).toBeDefined()
    for (let i = 0; i < 60; i++) tick(w, 0.1)
    expect(w.chats[chat.id].replyAt).toBeUndefined()
    expect(w.chats[chat.id].messages.at(-1)?.from).toBe('agent')
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

  it('leave behind files no provider can take', () => {
    const file = (type: string, size: number) => ({ type, size }) as File
    expect(attachable([file('image/png', 10)], 6)).toMatchObject({ refused: false })
    expect(attachable([file('image/bmp', 10)], 6)).toMatchObject({ fit: [], refused: true })
    expect(attachable([file('image/png', 4 << 20)], 6)).toMatchObject({ fit: [], refused: true })
    expect(attachable([file('image/png', 1), file('image/png', 1)], 1).fit).toHaveLength(1)
  })

  it('write a task from what the user said, and go with their company', () => {
    const { w, teamId, chat } = setup()
    expect(chatTaskDraft(w, chat.id)).toEqual({ title: '第一句', description: '第一句\n第二行' })
    deleteTeam(w, teamId)
    expect(w.chats).toEqual({})
  })
})
