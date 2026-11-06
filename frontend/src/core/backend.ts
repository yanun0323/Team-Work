// The connection to the backend. It owns the truth: the world arrives over a WebSocket, as a snapshot and then
// as changes; asking for something is a request, and what comes of it arrives the same way.

import type { Locale, World } from './domain/types'
import { tr } from './i18n'
import { DEFAULT_PREFS, type Prefs } from '../prefs'
import type { DiffLine } from '../diffView'

export const unreachable = () => tr(import.meta.env.MODE === 'desktop'
  ? '連不上後端，請關閉並重新開啟 Team Work'
  : '連不上後端，請先執行 make dev')

/** One changed entity. No data means it is gone. */
export interface Patch {
  kind: string
  id: string
  data?: unknown
}

export type ServerEvent =
  | { type: 'snapshot'; world: World }
  | { type: 'patch'; upserts?: Patch[]; deletes?: Patch[] }
  | { type: 'delta'; subId: string; text: string }
  | { type: 'deltaReset'; subId: string }
  | { type: 'toolOutput'; subId: string; text?: string }
  | { type: 'language'; language: Locale }
  | { type: 'notice'; kind: 'review' | 'awaitMerge'; taskId: string; subId?: string }

const BOOKS: Record<string, keyof World> = {
  team: 'teams', provider: 'providers', blueprint: 'blueprints', source: 'sources', replica: 'replicas', workflow: 'workflows', task: 'tasks', subTask: 'subTasks', chat: 'chats',
}

/** Writes a batch of changes into the world. `skip` leaves out what the user is in the middle of editing. */
export function applyPatches(w: World, ev: { upserts?: Patch[]; deletes?: Patch[] }, skip: (kind: string, id: string) => boolean = () => false) {
  for (const p of ev.upserts ?? []) {
    if (p.kind === 'preferences') { w.preferences = p.data as Prefs; continue }
    if (p.kind === 'tutorial') { w.tutorial = p.data as World['tutorial']; continue }
    const book = w[BOOKS[p.kind]] as Record<string, unknown> | undefined
    if (book && !skip(p.kind, p.id)) book[p.id] = p.data
    else if (p.kind === 'team' && w.teams[p.id]) {
      // A company settings form may hold its fields; map changes must still arrive.
      w.teams[p.id].plot = (p.data as World['teams'][string]).plot
    }
  }
  for (const p of ev.deletes ?? []) {
    const book = w[BOOKS[p.kind]] as Record<string, unknown> | undefined
    if (book) delete book[p.id]
  }
}

/** A file a sub-task handed on, as it was at that sub-task's commit. */
export const readHandedFile = (subId: string, path: string, signal: AbortSignal) =>
  request<{ text: string }>('GET', `/subtasks/${subId}/file?path=${encodeURIComponent(path)}`, undefined, signal).then((r) => r.text)

/** A handed file against how it was when its sub-task began; null when there is nothing to compare it with. */
export const readHandedDiff = (subId: string, path: string, signal: AbortSignal) =>
  request<{ lines: DiffLine[] | null }>('GET', `/subtasks/${subId}/diff?path=${encodeURIComponent(path)}`, undefined, signal).then((r) => r.lines)

/** Where an `<img>` loads a picture a sub-task handed over, as committed. */
export const handedImageUrl = (subId: string, path: string) => `/api/v1/subtasks/${subId}/image?path=${encodeURIComponent(path)}`

/** A world with nothing in it, until the backend's snapshot arrives. */
export const emptyWorld = (): World => ({
  preferences: { ...DEFAULT_PREFS }, now: Date.now() / 1000, seq: 0, language: 'zh', teams: {}, providers: {}, blueprints: {}, sources: {}, replicas: {}, workflows: {}, tasks: {}, subTasks: {}, chats: {},
  nextDriftAt: Infinity, rng: 0, events: [],
})

/** A request the backend refused: its message can be shown as it is; `code` and `status` tell kinds of refusal apart. */
export class ApiError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) {
    super(message)
  }
}

/** Sends a request and reads its JSON, if any. A failure throws what can be shown to the user, an ApiError when the backend answered. */
export async function request<T = void>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response
  try {
    res = await fetch(`/api/v1${path}`, {
      method, signal, ...(body === undefined ? {} : body instanceof Blob ? { body } : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    })
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    throw new Error(unreachable())
  }
  if (!res.ok) {
    // the dev proxy answers without JSON when the backend is not running
    const err = await res.json().catch(() => null) as { error?: { code?: string; message?: string } } | null
    if (!err?.error?.message) throw new Error(unreachable())
    throw new ApiError(err.error.message, err.error.code ?? '', res.status)
  }
  return (res.status === 204 ? undefined : await res.json()) as T
}

/**
 * Stays connected until the returned function is called, trying again a moment after each loss; a new
 * connection starts with a fresh snapshot, so nothing missed stays missed.
 */
export function connect(onEvent: (ev: ServerEvent) => void, onLost: () => void) {
  let socket: WebSocket | null = null
  let timer = 0
  let stopped = false
  const open = () => {
    socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/v1/events`)
    socket.onmessage = (m) => onEvent(JSON.parse(m.data as string) as ServerEvent)
    socket.onclose = () => {
      if (stopped) return
      onLost()
      timer = window.setTimeout(open, 1000)
    }
  }
  open()
  return () => {
    stopped = true
    window.clearTimeout(timer)
    socket?.close()
  }
}
