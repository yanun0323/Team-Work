import { describe, expect, it } from 'vitest'
import { seedWorld } from './core/data/seed'
import type { Chat, ModelProvider, World } from './core/domain/types'
import { blueprintLabel, byBlueprint, chatMindOf, chatOrder, chatSortAt, chatWindow, contextWindowOf, lastChatReplica, namedNotes, noteColors, providerHue, providerWindow } from './crew'

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

  it('puts a copy made later above, though its messages are older', () => {
    expect(chatSortAt(chat({ messages: [{ at: 5, from: 'user', text: 'hi' }], createdAt: 20 }))).toBe(20)
  })

  it('puts the pinned on top, the latest pinned first, whatever moved since', () => {
    const fresh = chat({ id: 'fresh', createdAt: 50 })
    const old = chat({ id: 'old', createdAt: 1, pinnedAt: 10 })
    const older = chat({ id: 'older', createdAt: 0, pinnedAt: 20 })
    const stale = chat({ id: 'stale', createdAt: 5 })
    expect([stale, fresh, old, older].sort(chatOrder).map((c) => c.id)).toEqual(['older', 'old', 'fresh', 'stale'])
  })
})

describe('noteColors', () => {
  const provider = (id: string, kind: ModelProvider['kind'], models: string[]): ModelProvider =>
    ({ id, name: id, kind, baseUrl: '', auth: { kind: 'apiKey', keyHint: 'x' }, models })
  const world = (...list: ModelProvider[]) => {
    const w = seedWorld()
    w.providers = Object.fromEntries(list.map((p) => [p.id, p]))
    return w
  }
  const w = world(
    provider('claude', 'anthropic', ['opus']), provider('claude-key', 'anthropic', ['sonnet']),
    provider('codex', 'openai', ['gpt']), provider('gemini', 'google', ['pro']),
    provider('zeta', 'compatible', ['z1']), provider('alpha', 'compatible', ['a1']), provider('mid', 'compatible', ['m1']),
    provider('omega', 'compatible', ['o1']),
  )
  const hueOf = (color: string) => Number(color.match(/^oklch\(\S+ \S+ (\S+)\)$/)![1])

  it('gives the same note to a group\'s employee in any company, alone in a chat', () => {
    // employees of different companies, on two Anthropic providers
    expect(noteColors(w, [{ id: 'r-1', model: 'opus' }])).toEqual({ 'r-1': 'oklch(0.92 0.06 55)' })
    expect(noteColors(w, [{ id: 'r-9', model: 'sonnet' }])['r-9']).toBe('oklch(0.92 0.06 55)')
    // a compatible provider is its own group, placed by id among them all, round again past three
    expect(noteColors(w, [{ id: 'a', model: 'a1' }, { id: 'b', model: 'm1' }, { id: 'c', model: 'o1' }, { id: 'd', model: 'z1' }]))
      .toEqual({ a: 'oklch(0.92 0.06 95)', b: 'oklch(0.92 0.06 345)', c: 'oklch(0.92 0.06 305)', d: 'oklch(0.92 0.06 95)' })
    expect(providerHue(w.providers, 'mid')).toEqual({ group: 'compatible:mid', hue: 345 })
  })

  it('keeps every group on its own stretch of hue, clear of the user\'s green', () => {
    const groups = [['opus', 'sonnet'], ['gpt'], ['pro'], ['a1'], ['m1'], ['o1']]
    const stretches = groups.map((models) => noteColors(w, ['x', 'y', 'z'].map((id, i) => ({ id, model: models[i % models.length] }))))
      .map((c) => Object.values(c).map(hueOf))
    for (const hues of stretches) {
      expect(Math.max(...hues) - Math.min(...hues)).toBeLessThanOrEqual(24)
      // the user's notes, --note-talk, sit near 130
      expect(hues.every((h) => h < 110 || h > 170)).toBe(true)
    }
    const centres = stretches.map((h) => h[0]).sort((a, b) => a - b)
    centres.slice(1).forEach((h, i) => expect(h - centres[i]).toBeGreaterThan(24))
  })

  it('tells apart up to three of a group by their ids, whatever the order they came in', () => {
    const people = [{ id: 'c', model: 'opus' }, { id: 'a', model: 'sonnet' }, { id: 'b', model: 'opus' }]
    const got = noteColors(w, people)
    expect(got).toEqual({ a: 'oklch(0.92 0.06 55)', b: 'oklch(0.87 0.07 67)', c: 'oklch(0.95 0.05 43)' })
    expect(noteColors(w, [...people].reverse())).toEqual(got)
    expect(namedNotes(w, people).size).toBe(0)
  })

  it('names everyone in a group of four or more on their notes, and only them', () => {
    const people = ['a', 'b', 'c', 'd'].map((id) => ({ id, model: 'opus' }))
    const other = { id: 'e', model: 'gpt' }
    expect(noteColors(w, people).d).toBe(noteColors(w, people).a)
    expect([...namedNotes(w, [...people, other])].sort()).toEqual(['a', 'b', 'c', 'd'])
  })

  it('puts a model no provider offers on the white note', () => {
    expect(noteColors(w, [{ id: 'a', model: 'gone' }, { id: 'b', model: 'opus' }]))
      .toEqual({ a: 'var(--note-fixed)', b: 'oklch(0.92 0.06 55)' })
  })

  it('keeps the dark ink readable on every note', () => {
    const linear = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
    // OKLCH to linear sRGB, clipped to the screen's gamut
    const rgb = (l: number, c: number, h: number) => {
      const a = c * Math.cos((h * Math.PI) / 180)
      const b = c * Math.sin((h * Math.PI) / 180)
      const L = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
      const M = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
      const S = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
      return [4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S, -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
        -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S].map((v) => Math.min(1, Math.max(0, v)))
    }
    const luminance = ([r, g, b]: number[]) => 0.2126 * r + 0.7152 * g + 0.0722 * b
    const ink = luminance(linear('#1f1d2b'))
    const notes = ['opus', 'gpt', 'pro', 'a1', 'm1', 'o1'].flatMap((model) => Object.values(noteColors(w, ['x', 'y', 'z'].map((id) => ({ id, model })))))
    expect(notes).toHaveLength(18)
    for (const note of notes) {
      const [l, c, h] = note.slice(6, -1).split(' ').map(Number)
      expect((luminance(rgb(l, c, h)) + 0.05) / (ink + 0.05)).toBeGreaterThanOrEqual(4.5)
    }
  })
})

describe('byBlueprint', () => {
  it('puts those with settings of their own first, under no blueprint, and keeps their settings off the list', () => {
    const w = seedWorld()
    const [a, b] = Object.values(w.replicas)
    const bp = w.blueprints[a.blueprintId]
    w.blueprints.own = { ...bp, id: 'own', name: b.name, owner: b.id }
    b.blueprintId = 'own'
    const groups = byBlueprint(w, [a, b])
    expect(groups[0]).toEqual({ bp: null, list: [b] })
    expect(groups.some((g) => g.bp?.id === 'own')).toBe(false)
    expect(blueprintLabel(w, b)).toBe('自訂')
    expect(blueprintLabel(w, a)).toBe(bp.name)
  })

  it('keeps those whose blueprint is gone, first, so another can be picked', () => {
    const w = seedWorld()
    const [a, b, c] = Object.values(w.replicas)
    w.blueprints.own = { ...w.blueprints[a.blueprintId], id: 'own', owner: b.id }
    b.blueprintId = 'own'
    c.blueprintId = 'preset-assistant'
    const groups = byBlueprint(w, [a, b, c])
    expect(groups[0]).toEqual({ bp: null, gone: true, list: [c] })
    expect(groups[1]).toEqual({ bp: null, list: [b] })
    expect(groups.flatMap((g) => g.list)).toHaveLength(3)
    expect(blueprintLabel(w, c)).toBe('藍圖已不存在')
  })
})

describe('how much a chat can read', () => {
  it('is fixed for Anthropic and OpenAI, and set or guessed for the rest', () => {
    expect(providerWindow({ kind: 'anthropic', contextWindow: 50_000 })).toBe(1_000_000)
    expect(providerWindow({ kind: 'openai' })).toBe(272_000)
    expect(providerWindow({ kind: 'google', contextWindow: 200_000 })).toBe(200_000)
    expect(providerWindow({ kind: 'compatible' })).toBe(128_000)
  })

  it('is the least anyone in a meeting can read', () => {
    const { w, chat } = chatOn('high')
    w.providers.big = { id: 'big', name: 'B', kind: 'anthropic', baseUrl: '', auth: { kind: 'apiKey', keyHint: 'x' }, models: ['claude'] }
    chat.model = 'claude'
    expect(chatWindow(w, chat)).toBe(1_000_000)
    chat.guests = [{ replicaId: 'g', name: 'G', look: chat.look, model: 'm' }]
    expect(chatWindow(w, chat)).toBe(272_000)
    expect(contextWindowOf(w, 'gone')).toBe(128_000)
  })
})
