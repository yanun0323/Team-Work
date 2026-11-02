import { describe, expect, it } from 'vitest'
import { seedWorld } from './core/data/seed'
import type { Chat, World } from './core/domain/types'
import { chatMindOf, lastChatReplica } from './crew'

function chatOn(effort: string): { w: World; chat: Chat } {
  const w = seedWorld()
  const r = Object.values(w.replicas)[0]
  w.providers = { p: { id: 'p', name: 'P', kind: 'openai', baseUrl: '', auth: { kind: 'apiKey', keyHint: 'x' }, models: ['m', 'n'], thinking: { m: ['low', 'high'] } } }
  r.model = 'm'
  r.effort = effort
  return { w, chat: { id: 'c', teamId: r.teamId, replicaId: r.id, name: r.name, look: r.look, model: 'm', tokens: 0, messages: [], createdAt: 0 } }
}

describe('what a chat runs on', () => {
  it('is its model at its employee\'s level', () => {
    const { w, chat } = chatOn('high')
    expect(chatMindOf(w, chat)).toBe('m · high')
  })

  it('falls back to the default once the employee has moved to another model', () => {
    const { w, chat } = chatOn('high')
    w.replicas[chat.replicaId].model = 'n'
    expect(chatMindOf(w, chat)).toBe('m · default')
  })

  it('falls back to the default when the model no longer takes the level', () => {
    const { w, chat } = chatOn('high')
    w.providers.p.thinking = { m: ['low'] }
    expect(chatMindOf(w, chat)).toBe('m · default')
  })

  it('is only the model once the employee has left', () => {
    const { w, chat } = chatOn('high')
    delete w.replicas[chat.replicaId]
    expect(chatMindOf(w, chat)).toBe('m')
  })
})

describe('lastChatReplica', () => {
  const chat = (id: string, teamId: string, replicaId: string, createdAt: number) => ({ id, teamId, replicaId, createdAt })
  const world = (chats: ReturnType<typeof chat>[], replicas = ['a', 'b']) => ({
    chats: Object.fromEntries(chats.map((c) => [c.id, c])),
    replicas: Object.fromEntries(replicas.map((id) => [id, { id }])),
  }) as unknown as World

  it('is who the latest chat of this company was with', () => {
    const w = world([chat('1', 't', 'a', 2), chat('2', 't', 'b', 1), chat('3', 'other', 'b', 9)])
    expect(lastChatReplica(w, 't')).toBe('a')
  })

  it('is nobody in a company without chats, or when they have left', () => {
    expect(lastChatReplica(world([]), 't')).toBeUndefined()
    expect(lastChatReplica(world([chat('1', 't', 'gone', 1)]), 't')).toBeUndefined()
  })
})
