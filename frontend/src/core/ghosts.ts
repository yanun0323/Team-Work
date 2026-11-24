// Ghost companies: a paired computer's company with its building on this island. Only where it stands is kept here;
// the company, its work and everything in it stay on that computer, reached through the power tower
// (`/api/v1/remote/{peer}`). While one is open its drawer works on that computer and the map stays this one's
// (store.ts `enterGhost`). Meanwhile every computer with ghost companies here is followed in the background, for their
// buildings and name tags: lit windows, work under way and what waits for the user.

import { create } from 'zustand'
import { useProjectBytes } from '../projectSize'
import type { BuildingLook, Spot } from '../layout'
import { applyPatches, emptyWorld, follow, localRequest, type ServerEvent } from './backend'
import type { Ghost, World } from './domain/types'
import { useIsland } from './island'
import { teamAlerts } from './model'
import { MOCK } from './mode'
import { homeWorld, useStore } from './store'
import { usePeers, type Peer, type PeerStatus } from './towers'

/** What is known of a paired computer with ghost companies here: its world, as its events last had it. */
export interface Feed {
  world: World | null
  /** Its events are coming now. */
  open: boolean
}

/** The paired computers followed for their ghost companies, by id. */
export const useFeeds = create<Record<string, Feed>>(() => ({}))

/**
 * How a ghost company stands: it can be worked (`online`) or only looked at (`view`); its computer can't be reached
 * now (`offline`); that computer no longer lets this one in, or is no longer paired (`lost`); or the company was
 * closed there (`gone`).
 */
export type GhostState = 'online' | 'view' | 'offline' | 'lost' | 'gone'

const LOST: PeerStatus[] = ['denied', 'unpaired', 'incompatible']

export function ghostState(g: Pick<Ghost, 'peerId' | 'teamId'>, peers: Peer[] | null, feed?: Feed): GhostState {
  const peer = peers?.find((p) => p.id === g.peerId)
  if (peers && !peer) return 'lost'
  if (peer && LOST.includes(peer.status)) return 'lost'
  if (feed?.open && feed.world) {
    if (!feed.world.teams[g.teamId]) return 'gone'
    return peer?.granted === 'view' ? 'view' : 'online'
  }
  return 'offline'
}

/** How the ghost company drawn for `g` stands now; null for one of this island's own companies. */
export function useGhostState(g?: Pick<Ghost, 'peerId' | 'teamId'>): GhostState | null {
  const peers = usePeers((s) => s.peers)
  const feed = useFeeds((f) => (g ? f[g.peerId] : undefined))
  return g ? ghostState(g, peers, feed) : null
}

/** The world a ghost company's building reads, from its computer's follow: an empty one until it has come. */
export function useGhostWorld(g?: Pick<Ghost, 'peerId'>): World | null {
  return useFeeds((f) => (g ? f[g.peerId]?.world ?? null : null))
}

/** Whether a ghost company in this state opens its drawer. */
export const opens = (state: GhostState) => state === 'online' || state === 'view'

/** The ghost companies on the map's island; on another computer's island its own stand there only to be seen. */
export const ghostsOf = (w: World): Ghost[] => Object.values(w.ghosts ?? {})

/** Whether the map shows this computer's own island, whose ghost companies can be opened. */
const ownIsland = () => {
  const island = useIsland.getState().island
  return !island || !!island.ghost
}

/** What waits for the user in the ghost companies here, as the Dock badge and name tags count it. */
export function ghostWaiting(home: World, feeds: Record<string, Feed>) {
  let n = 0
  for (const g of ghostsOf(home)) {
    const w = feeds[g.peerId]?.world
    if (!w?.teams[g.teamId]) continue
    const a = teamAlerts(w, g.teamId)
    n += a.waitingChats + a.waitingTasks
  }
  return n
}

export const createGhost = (input: { peerId: string; teamId: string; name: string; plot: BuildingLook & { at: Spot } }) =>
  localRequest<Ghost>('POST', '/ghosts', input)
export const moveGhost = (id: string, plot: BuildingLook & { at: Spot }) => localRequest('PATCH', `/ghosts/${encodeURIComponent(id)}`, { plot })
export const removeGhost = (id: string) => localRequest('DELETE', `/ghosts/${encodeURIComponent(id)}`)

/** Starts a paired computer's follow from `world`, just read, unless it has one: a ghost company just put up opens at once. */
export function seedFeed(peerId: string, world: World) {
  if (!useFeeds.getState()[peerId]?.world) useFeeds.setState({ [peerId]: { world: { ...emptyWorld(), ...world }, open: true } })
}

/** Reads a paired computer's companies, for picking one to show here. */
export const readPeerWorld = (peerId: string, signal?: AbortSignal) =>
  localRequest<World>('GET', `/remote/${encodeURIComponent(peerId)}/world?chats=paged`, undefined, signal)

/**
 * Opens a ghost company: the drawers work on its computer, starting from what the background follow already has, while
 * the map stays this island's.
 */
export function openGhost(g: Ghost) {
  const name = usePeers.getState().peers?.find((p) => p.id === g.peerId)?.name ?? g.name
  const feed = useFeeds.getState()[g.peerId]
  // a copy: the store freezes what it holds, and the follow goes on changing its own
  useStore.getState().enterGhost(feed?.world ? structuredClone(feed.world) : null)
  useIsland.setState({ island: { id: g.peerId, name, ghost: { id: g.id, teamId: g.teamId } }, notice: '' })
}

/** How often each ghost company's project size is asked for again: it sets how tall its building stands. */
const SIZE_MS = 60_000

/**
 * While this computer's own island is shown, follows every paired computer with ghost companies on it, and keeps the
 * ghost companies' names, looks and sizes in step with their companies there. Returns the undo.
 */
export function watchGhosts(retry = 5000) {
  if (MOCK) return () => {}
  const links = new Map<string, () => void>()
  // what each ghost company was last caught up to, so the same change is sent once
  const sent = new Map<string, string>()
  const take = (peer: string, ev: ServerEvent) => {
    const cur = useFeeds.getState()[peer] ?? { world: null, open: false }
    let world = cur.world
    if (ev.type === 'snapshot') world = { ...emptyWorld(), ...ev.world }
    else if (ev.type === 'patch' && world) {
      // a new world and new books each time, so what reads them sees the change
      world = { ...world, teams: { ...world.teams }, replicas: { ...world.replicas }, tasks: { ...world.tasks }, subTasks: { ...world.subTasks }, chats: { ...world.chats } }
      applyPatches(world, ev)
    } else return
    useFeeds.setState({ [peer]: { world, open: true } })
    catchUp(peer, world)
  }
  // a ghost company follows its company's name and look; where it stands stays this island's
  const catchUp = (peer: string, there: World) => {
    for (const g of ghostsOf(homeWorld(useStore.getState()))) {
      const t = g.peerId === peer ? there.teams[g.teamId] : undefined
      if (!t) continue
      const style = t.plot?.style ?? g.plot.style, seed = t.plot?.seed ?? g.plot.seed
      if (t.name === g.name && style === g.plot.style && seed === g.plot.seed) continue
      const want = `${t.name}\u0000${style}\u0000${seed}`
      if (sent.get(g.id) === want) continue
      sent.set(g.id, want)
      void localRequest('PATCH', `/ghosts/${encodeURIComponent(g.id)}`, { name: t.name, plot: { at: g.plot.at, style, seed } }).catch(() => sent.delete(g.id))
    }
  }
  const sync = () => {
    const ghosts = ownIsland() ? ghostsOf(homeWorld(useStore.getState())) : []
    const want = new Set(ghosts.map((g) => g.peerId))
    for (const [peer, stop] of links) {
      if (want.has(peer)) continue
      stop()
      links.delete(peer)
      useFeeds.setState((f) => Object.fromEntries(Object.entries(f).filter(([id]) => id !== peer)), true)
    }
    for (const peer of want) {
      if (links.has(peer)) continue
      links.set(peer, follow({ id: peer, name: '' }, (ev) => take(peer, ev), (open) => {
        const cur = useFeeds.getState()[peer]
        if (cur?.open !== open) useFeeds.setState({ [peer]: { world: cur?.world ?? null, open } })
      }, retry))
    }
  }
  const sizes = () => {
    if (!ownIsland()) return
    for (const g of ghostsOf(homeWorld(useStore.getState()))) {
      if (!useFeeds.getState()[g.peerId]?.open) continue
      void localRequest<{ bytes: number }>('GET', `/remote/${encodeURIComponent(g.peerId)}/teams/${encodeURIComponent(g.teamId)}/size`)
        .then((s) => { if (typeof s?.bytes === 'number') useProjectBytes.setState({ [g.id]: s.bytes }) }, () => {})
    }
  }
  sync()
  const offStore = useStore.subscribe((s, before) => { if (homeWorld(s).ghosts !== homeWorld(before).ghosts) sync() })
  const offIsland = useIsland.subscribe((s, before) => { if (s.island !== before.island) sync() })
  // a computer just reached has its sizes asked for at once
  const offFeeds = useFeeds.subscribe((s, before) => { if (Object.keys(s).some((id) => s[id].open && !before[id]?.open)) sizes() })
  const timer = window.setInterval(sizes, SIZE_MS)
  return () => {
    offStore()
    offIsland()
    offFeeds()
    window.clearInterval(timer)
    for (const stop of links.values()) stop()
    links.clear()
    useFeeds.setState({}, true)
  }
}
