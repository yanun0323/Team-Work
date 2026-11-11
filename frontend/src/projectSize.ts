// How big each company's project is, which sets how tall its building stands. The backend adds up the files on the
// target branch once per commit, so asking again is cheap; the last sizes are kept across reloads so buildings do
// not drop to one storey while it is asked.

import { useEffect } from 'react'
import { create } from 'zustand'
import { request } from './core/backend'
import { islandScope, useIsland } from './core/island'
import { MOCK } from './core/mode'
import { FLOOR_BYTES, FLOOR_GROWTH, seedOfId } from './layout'

const KEPT = 'projectBytes'
/** How often sizes are asked for again, besides whenever a task is finished: commits made outside the app show up too. */
const REFRESH_MS = 60_000

function kept(): Record<string, number> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(islandScope(KEPT)) ?? '{}')
    return v && typeof v === 'object' ? (v as Record<string, number>) : {}
  } catch {
    return {}
  }
}

/** Bytes of each company's project, by the company's id; one not asked about yet is missing. */
export const useProjectBytes = create<Record<string, number>>(() => (MOCK ? {} : kept()))

/** The companies, as `useProjectSizePolling` takes them, last asked about on the island shown: answered or failed. */
const useAnswered = create<{ key: string | null }>(() => ({ key: null }))
const answeredKey = (ids: string) => `${islandScope(KEPT)}\u0000${ids}`

/** Whether every company in `ids` (joined by newlines) has had its size asked for on the island shown. */
export const useSizesAnswered = (ids: string) => useAnswered((s) => s.key === answeredKey(ids))

/** Whether `bytes` has a size for every company in `ids` (joined by newlines). */
export const hasSizes = (bytes: Record<string, number>, ids: string) => !ids || ids.split('\n').every((id) => bytes[id] !== undefined)

/** Whether every company in `ids` has a size to stand at on the island shown: asked for, or kept from before. */
export function useSizesKnown(ids: string) {
  const answered = useSizesAnswered(ids)
  const kept = useProjectBytes((b) => hasSizes(b, ids))
  return answered || kept
}

if (!MOCK) {
  useIsland.subscribe((next, prev) => {
    if (next.island?.id !== prev.island?.id) {
      useProjectBytes.setState(kept(), true)
      useAnswered.setState({ key: null })
    }
  })
  useProjectBytes.subscribe((next) => {
    try { localStorage.setItem(islandScope(KEPT), JSON.stringify(next)) } catch { /* private mode */ }
  })
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

/** `bytes` as Finder writes them: steps of 1000, at most one decimal, none for whole bytes; 0 and less is empty. */
export function fmtBytes(bytes: number): string {
  if (!(bytes > 0)) return ''
  let n = bytes
  let u = 0
  while (u < UNITS.length - 1 && Number(n.toFixed(1)) >= 1000) {
    n /= 1000
    u++
  }
  return `${u === 0 ? Math.round(n) : Number(n.toFixed(1))} ${UNITS[u]}`
}

/** A made-up size for the mock world: one to eight storeys, the same for a company every time. */
const mockBytes = (id: string) => FLOOR_BYTES * FLOOR_GROWTH ** ((seedOfId(id) % 8) - 1)

/**
 * Keeps `useProjectBytes` up to date for the companies in `ids` (joined by newlines): now, every `REFRESH_MS`, and
 * whenever `refresh` changes. A size that cannot be read keeps the last one.
 */
export function useProjectSizePolling(ids: string, refresh: string) {
  const island = useIsland((s) => s.island?.id ?? '')
  useEffect(() => {
    const scope = islandScope(KEPT)
    const list = ids ? ids.split('\n') : []
    if (MOCK) {
      useProjectBytes.setState(Object.fromEntries(list.map((id) => [id, mockBytes(id)])), true)
      useAnswered.setState({ key: answeredKey(ids) })
      return
    }
    const ctrl = new AbortController()
    const load = () => void Promise.all(list.map((id) =>
      request<{ bytes: number }>('GET', `/teams/${id}/size`, undefined, ctrl.signal).then((s) => [id, s.bytes] as const, () => null),
    )).then((got) => {
      if (ctrl.signal.aborted || islandScope(KEPT) !== scope) return
      const last = useProjectBytes.getState()
      const next = { ...last }
      for (const g of got) if (g) next[g[0]] = g[1]
      useProjectBytes.setState(next, true)
      useAnswered.setState({ key: answeredKey(ids) })
    })
    load()
    const timer = setInterval(load, REFRESH_MS)
    return () => { ctrl.abort(); clearInterval(timer) }
  }, [ids, refresh, island])
}
