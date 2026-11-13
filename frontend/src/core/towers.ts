// The power tower: the computers this one is paired with, pairing a new one, and going to another's island and back.
// Its requests always go to this computer's backend, whichever island is shown (docs/power-tower.md, 7.2).

import { travel } from '../boot'
import { create } from 'zustand'
import { ApiError, connectAhead, idempotencyKey, localRequest, request, setIslandRefusedHandler } from './backend'
import { LOCAL_BASE, useIsland, type Island } from './island'
import { MOCK } from './mode'
import { useStore } from './store'

export type PeerStatus = 'checking' | 'online' | 'offline' | 'denied' | 'unpaired' | 'incompatible'

export interface Peer {
  id: string
  name: string
  /** Whether this computer can work the other's island: only online can be gone to. */
  status: PeerStatus
  /** This computer lets it work this one's island. */
  allowInbound: boolean
  protocol?: number
  lastSeenAt?: number
  pairedAt: number
  /** Why it is not online, ready to show. */
  message?: string
  /** What it may do on this island once allowed in. */
  access: PeerAccess
  /** Kept out until this Unix time; -1 until unblocked by hand; absent when not blocked. */
  blockedUntil?: number
}

export type PeerAccess = 'view' | 'operate'

/** A paired computer on this island now, with the places its pages have open: `airport` or `team:{id}`. */
export interface Visitor { id: string; name: string; places: string[] }

export interface PairRequest { id: string; name: string; protocol: number; compatible: boolean }

export interface Pairing {
  address: string
  expiresAt: number
  request: PairRequest | null
}

export type OutgoingCode = 'invalid_request' | 'unavailable' | 'pair_rejected' | 'pair_expired' | 'pair_busy' | 'pair_self' | 'incompatible'

export interface Outgoing {
  state: 'connecting' | 'waiting' | 'paired' | 'failed'
  name?: string
  code?: OutgoingCode | string
  message?: string
  peerId?: string
}

export interface Towers {
  me: { id: string; name: string; protocol: number }
  pairing: Pairing | null
  outgoing: Outgoing | null
  peers: Peer[]
  visitors: Visitor[]
}

/** The tower as the mock shows it: this computer alone, with nothing to pair with. */
export const MOCK_TOWERS: Towers = { me: { id: 'mock', name: 'Team Work', protocol: 2 }, pairing: null, outgoing: null, peers: [], visitors: [] }

/** The tower as it is now; a backend with nothing paired may send no list at all. */
export const readTowers = (signal?: AbortSignal) => (MOCK
  ? Promise.resolve(MOCK_TOWERS)
  : localRequest<Towers>('GET', '/towers', undefined, signal).then((t) => ({ ...t, peers: t.peers ?? [], visitors: t.visitors ?? [] })))
export const startPairing = () => localRequest<Pairing>('POST', '/towers/pairing')
export const stopPairing = () => localRequest('DELETE', '/towers/pairing')
export const approvePairing = (requestId: string) => localRequest<Peer>('POST', '/towers/pairing/approve', { requestId })
export const rejectPairing = (requestId: string) => localRequest('POST', '/towers/pairing/reject', { requestId })
export const pairWith = (address: string) => localRequest<Outgoing>('POST', '/towers/pair', { address })
export const clearOutgoing = () => localRequest('DELETE', '/towers/outgoing')
export const allowPeer = (id: string, allowInbound: boolean) => localRequest<Peer>('PATCH', `/towers/peers/${encodeURIComponent(id)}`, { allowInbound })
export const setPeerAccess = (id: string, access: PeerAccess) => localRequest<Peer>('PATCH', `/towers/peers/${encodeURIComponent(id)}`, { access })
export const setProfile = (name: string) => localRequest<Towers['me']>('PUT', '/towers/profile', { name })
export const kickPeer = (id: string) => localRequest('POST', `/towers/peers/${encodeURIComponent(id)}/kick`)
export const blockPeer = (id: string, span: 'hour' | 'manual') => localRequest<Peer>('POST', `/towers/peers/${encodeURIComponent(id)}/block`, { for: span })
export const unblockPeer = (id: string) => localRequest<Peer>('DELETE', `/towers/peers/${encodeURIComponent(id)}/block`)
/** Whether a paired computer is kept out now, at `now` in Unix seconds. */
export const isBlocked = (p: Pick<Peer, 'blockedUntil'>, now = Date.now() / 1000) => p.blockedUntil === -1 || (p.blockedUntil ?? 0) > now
export const checkPeer = (id: string) => localRequest<Peer>('POST', `/towers/peers/${encodeURIComponent(id)}/check`)
export const unpairPeer = (id: string) => localRequest('DELETE', `/towers/peers/${encodeURIComponent(id)}`)

/** The statuses that send the screen home from another island: it can no longer be worked from here. */
const SENDS_HOME: PeerStatus[] = ['denied', 'unpaired', 'incompatible']

/**
 * Shows a paired computer's island: its backend's world in place of this one's, swapped once a plane has flown
 * this one out of sight (or under the clouds closing over the map); it comes in once the island has arrived
 * (World.tsx, `useLanding`). Its world starts coming at once, as the plane takes off.
 */
function enter(island: Island | null, then: () => void = () => {}) {
  if ((useIsland.getState().island?.id ?? null) === (island?.id ?? null)) return then()
  if (!MOCK) connectAhead(island)
  travel(() => {
    if ((useIsland.getState().island?.id ?? null) !== (island?.id ?? null)) {
      useStore.getState().leaveIsland()
      useIsland.setState({ island })
    }
    then()
  }, island === null)
}

/**
 * Goes to a paired computer's island, once a check now finds it can be worked from here. Otherwise stays, and
 * answers why, ready to show.
 */
export async function goTo(id: string): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const peer = await checkPeer(id)
    if (peer.status !== 'online') return { ok: false, message: peer.message ?? '' }
    useIsland.setState({ notice: '' })
    await new Promise<void>((done) => enter({ id: peer.id, name: peer.name }, done))
    return { ok: true }
  } catch (e) {
    return { ok: false, message: (e as Error).message }
  }
}

/** Back to this computer's own island. `why`, when it went on its own, is shown once there. */
export function goHome(why = '') {
  useIsland.setState({ notice: why })
  enter(null)
}

/**
 * While another island is shown: a request it turns down for good, or a check after its connection is lost, that
 * finds it can no longer be worked from here, takes the screen home and says why. Returns the undo.
 */
export function watchIsland(every = 5000) {
  setIslandRefusedHandler((e: ApiError) => {
    if (useIsland.getState().island) goHome(e.message)
  })
  let busy = false
  const check = async () => {
    const island = useIsland.getState().island
    if (!island || busy || !useStore.getState().offline) return
    busy = true
    try {
      const peer = await checkPeer(island.id)
      if (useIsland.getState().island?.id !== island.id) return
      if (SENDS_HOME.includes(peer.status)) goHome(peer.message ?? '')
    } catch (e) {
      // unpaired here, from the tower
      if (e instanceof ApiError && e.code === 'not_found' && useIsland.getState().island?.id === island.id) goHome(e.message)
    } finally {
      busy = false
    }
  }
  const timer = window.setInterval(() => void check(), every)
  const off = useStore.subscribe((s, before) => { if (s.offline && !before.offline) void check() })
  return () => {
    window.clearInterval(timer)
    off()
    setIslandRefusedHandler(() => {})
  }
}

/** After unpairing the computer whose island is shown, from this tower: back home. */
export function leftPeer(id: string) {
  if (useIsland.getState().island?.id === id) goHome()
}

/** This page, among the pages a computer has open on another island: the island counts the computer once. */
const PAGE = idempotencyKey().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)

/** How often a page on another island says what it has open; the island drops a page silent for 30 seconds. */
export const PRESENCE_MS = 10_000

/** What the screen has open, as another island is told it: `airport`, `team:{id}`, or nothing. */
export const presencePlace = (selected: string | null, airport: boolean) => (selected ? `team:${selected}` : airport ? 'airport' : '')

/**
 * While another island is shown, tells it now and every few seconds what this page has open, so its owner sees who
 * is there; leaving it, or closing the page, says this page has gone. `tell` says it again at once, after a change.
 */
export function reportPresence(place: () => string, every = PRESENCE_MS) {
  if (MOCK) return { tell: () => {}, stop: () => {} }
  let last: Island | null = null
  const gone = (island: Island) => {
    // the island left may refuse now; that refusal must not send home from the island shown
    void fetch(`${LOCAL_BASE}/remote/${encodeURIComponent(island.id)}/presence`, {
      method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey() },
      body: JSON.stringify({ page: PAGE, gone: true }),
    }).catch(() => {})
  }
  const tell = () => {
    const island = useIsland.getState().island
    if (last && last.id !== island?.id) gone(last)
    last = island
    if (island) request('POST', '/presence', { page: PAGE, place: place() }).catch(() => {})
  }
  tell()
  const timer = window.setInterval(tell, every)
  const off = useIsland.subscribe((s, before) => { if (s.island?.id !== before.island?.id) tell() })
  const unload = () => { if (last) gone(last) }
  window.addEventListener('pagehide', unload)
  return {
    tell,
    stop: () => {
      window.clearInterval(timer)
      off()
      window.removeEventListener('pagehide', unload)
      unload()
    },
  }
}

/** The paired computers on this island now, read every few seconds while this computer's own island is shown. */
export const useVisitors = create<{ visitors: Visitor[] }>(() => ({ visitors: [] }))

export function watchVisitors(every = 5000) {
  if (MOCK) return () => {}
  let live = true
  const read = async () => {
    if (useIsland.getState().island) return useVisitors.setState({ visitors: [] })
    try {
      const t = await readTowers()
      if (live && !useIsland.getState().island) useVisitors.setState({ visitors: t.visitors })
    } catch {
      // keep the last list until the tower answers again
    }
  }
  void read()
  const timer = window.setInterval(() => void read(), every)
  return () => {
    live = false
    window.clearInterval(timer)
  }
}

/** Who has `place` open, by name, for its tag on the map. */
export const visitorsAt = (visitors: Visitor[], place: string) => visitors.filter((v) => v.places.includes(place)).map((v) => v.name)
