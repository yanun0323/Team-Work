// Which computer's island the screen shows: this one's (null), or a paired computer's, reached through this
// computer's backend at /api/v1/remote/{id}. Every request about the island goes to that base; the power tower,
// the language, the tutorial and the interface preferences always stay with this computer.

import { create } from 'zustand'

export interface Island {
  id: string
  name: string
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

/** Where requests about the island shown go. */
export const apiBase = () => {
  const island = remoteIsland()
  return island ? `${LOCAL_BASE}/remote/${encodeURIComponent(island.id)}` : LOCAL_BASE
}

/** A WebSocket's address on the island shown, `path` under /api/v1. */
export const socketUrl = (path: string) => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${apiBase()}${path}`

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

/** Whether another computer's island is shown. */
export const useRemote = () => useIsland((s) => !!s.island)
