import { describe, expect, it } from 'vitest'
import { seedWorld } from './core/data/seed'
import type { Chat, World } from './core/domain/types'
import { chatMindOf, chatSortAt, lastChatReplica, NOTE_COLORS, noteColors } from './crew'

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

describe('where a chat sits on the list', () => {
  const chat = (over: Partial<Chat>): Chat => ({ id: 'c', teamId: 't', replicaId: 'r', name: 'R', look: chatOn('high').chat.look, model: 'm', tokens: 0, messages: [], createdAt: 1, ...over })

  it('moves up only once a reply is done', () => {
    const messages: Chat['messages'] = [{ at: 5, from: 'user', text: 'hi' }, { at: 9, from: 'agent', text: 'working' }]
    expect(chatSortAt(chat({ messages, replyAt: 5 }))).toBe(5)
    expect(chatSortAt(chat({ messages, unread: true }))).toBe(9)
  })

  it('falls back to when it was made', () => {
    expect(chatSortAt(chat({ replyAt: 2 }))).toBe(1)
  })
})

describe('noteColors', () => {
  it('gives everyone in a chat their own colour, the same whatever the order', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f']
    const got = noteColors(ids)
    expect(new Set(Object.values(got)).size).toBe(6)
    expect(noteColors([...ids].reverse())).toEqual(got)
    expect(Object.values(got).every((c) => NOTE_COLORS.includes(c))).toBe(true)
  })
})
