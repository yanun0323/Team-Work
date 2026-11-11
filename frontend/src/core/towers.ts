// The power tower: the computers this one is paired with, pairing a new one, and going to another's island and back.
// Its requests always go to this computer's backend, whichever island is shown (docs/power-tower.md, 7.2).

import { travel } from '../boot'
import { ApiError, connectAhead, localRequest, setIslandRefusedHandler } from './backend'
import { useIsland, type Island } from './island'
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
}

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
}

/** The tower as the mock shows it: this computer alone, with nothing to pair with. */
export const MOCK_TOWERS: Towers = { me: { id: 'mock', name: 'Team Work', protocol: 1 }, pairing: null, outgoing: null, peers: [] }

/** The tower as it is now; a backend with nothing paired may send no list at all. */
export const readTowers = (signal?: AbortSignal) => (MOCK
  ? Promise.resolve(MOCK_TOWERS)
  : localRequest<Towers>('GET', '/towers', undefined, signal).then((t) => ({ ...t, peers: t.peers ?? [] })))
export const startPairing = () => localRequest<Pairing>('POST', '/towers/pairing')
export const stopPairing = () => localRequest('DELETE', '/towers/pairing')
export const approvePairing = (requestId: string) => localRequest<Peer>('POST', '/towers/pairing/approve', { requestId })
export const rejectPairing = (requestId: string) => localRequest('POST', '/towers/pairing/reject', { requestId })
export const pairWith = (address: string) => localRequest<Outgoing>('POST', '/towers/pair', { address })
export const clearOutgoing = () => localRequest('DELETE', '/towers/outgoing')
export const allowPeer = (id: string, allowInbound: boolean) => localRequest<Peer>('PATCH', `/towers/peers/${encodeURIComponent(id)}`, { allowInbound })
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
