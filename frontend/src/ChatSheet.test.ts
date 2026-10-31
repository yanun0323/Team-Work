import { describe, expect, it } from 'vitest'
import { seedWorld } from './core/data/seed'
import { chatTaskDraft, createChat, deleteTeam, sayInChat, stopChat, tick } from './core/domain/sim'
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

  it('write a task from what the user said, and go with their company', () => {
    const { w, teamId, chat } = setup()
    expect(chatTaskDraft(w, chat.id)).toEqual({ title: '第一句', description: '第一句\n第二行' })
    deleteTeam(w, teamId)
    expect(w.chats).toEqual({})
  })
})
