// The experimental semantic search: its switch and how far the model has got, always this computer's own.
// The switch is a preference but takes effect only after the app restarts, which the Mac app does on request.

import { localRequest } from './core/backend'
import { MOCK } from './core/mode'

export type SemanticState = 'unsupported' | 'disabled' | 'restart_required' | 'downloading' | 'compiling' | 'indexing' | 'ready' | 'error'

export interface SemanticStatus {
  supported: boolean
  /** The saved switch. */
  enabled: boolean
  /** Turned on for this run of the app; says nothing about the model being ready. */
  active: boolean
  requiresRestart: boolean
  state: SemanticState
  /** A short reason fit to show; often empty. */
  reason: string
  progress: {
    downloadedBytes: number
    /** Null while the size is not known. */
    totalBytes: number | null
    completedFiles: number
    totalFiles: number
    pendingFiles: number
    chunks: number
  }
  error: { code: string; message: string; stage: string; log: string } | null
}

/** What the backend says while the switch is off, and what mock mode starts with. */
export const OFF: SemanticStatus = {
  supported: true, enabled: false, active: false, requiresRestart: false, state: 'disabled', reason: '',
  progress: { downloadedBytes: 0, totalBytes: null, completedFiles: 0, totalFiles: 0, pendingFiles: 0, chunks: 0 }, error: null,
}

// mock mode has no backend: the switch is kept here, and turning it on asks for a restart that never comes
let mock: SemanticStatus = OFF

export const readSemanticStatus = (signal?: AbortSignal): Promise<SemanticStatus> =>
  MOCK ? Promise.resolve(mock) : localRequest<SemanticStatus>('GET', '/settings/semantic-search', undefined, signal)

export async function saveSemanticSearch(on: boolean): Promise<void> {
  if (!MOCK) return localRequest('PATCH', '/settings/preferences', { semanticSearch: on })
  mock = on ? { ...OFF, enabled: true, requiresRestart: true, state: 'restart_required' } : OFF
}

/** How soon to look again: often while something is under way, now and then otherwise, in case it changes. */
export const pollDelay = (s: SemanticState) => (s === 'downloading' || s === 'compiling' || s === 'indexing' ? 1000 : 10000)

type Bridge = { postMessage: (x: null) => Promise<unknown> }
const restartBridge = () => (globalThis as { webkit?: { messageHandlers?: { restart?: Bridge } } }).webkit?.messageHandlers?.restart

/** Whether the Mac app can restart itself from here; a page in a browser cannot. */
export const canRestart = () => !!restartBridge()

/** Asks the Mac app to restart. Throws what the app said went wrong, or an empty message when it gave no reason. */
export async function restartApp(): Promise<void> {
  const bridge = restartBridge()
  if (!bridge) throw new Error('')
  let reply: unknown
  try {
    reply = await bridge.postMessage(null)
  } catch (e) {
    // WebKit rejects with the native side's error string
    throw new Error(typeof e === 'string' ? e : (e as Error | undefined)?.message ?? '')
  }
  if (!(reply && typeof reply === 'object' && (reply as { accepted?: unknown }).accepted === true)) throw new Error('')
}
