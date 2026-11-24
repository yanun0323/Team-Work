// Which computer's island the screen shows: this one's (null), or a paired computer's, reached through this
// computer's backend at /api/v1/remote/{id}. Every request about the island goes to that base; the power tower,
// the language and the interface preferences always stay with this computer.

import { create } from 'zustand'

export interface Island {
  id: string
  name: string
  /**
   * Set while one of that computer's companies is open from this island's map, as a ghost company: the company's
   * drawer works on that computer, while the map stays this one's.
   */
  ghost?: { id: string; teamId: string }
}

interface State {
  /** The paired computer whose island is shown; null is this computer's own. */
  island: Island | null
  /** Why the screen came back home on its own, for the user to read; cleared once read. */
  notice: string
}

export const useIsland = create<State>(() => ({ island: null, notice: '' }))

export const LOCAL_BASE = '/api/v1'

export const remoteIsland = () => useIsland.getState().island

/** Where requests about `island` go; null is this computer's own. */
const baseOf = (island: Island | null) => island ? `${LOCAL_BASE}/remote/${encodeURIComponent(island.id)}` : LOCAL_BASE

/** Where requests about the island shown go. */
export const apiBase = () => baseOf(remoteIsland())

/** The island the map shows: the one shown, but this computer's own while a ghost company is open on it. */
export const mapIsland = () => {
  const island = remoteIsland()
  return island?.ghost ? null : island
}

/** Where requests about the map's island go. */
export const mapBase = () => baseOf(mapIsland())

/** A WebSocket's address on `island`, `path` under /api/v1. */
export const socketUrlOn = (island: Island | null, path: string) => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${baseOf(island)}${path}`

/** A WebSocket's address on the island shown, `path` under /api/v1. */
export const socketUrl = (path: string) => socketUrlOn(remoteIsland(), path)

/**
 * A link the backend handed over, as `/api/v1/…` from its own point of view, made into one that reaches it from
 * here: on another island it goes through the remote base. Anything else (data: links, other sites) stays.
 */
export const shownUrl = (url: string) => {
  if (!remoteIsland() || !url.startsWith(`${LOCAL_BASE}/`)) return url
  return `${apiBase()}${url.slice(LOCAL_BASE.length)}`
}

/** Keys of what is kept in memory by id: an id on another computer may be the same as one here. */
export const islandScope = (key: string) => {
  const island = remoteIsland()
  return island ? `${island.id}\u0000${key}` : key
}

/** The same, for what belongs to the map's island (`mapIsland`). */
export const mapScope = (key: string) => {
  const island = mapIsland()
  return island ? `${island.id}\u0000${key}` : key
}

/** Whether another computer's island is shown, or one of its companies is open from here. */
export const useRemote = () => useIsland((s) => !!s.island)

/** The id of the map's island (`mapIsland`); '' for this computer's own. */
export const useMapIsland = () => useIsland((s) => (s.island?.ghost ? '' : s.island?.id ?? ''))
