// The connection to the backend. It owns the truth: the world arrives over a WebSocket, as a snapshot and then
// as changes; asking for something is a request, and what comes of it arrives the same way.

import type { Locale, World } from './domain/types'
import { tr } from './i18n'
import { DEFAULT_PREFS, type Prefs } from '../prefs'
import type { DiffLine } from '../diffView'
import { apiBase, LOCAL_BASE, socketUrl, socketUrlOn, type Island } from './island'

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
  | { type: 'notice'; kind: 'review' | 'awaitMerge' | 'mergeFailed'; taskId: string; subId?: string }

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
export const handedImageUrl = (subId: string, path: string) => `${apiBase()}/subtasks/${subId}/image?path=${encodeURIComponent(path)}`

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

/** A fresh key for one action, so a request sent again after a lost connection is not carried out twice. */
export const idempotencyKey = () =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`

/** Refusals that mean the island shown can no longer be used from here. */
export const LOST_ISLAND_CODES = ['peer_denied', 'peer_unpaired', 'incompatible', 'peer_blocked', 'peer_kicked'] as const

/** Told when another island's backend turns a request down for good; the island watch takes the screen home. */
let onIslandRefused: (e: ApiError) => void = () => {}
export const setIslandRefusedHandler = (fn: (e: ApiError) => void) => { onIslandRefused = fn }

async function send<T>(base: string, method: string, path: string, body?: unknown, signal?: AbortSignal, key?: string): Promise<T> {
  const headers: Record<string, string> = {}
  if (method !== 'GET') headers['Idempotency-Key'] = key ?? idempotencyKey()
  if (body !== undefined && !(body instanceof Blob)) headers['Content-Type'] = 'application/json'
  let res: Response
  try {
    res = await fetch(`${base}${path}`, {
      method, signal, headers, ...(body === undefined ? {} : { body: body instanceof Blob ? body : JSON.stringify(body) }),
    })
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    throw new Error(unreachable())
  }
  if (!res.ok) {
    // the dev proxy answers without JSON when the backend is not running
    const err = await res.json().catch(() => null) as { error?: { code?: string; message?: string } } | null
    if (!err?.error?.message) throw new Error(unreachable())
    const refused = new ApiError(err.error.message, err.error.code ?? '', res.status)
    if (base !== LOCAL_BASE && (LOST_ISLAND_CODES as readonly string[]).includes(refused.code)) onIslandRefused(refused)
    throw refused
  }
  return (res.status === 204 ? undefined : await res.json()) as T
}

/**
 * Sends a request to the island shown and reads its JSON, if any. A failure throws what can be shown to the user,
 * an ApiError when the backend answered. Every request but a GET carries a new Idempotency-Key.
 */
export const request = <T = void>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> =>
  send<T>(apiBase(), method, path, body, signal)

/**
 * The same, always to this computer's backend: the power tower, the language, the tutorial, interface preferences.
 * `key`, when given, is the Idempotency-Key, kept by the caller across retries of one action.
 */
export const localRequest = <T = void>(method: string, path: string, body?: unknown, signal?: AbortSignal, key?: string): Promise<T> =>
  send<T>(LOCAL_BASE, method, path, body, signal, key)

const EVENTS = '/events?chats=paged'

/** A connection opened before its island is shown, keeping what arrives until `connect` takes it over. */
let ahead: { url: string; socket: WebSocket; events: ServerEvent[]; closed: boolean } | null = null

/**
 * Starts connecting to `island` (null: this computer's own) while the screen still shows another, so its world is
 * in by the time it is shown; the next `connect` to it takes this connection over. Another call drops the last.
 */
export function connectAhead(island: Island | null) {
  // only ever a head start: with no way to open one (no page, say), `connect` opens its own
  let url: string
  try { url = socketUrlOn(island, EVENTS) } catch { return }
  if (ahead?.url === url && !ahead.closed) return
  dropAhead()
  let socket: WebSocket
  try { socket = new WebSocket(url) } catch { return }
  const a: NonNullable<typeof ahead> = { url, socket, events: [], closed: false }
  a.socket.onmessage = (m) => a.events.push(JSON.parse(m.data as string) as ServerEvent)
  a.socket.onclose = () => { a.closed = true }
  ahead = a
}

function dropAhead() {
  ahead?.socket.close()
  ahead = null
}

/**
 * Stays connected until the returned function is called, trying again a moment after each loss; a new
 * connection starts with a fresh snapshot, so nothing missed stays missed. One opened ahead to the island shown
 * (`connectAhead`) is taken over, with what it has already had.
 */
export function connect(onEvent: (ev: ServerEvent) => void, onLost: () => void) {
  let socket: WebSocket | null = null
  let timer = 0
  let stopped = false
  const listen = (s: WebSocket) => {
    socket = s
    s.onmessage = (m) => onEvent(JSON.parse(m.data as string) as ServerEvent)
    s.onclose = () => {
      if (stopped) return
      onLost()
      timer = window.setTimeout(open, 1000)
    }
  }
  const open = () => listen(new WebSocket(socketUrl(EVENTS)))
  const a = ahead
  if (a && a.url === socketUrl(EVENTS) && !a.closed) {
    ahead = null
    listen(a.socket)
    for (const ev of a.events) onEvent(ev)
  } else open()
  return () => {
    stopped = true
    window.clearTimeout(timer)
    socket?.close()
  }
}
