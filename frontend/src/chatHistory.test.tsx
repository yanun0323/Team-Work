import { act, createRoot } from '@react-three/fiber'
import type { WebGLRenderer } from 'three'
import { afterEach, expect, it, vi } from 'vitest'
import { useChatHistory } from './chatHistory'
import type { Chat } from './core/domain/types'
import { useStore } from './core/store'
import { AIRPORT_STAFF_LOOK, roundActor } from './core/domain/sim'
import { chatPreview, chatSortAt } from './crew'
import { noticeOf } from './notices'
import { DEFAULT_PREFS } from './prefs'
import { emptyWorld } from './core/backend'

const roots: ReturnType<typeof createRoot>[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => { root.unmount() })
  vi.unstubAllGlobals()
})
const summary = (count = 250, version = 'a', previous?: string, changedFrom = 0): Chat => ({
  id: 'c', teamId: '', replicaId: '', name: '', look: AIRPORT_STAFF_LOOK, model: 'm', tokens: 0, createdAt: 0, messages: [],
  history: { count, version, previous, changedFrom, preview: 'first', sortAt: 0 },
})
async function harness() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const canvas = {} as HTMLCanvasElement
  const gl = { render: vi.fn(), setSize: vi.fn(), setPixelRatio: vi.fn(), domElement: canvas } as unknown as WebGLRenderer
  const root = createRoot(canvas)
  roots.push(root)
  await root.configure({ gl, frameloop: 'never', size: { width: 1, height: 1, top: 0, left: 0 } })
  let result!: ReturnType<typeof useChatHistory>
  function View({ c }: { c?: Chat }) { result = useChatHistory(c); return null }
  return { get: () => result, render: async (c?: Chat) => { await act(async () => { root.render(<View c={c} />) }) }, root }
}
const page = (url: string, total = 250) => {
  const u = new URL(url, 'http://test')
  const before = Number(u.searchParams.get('before'))
  const start = Math.max(0, before - Number(u.searchParams.get('limit')))
  return { version: u.searchParams.get('version'), start, total,
    messages: Array.from({ length: before - start }, (_, i) => ({ at: start + i, from: 'user', text: String(start + i) })), handoffs: [], joins: [] }
}

it('loads 100 on open, prepends pages, fetches only appended messages, and drops history on close', async () => {
  const fetch = vi.fn(async (url: string) => new Response(JSON.stringify(page(url, url.includes('version=b') ? 251 : 250))))
  vi.stubGlobal('fetch', fetch)
  const h = await harness()
  const c = summary()
  await h.render(c)
  expect(h.get().start).toBe(150)
  expect(h.get().chat?.messages).toHaveLength(100)
  expect(c.messages).toHaveLength(0)
  await act(async () => { await h.get().more() })
  expect(h.get().start).toBe(50)
  expect(h.get().chat?.messages).toHaveLength(200)
  await h.render(summary(251, 'b', 'a', 250))
  expect(fetch.mock.calls.at(-1)![0]).toContain('limit=1')
  expect(h.get().start).toBe(50)
  expect(h.get().chat?.messages).toHaveLength(201)
  await h.render(undefined)
  expect(h.get().chat).toBeUndefined()
  await h.render(c)
  expect(h.get().chat?.messages).toHaveLength(100)
})

it('does not refetch title/unread changes and reloads a skipped or truncated version', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(page(url)))))
  const h = await harness()
  await h.render(summary())
  await h.render({ ...summary(), title: 'renamed', unread: true })
  expect(fetch).toHaveBeenCalledTimes(1)
  await h.render(summary(3, 'c', 'b', 1))
  expect(h.get().start).toBe(0)
  expect(h.get().chat?.messages).toHaveLength(3)
})

it('cancels stale requests and can retry a failed earlier page without losing loaded messages', async () => {
  const h = await harness()
  let fail = false
  let finish!: () => void
  let signal!: AbortSignal
  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
    if (url.includes('version=slow')) {
      signal = options.signal!
      await new Promise<void>((resolve) => { finish = resolve })
    }
    if (fail) return new Response(JSON.stringify({ error: { code: 'unavailable', message: 'try again' } }), { status: 503 })
    return new Response(JSON.stringify(page(url)))
  }))
  await h.render(summary(250, 'slow'))
  await h.render(summary(10, 'new'))
  expect(signal.aborted).toBe(true)
  await act(async () => { finish() })
  expect(h.get().chat?.messages).toHaveLength(10)
  await h.render(summary())
  fail = true
  await act(async () => { await h.get().more() })
  expect(h.get().error).toBe('try again')
  expect(h.get().chat?.messages).toHaveLength(100)
  fail = false
  await act(async () => { h.get().retry() })
  expect(h.get().error).toBe('')
  expect(h.get().chat?.messages).toHaveLength(200)
})

it('reloads after a reconnect and rejects malformed or out-of-version pages', async () => {
  const h = await harness()
  const fetch = vi.fn(async (url: string) => new Response(JSON.stringify(page(url))))
  vi.stubGlobal('fetch', fetch)
  await h.render(summary())
  await act(async () => { await h.get().more() })
  expect(h.get().chat?.messages).toHaveLength(200)
  await act(async () => { useStore.setState((s) => ({ snapshot: s.snapshot + 1 })) })
  expect(h.get().chat?.messages).toHaveLength(100)
  fetch.mockImplementation(async () => new Response(JSON.stringify({ version: 'wrong', start: 0, total: 250, messages: [] })))
  await act(async () => { await h.get().more() })
  expect(h.get().error).not.toBe('')
  expect(h.get().chat?.messages).toHaveLength(100)
})

it('keeps list previews, notifications and the meeting actor without message bodies', () => {
  const c = summary()
  c.teamId = 't'
  c.replicaId = 'chair'
  c.history = { ...c.history!, preview: 'first question', sortAt: 123,
    lastAgent: { from: 'agent', text: 'latest reply', at: 120, by: 'guest' }, mentions: ['guest'] }
  expect(chatPreview(c)).toBe('first question')
  expect(chatSortAt(c)).toBe(123)
  expect(roundActor(c)).toBe('guest')
  const w = emptyWorld()
  w.chats.c = c
  expect(noticeOf(w, { kind: 'chat', id: 'c' }, DEFAULT_PREFS)?.body).toBe('latest reply')
  expect(c.messages).toHaveLength(0)
})

it('aborts an older-page request on unmount even after a metadata-only update', async () => {
  const h = await harness()
  let signal!: AbortSignal
  let finish!: () => void
  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
    if (url.includes('before=150')) {
      signal = options.signal!
      await new Promise<void>((resolve) => { finish = resolve })
    }
    return new Response(JSON.stringify(page(url)))
  }))
  await h.render(summary())
  await h.render({ ...summary(), title: 'new name' })
  let pending!: Promise<boolean>
  await act(async () => { pending = h.get().more() })
  await act(async () => { h.root.render(<></>) })
  expect(signal.aborted).toBe(true)
  await act(async () => { finish(); expect(await pending).toBe(false) })
})

it('keeps what is shown while replies come faster than they are read, then reads only what was added', async () => {
  const h = await harness()
  const urls: string[] = []
  let hold = false
  let finish!: () => void
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    urls.push(url)
    if (hold) await new Promise<void>((resolve) => { finish = resolve })
    return new Response(JSON.stringify(page(url, 300)))
  }))
  await h.render(summary())
  // a tool line comes in, and another before the first is read
  hold = true
  await h.render(summary(251, 'b', 'a', 250))
  expect(h.get().chat?.messages).toHaveLength(100)
  await h.render(summary(252, 'c', 'b', 251))
  expect(h.get().chat?.messages).toHaveLength(100)
  expect(urls.at(-1)).toContain('before=252&limit=2')
  hold = false
  await act(async () => { finish() })
  expect(h.get().start).toBe(150)
  expect(h.get().chat?.messages).toHaveLength(102)
  expect(h.get().chat?.messages.at(-1)?.text).toBe('251')
  // a message above changed in place, such as a task made under it: only it and those after are read
  await h.render(summary(252, 'd', 'c', 200))
  expect(urls.at(-1)).toContain('before=252&limit=52')
  expect(h.get().start).toBe(150)
  expect(h.get().chat?.messages).toHaveLength(102)
  // a reconnect reads it all again, showing what was there until then
  hold = true
  await act(async () => { useStore.setState((s) => ({ snapshot: s.snapshot + 1 })) })
  expect(h.get().chat?.messages).toHaveLength(102)
  expect(h.get().ready).toBe(false)
  await act(async () => { finish() })
  expect(h.get().ready).toBe(true)
  expect(h.get().chat?.messages).toHaveLength(100)
})

it('discards an earlier page overtaken by an appended reply', async () => {
  const h = await harness()
  let finish!: () => void
  let signal!: AbortSignal
  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
    if (url.includes('before=150')) {
      signal = options.signal!
      await new Promise<void>((resolve) => { finish = resolve })
    }
    return new Response(JSON.stringify(page(url, url.includes('version=b') ? 251 : 250)))
  }))
  await h.render(summary())
  let pending!: Promise<boolean>
  await act(async () => { pending = h.get().more() })
  await h.render(summary(251, 'b', 'a', 250))
  expect(signal.aborted).toBe(true)
  await act(async () => { finish(); expect(await pending).toBe(false) })
  expect(h.get().start).toBe(150)
  expect(h.get().chat?.messages).toHaveLength(101)
  expect(h.get().chat?.messages.at(-1)?.text).toBe('250')
})
