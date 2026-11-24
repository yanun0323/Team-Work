import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./mode', () => ({ MOCK: false }))

import { emptyWorld, request } from './backend'
import type { Ghost, World } from './domain/types'
import { ghostState, ghostWaiting, openGhost, seedFeed, useFeeds, watchGhosts } from './ghosts'
import { apiBase, islandScope, mapBase, mapScope, useIsland } from './island'
import { homeWorld, useStore } from './store'
import { closeGhost, usePeers, watchIsland, type Peer } from './towers'
import { readChat } from './ops'
import { useSeen } from './seen'
import { canPlace, layoutTown } from '../layout'

const peer = (p: Partial<Peer> = {}): Peer => ({ id: 'b', name: 'Studio', status: 'online', allowInbound: false, pairedAt: 1, access: 'view', ...p })
const ghost: Ghost = { id: 'ghost-1', peerId: 'b', teamId: 'team-9', name: 'Acme', plot: { at: [20, -8], style: 'castle', seed: 3 }, createdAt: 5 }
const team = (id: string, name: string) => ({ id, name, createdAt: 1, plot: { at: [-8, -8], style: 'villa', seed: 1 } }) as never
/** The friend's island: the ghost's company, and one with the same id as a company here. */
const there = (): World => ({ ...emptyWorld(), teams: { 'team-9': team('team-9', 'Acme'), t1: team('t1', 'Theirs') } })
const turn = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  useIsland.setState({ island: null, notice: '' })
  useStore.setState({ world: { ...emptyWorld(), teams: { t1: team('t1', 'Mine') }, ghosts: { [ghost.id]: ghost } }, home: null, loaded: true, arriving: false, offline: false, failure: '' })
  usePeers.setState({ peers: [peer()] })
  useFeeds.setState({}, true)
  useSeen.setState({}, true)
})
afterEach(() => {
  vi.unstubAllGlobals()
  closeGhost()
  useIsland.setState({ island: null, notice: '' })
})

describe('how a ghost company stands', () => {
  it('goes by its computer: reached, only looked at, out of reach, shut out, unpaired, or the company closed', () => {
    const open = { world: there(), open: true }
    expect(ghostState(ghost, [peer()], open)).toBe('online')
    expect(ghostState(ghost, [peer({ granted: 'operate' })], open)).toBe('online')
    expect(ghostState(ghost, [peer({ granted: 'view' })], open)).toBe('view')
    expect(ghostState(ghost, [peer({ status: 'offline' })], { world: there(), open: false })).toBe('offline')
    expect(ghostState(ghost, [peer()], undefined)).toBe('offline')
    for (const status of ['denied', 'unpaired', 'incompatible'] as const) expect(ghostState(ghost, [peer({ status })], open)).toBe('lost')
    expect(ghostState(ghost, [], open)).toBe('lost')
    expect(ghostState(ghost, [peer()], { world: { ...emptyWorld() }, open: true })).toBe('gone')
    // before the tower is first read, the follow alone says
    expect(ghostState(ghost, null, open)).toBe('online')
  })

  it('stands on land of its own: no company can be put on it, and it keeps where it was put', () => {
    const town = layoutTown([
      { id: 't1', name: 'Mine', members: 1, at: [-8, -8], style: 'villa', seed: 1 },
      { id: ghost.id, name: 'Acme', members: 2, at: ghost.plot.at, style: 'castle', seed: 3, ghost: { peerId: 'b', teamId: 'team-9' } },
    ])
    expect(town.lots[1]).toMatchObject({ id: 'ghost-1', at: [20, -8], style: 'castle', ghost: { peerId: 'b', teamId: 'team-9' } })
    expect(town.lots[0].ghost).toBeUndefined()
    expect(canPlace(town, [20, -8])).toBe(false)
  })
})

describe('a ghost company open', () => {
  it("works on its computer, while the map keeps this island's world, up to date, and its own requests", async () => {
    seedFeed('b', there())
    openGhost(ghost)
    expect(useIsland.getState().island).toEqual({ id: 'b', name: 'Studio', ghost: { id: 'ghost-1', teamId: 'team-9' } })
    let s = useStore.getState()
    // its drawer reads the other computer at once, from what the follow had
    expect(s.arriving).toBe(false)
    expect(s.world.teams.t1.name).toBe('Theirs')
    expect(homeWorld(s).teams.t1.name).toBe('Mine')
    expect(apiBase()).toBe('/api/v1/remote/b')
    expect(islandScope('k')).toBe('b\u0000k')
    expect(mapBase()).toBe('/api/v1')
    expect(mapScope('k')).toBe('k')

    // this island's changes reach the map; the other computer's, the drawer
    s.receiveHome({ type: 'patch', upserts: [{ kind: 'team', id: 't2', data: team('t2', 'New here') }] })
    s.receive({ type: 'patch', upserts: [{ kind: 'team', id: 't3', data: team('t3', 'New there') }] })
    s = useStore.getState()
    expect(Object.keys(homeWorld(s).teams).sort()).toEqual(['t1', 't2'])
    expect(Object.keys(s.world.teams).sort()).toEqual(['t1', 't3', 'team-9'])
    // the follow goes on changing its own copy, frozen in the store or not
    useFeeds.getState().b.world!.teams['team-9'] = team('team-9', 'Renamed')
    expect(useStore.getState().world.teams['team-9'].name).toBe('Acme')

    closeGhost()
    s = useStore.getState()
    expect(useIsland.getState().island).toBeNull()
    expect(s.home).toBeNull()
    expect(Object.keys(s.world.teams).sort()).toEqual(['t1', 't2'])
    expect(s.world.teams.t1.name).toBe('Mine')
    expect(apiBase()).toBe('/api/v1')
  })

  it('waits for its computer when nothing of it has come yet', () => {
    openGhost(ghost)
    expect(useStore.getState().arriving).toBe(true)
    expect(useStore.getState().world.teams).toEqual({})
    expect(homeWorld(useStore.getState()).teams.t1.name).toBe('Mine')
  })

  it("closes, saying why, when its computer turns a request down for good; the map doesn't fly anywhere", async () => {
    vi.stubGlobal('window', { setInterval, clearInterval, setTimeout, clearTimeout })
    const stop = watchIsland(60_000)
    seedFeed('b', there())
    openGhost(ghost)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'peer_denied', message: 'Studio 沒有對你開放小島' } }), { status: 403 })))
    await expect(request('GET', '/teams/team-9/notes')).rejects.toThrow()
    expect(useIsland.getState()).toMatchObject({ island: null, notice: 'Studio 沒有對你開放小島' })
    const s = useStore.getState()
    expect(s.arriving).toBe(false)
    expect(s.world.teams.t1.name).toBe('Mine')
    stop()
  })
})

it('counts what waits for the user in the ghost companies, for the Dock badge', () => {
  const w = there()
  w.chats.c1 = { id: 'c1', teamId: 'team-9', unread: true, messages: [] } as never
  w.chats.c2 = { id: 'c2', teamId: 't1', unread: true, messages: [] } as never
  expect(ghostWaiting(useStore.getState().world, { b: { world: w, open: true } })).toBe(1)
  expect(ghostWaiting(useStore.getState().world, {})).toBe(0)
})

describe('reading a ghost company\'s chat', () => {
  const unread = (count: number) => ({ id: 'c1', teamId: 'team-9', unread: true, messages: [], history: { count } }) as never
  const posts = (f: ReturnType<typeof vi.fn>) => (f.mock.calls as unknown as Array<[string, RequestInit]>).filter(([, init]) => init.method === 'POST').map(([url]) => url)

  it('keeps it read here, says so to its computer as this user\'s own, and counts it again once something new comes', async () => {
    const f = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', f)
    vi.stubGlobal('WebSocket', class { close() {} })
    vi.stubGlobal('location', { protocol: 'http:', host: 'app' })
    vi.stubGlobal('window', { setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {} })
    const w = there()
    w.chats.c1 = unread(2)
    seedFeed('b', w)
    expect(ghostWaiting(homeWorld(useStore.getState()), useFeeds.getState())).toBe(1)
    openGhost(ghost)
    const stop = watchGhosts()

    useStore.getState().act((x) => readChat(x, 'c1'))
    await turn()
    expect(useStore.getState().world.chats.c1.unread).toBe(false)
    // the name tag and the Dock badge, from the follow, stop counting it at once
    expect(useFeeds.getState().b.world?.chats.c1.unread).toBe(false)
    expect(ghostWaiting(homeWorld(useStore.getState()), useFeeds.getState())).toBe(0)
    // the computer there clears its own mark only if it lets this one operate
    expect(posts(f)).toEqual(['/api/v1/remote/b/chats/c1/read?mine=1'])

    // its computer still says unread: read here, it stays read
    useStore.getState().receive({ type: 'patch', upserts: [{ kind: 'chat', id: 'c1', data: unread(2) }] })
    expect(useStore.getState().world.chats.c1.unread).toBe(false)
    // a new message counts again
    useStore.getState().receive({ type: 'patch', upserts: [{ kind: 'chat', id: 'c1', data: unread(3) }] })
    expect(useStore.getState().world.chats.c1.unread).toBe(true)
    stop()
  })

  it('leaves a visited island\'s marks alone', () => {
    const f = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', f)
    vi.stubGlobal('window', { setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {} })
    useIsland.setState({ island: { id: 'b', name: 'Studio' } })
    useStore.setState((s) => { s.world.chats.c1 = unread(1) })
    useStore.getState().act((x) => readChat(x, 'c1'))
    expect(posts(f)).toEqual([])
    expect(useSeen.getState()).toEqual({})
    expect(useStore.getState().world.chats.c1.unread).toBe(true)
  })
})

describe('following the computers with ghost companies', () => {
  class FakeSocket {
    static all: FakeSocket[] = []
    onopen?: () => void
    onmessage?: (m: { data: string }) => void
    onclose?: () => void
    closed = false
    constructor(readonly url: string) { FakeSocket.all.push(this) }
    close() { this.closed = true }
    send(ev: unknown) { this.onmessage?.({ data: JSON.stringify(ev) }) }
  }

  it("follows each one's events, catches the ghost companies' names and looks up, and lets go of one with none left", async () => {
    FakeSocket.all = []
    vi.stubGlobal('WebSocket', FakeSocket)
    vi.stubGlobal('location', { protocol: 'http:', host: 'app' })
    vi.stubGlobal('window', { setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, clearTimeout: () => {} })
    const f = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', f)
    const stop = watchGhosts()
    expect(FakeSocket.all.map((s) => s.url)).toEqual(['ws://app/api/v1/remote/b/events?chats=paged'])
    const socket = FakeSocket.all[0]
    socket.onopen?.()
    const renamed = there()
    renamed.teams['team-9'] = { ...renamed.teams['team-9'], name: 'Acme Inc', plot: { at: [-40, 0], style: 'hut', seed: 9 } }
    socket.send({ type: 'snapshot', world: renamed })
    expect(useFeeds.getState().b).toMatchObject({ open: true })
    expect(useFeeds.getState().b.world?.teams['team-9'].name).toBe('Acme Inc')
    await turn()
    // where it stands here stays this island's
    const calls = () => (f.mock.calls as unknown as Array<[string, RequestInit]>).map(([url, init]) => [url, init.method ?? 'GET', init.body ? JSON.parse(init.body as string) : undefined])
    expect(calls()).toEqual([
      // its size, as soon as its computer is reached, for how tall it stands
      ['/api/v1/remote/b/teams/team-9/size', 'GET', undefined],
      ['/api/v1/ghosts/ghost-1', 'PATCH', { name: 'Acme Inc', plot: { at: [20, -8], style: 'hut', seed: 9 } }],
    ])
    // the same change is not sent again
    socket.send({ type: 'patch', upserts: [{ kind: 'chat', id: 'c1', data: { id: 'c1', teamId: 'team-9' } }] })
    await turn()
    expect(calls().filter(([, method]) => method === 'PATCH')).toHaveLength(1)

    // a chat read here earlier stays read; once its computer has it read too, nothing is kept of it
    useSeen.setState({ 'b\u0000c2': 1, 'b\u0000c3': 4 }, true)
    socket.send({ type: 'snapshot', world: { ...renamed, chats: { c2: { id: 'c2', teamId: 'team-9', unread: true, messages: [{}] }, c3: { id: 'c3', teamId: 'team-9', messages: [] } } } })
    expect(useFeeds.getState().b.world?.chats.c2.unread).toBe(false)
    expect(useSeen.getState()).toEqual({ 'b\u0000c2': 1 })

    useStore.setState((s) => { s.world.ghosts = {} })
    expect(socket.closed).toBe(true)
    expect(useFeeds.getState().b).toBeUndefined()
    stop()
  })
})
