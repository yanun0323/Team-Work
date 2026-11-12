import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./mode', () => ({ MOCK: false }))

import { emptyWorld } from './backend'
import { useIsland } from './island'
import { useStore } from './store'
import { goHome, goTo, isBlocked, leftPeer, presencePlace, reportPresence, visitorsAt, watchIsland, watchVisitors, useVisitors, type Peer } from './towers'
import { readChat, seeSource } from './ops'
import { DEFAULT_PREFS, usePrefs } from '../prefs'
import { setFailureHandler } from './ops'
import { updateTutorial, learn } from '../tutorial'

const peer = (p: Partial<Peer> = {}): Peer => ({ id: 'b', name: 'Studio', status: 'online', allowInbound: false, pairedAt: 1, access: 'view', ...p })
const answer = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }))
const turn = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  useIsland.setState({ island: null, notice: '' })
  useStore.setState({ world: { ...emptyWorld(), language: 'ja' }, loaded: true, arriving: false, offline: false, failure: '' })
  usePrefs.setState(DEFAULT_PREFS)
})
afterEach(() => {
  vi.unstubAllGlobals()
  useIsland.setState({ island: null, notice: '' })
})

describe('going to another island', () => {
  it('checks the computer first, then empties the world for its own, keeping the language', async () => {
    const f = answer(200, peer())
    vi.stubGlobal('fetch', f)
    useStore.setState((s) => { s.world.teams.t1 = { id: 't1' } as never })
    await expect(goTo('b')).resolves.toEqual({ ok: true })
    expect((f.mock.calls as unknown as Array<[string]>)[0][0]).toBe('/api/v1/towers/peers/b/check')
    expect(useIsland.getState().island).toEqual({ id: 'b', name: 'Studio' })
    const s = useStore.getState()
    expect(s.arriving).toBe(true)
    expect(s.world.teams).toEqual({})
    expect(s.world.language).toBe('ja')
  })

  it('stays where it is and says why when the computer cannot be worked, including which one to update', async () => {
    vi.stubGlobal('fetch', answer(200, peer({ status: 'incompatible', message: 'Studio 的 Team Work 太舊，請更新那台' })))
    await expect(goTo('b')).resolves.toEqual({ ok: false, message: 'Studio 的 Team Work 太舊，請更新那台' })
    expect(useIsland.getState().island).toBeNull()
    expect(useStore.getState().arriving).toBe(false)
    vi.stubGlobal('fetch', answer(404, { error: { code: 'not_found', message: '找不到這台電腦' } }))
    await expect(goTo('b')).resolves.toEqual({ ok: false, message: '找不到這台電腦' })
    expect(useIsland.getState().island).toBeNull()
  })

  it('comes back home, saying why when it was not asked to, and after unpairing the computer shown', () => {
    useIsland.setState({ island: { id: 'b', name: 'Studio' } })
    goHome('對方沒有允許')
    expect(useIsland.getState()).toMatchObject({ island: null, notice: '對方沒有允許' })
    expect(useStore.getState().arriving).toBe(true)
    useIsland.setState({ island: { id: 'b', name: 'Studio' } })
    leftPeer('c')
    expect(useIsland.getState().island).not.toBeNull()
    leftPeer('b')
    expect(useIsland.getState().island).toBeNull()
  })

  it('goes home when the other island turns a request down for good, or a check after a lost connection finds it denied', async () => {
    vi.stubGlobal('window', { setInterval, clearInterval, setTimeout, clearTimeout })
    const stop = watchIsland(60_000)
    useIsland.setState({ island: { id: 'b', name: 'Studio' } })
    vi.stubGlobal('fetch', answer(403, { error: { code: 'peer_unpaired', message: 'Studio 已解除配對' } }))
    const { request } = await import('./backend')
    await expect(request('GET', '/teams')).rejects.toThrow()
    expect(useIsland.getState()).toMatchObject({ island: null, notice: 'Studio 已解除配對' })

    useIsland.setState({ island: { id: 'b', name: 'Studio' }, notice: '' })
    const f = answer(200, peer({ status: 'denied', message: 'Studio 沒有允許這台操作它' }))
    vi.stubGlobal('fetch', f)
    useStore.getState().setOffline()
    await turn()
    await turn()
    expect((f.mock.calls as unknown as Array<[string]>)[0][0]).toBe('/api/v1/towers/peers/b/check')
    expect(useIsland.getState()).toMatchObject({ island: null, notice: 'Studio 沒有允許這台操作它' })

    // only offline: it keeps trying, and stays
    useIsland.setState({ island: { id: 'b', name: 'Studio' }, notice: '' })
    useStore.setState({ offline: false })
    vi.stubGlobal('fetch', answer(200, peer({ status: 'offline' })))
    useStore.getState().setOffline()
    await turn()
    await turn()
    expect(useIsland.getState().island).not.toBeNull()
    stop()
  })
})

it('reads a tower with no list of computers as an empty one', async () => {
  const { readTowers } = await import('./towers')
  vi.stubGlobal('fetch', answer(200, { me: { id: 'a', name: 'MacBook', protocol: 1 }, pairing: null, outgoing: null, peers: null }))
  await expect(readTowers()).resolves.toMatchObject({ peers: [] })
})

describe("another island's world", () => {
  it("takes its work settings, but keeps this computer's interface and language", () => {
    usePrefs.setState({ shadows: false, musicVolume: 10, terminalCommand: 'here' })
    useIsland.setState({ island: { id: 'b', name: 'Studio' } })
    const w = { ...emptyWorld(), language: 'ko' as const }
    w.preferences = { ...DEFAULT_PREFS, shadows: true, musicVolume: 90, terminalCommand: 'there', hiddenBlueprints: ['x'] }
    useStore.getState().receive({ type: 'snapshot', world: w })
    const p = usePrefs.getState()
    expect([p.shadows, p.musicVolume]).toEqual([false, 10])
    expect([p.terminalCommand, p.hiddenBlueprints]).toEqual(['there', ['x']])
    expect(useStore.getState().world.language).toBe('ja')
    expect(useStore.getState().arriving).toBe(false)
    useStore.getState().receive({ type: 'language', language: 'ko' })
    expect(useStore.getState().world.language).toBe('ja')
    useStore.getState().receive({ type: 'patch', upserts: [{ kind: 'preferences', id: 'world', data: { ...w.preferences, shadows: true, compact1M: 55 } }] })
    expect(usePrefs.getState().shadows).toBe(false)
    expect(usePrefs.getState().compact1M).toBe(55)
  })

  it("sends its work settings there, and the interface's here, showing those at once", async () => {
    setFailureHandler(() => {})
    const f = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', f)
    useIsland.setState({ island: { id: 'b', name: 'Studio' } })
    usePrefs.getState().set({ shadows: false, terminalCommand: 'ls' })
    await turn()
    const calls = f.mock.calls as unknown as Array<[string, RequestInit]>
    expect(calls.map(([url, init]) => [url, init.body])).toEqual([
      ['/api/v1/remote/b/settings/preferences', '{"terminalCommand":"ls"}'],
      ['/api/v1/settings/preferences', '{"shadows":false}'],
    ])
    expect(usePrefs.getState().shadows).toBe(false)
  })

  it("leaves this computer's tutorial alone, and sends it home when changed by hand", async () => {
    setFailureHandler(() => {})
    const f = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', f)
    useIsland.setState({ island: { id: 'b', name: 'Studio' } })
    learn('help')
    await turn()
    expect(f).not.toHaveBeenCalled()
    updateTutorial({ hidden: true })
    await turn()
    expect((f.mock.calls as unknown as Array<[string]>)[0][0]).toBe('/api/v1/tutorial')
  })
})

describe('visiting another island', () => {
  beforeEach(() => { vi.stubGlobal('window', { setInterval, clearInterval, setTimeout, clearTimeout, addEventListener: () => {}, removeEventListener: () => {} }) })
  const calls = (f: ReturnType<typeof vi.fn>) => (f.mock.calls as unknown as Array<[string, RequestInit]>).map(([url, init]) => [url, init.body ? JSON.parse(init.body as string) : undefined])

  it('leaves its unread marks alone, while this island still clears them', async () => {
    setFailureHandler(() => {})
    const f = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', f)
    useIsland.setState({ island: { id: 'b', name: 'Studio' } })
    readChat(useStore.getState().world, 'c1')
    seeSource(useStore.getState().world, 's1')
    await turn()
    expect(f).not.toHaveBeenCalled()
    useIsland.setState({ island: null })
    readChat(useStore.getState().world, 'c1')
    seeSource(useStore.getState().world, 's1')
    await turn()
    expect(calls(f).map(([url]) => url)).toEqual(['/api/v1/chats/c1/read', '/api/v1/sources/s1/seen'])
  })

  it('tells the island what this page has open, again after a change, and that it has gone on leaving', async () => {
    const f = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', f)
    let place = presencePlace('t1', false)
    const presence = reportPresence(() => place, 60_000)
    await turn()
    expect(f).not.toHaveBeenCalled() // nothing to tell on this computer's own island
    useIsland.setState({ island: { id: 'b', name: 'Studio' } })
    await turn()
    place = presencePlace(null, true)
    presence.tell()
    useIsland.setState({ island: null })
    await turn()
    presence.stop()
    const sent = calls(f)
    expect(sent.map(([url]) => url)).toEqual(['/api/v1/remote/b/presence', '/api/v1/remote/b/presence', '/api/v1/remote/b/presence'])
    const page = (sent[0][1] as { page: string }).page
    expect(page).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
    expect(sent.map(([, body]) => body)).toEqual([{ page, place: 'team:t1' }, { page, place: 'airport' }, { page, gone: true }])
  })

  it('goes home saying why when the island sends it away', async () => {
    const stop = watchIsland(60_000)
    useIsland.setState({ island: { id: 'b', name: 'Studio' } })
    vi.stubGlobal('fetch', answer(403, { error: { code: 'peer_kicked', message: '對方已請這台離開，請稍後再前往' } }))
    reportPresence(() => '', 60_000).stop()
    await turn()
    await turn()
    stop()
    expect(useIsland.getState().notice).toBe('對方已請這台離開，請稍後再前往')
  })
})

describe('visitors on this island', () => {
  beforeEach(() => { vi.stubGlobal('window', { setInterval, clearInterval, setTimeout, clearTimeout, addEventListener: () => {}, removeEventListener: () => {} }) })
  it('lists who has each place open, read from the tower while at home', async () => {
    vi.stubGlobal('fetch', answer(200, { me: { id: 'a', name: 'A', protocol: 1 }, pairing: null, outgoing: null, peers: [], visitors: [{ id: 'b', name: 'Studio', places: ['airport', 'team:t1'] }] }))
    const stop = watchVisitors(60_000)
    await turn()
    await turn()
    stop()
    const v = useVisitors.getState().visitors
    expect(visitorsAt(v, 'team:t1')).toEqual(['Studio'])
    expect(visitorsAt(v, 'team:t2')).toEqual([])
  })

  it('tells a block until lifted from one that has run out', () => {
    expect(isBlocked({ blockedUntil: -1 })).toBe(true)
    expect(isBlocked({ blockedUntil: 200 }, 100)).toBe(true)
    expect(isBlocked({ blockedUntil: 200 }, 300)).toBe(false)
    expect(isBlocked({})).toBe(false)
  })
})
