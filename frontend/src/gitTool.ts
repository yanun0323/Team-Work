// Whether git runs on this computer, shared by every place that offers to install it. Installing opens Apple's own
// window and returns at once; the install happens there, so this asks again every few seconds until git is found.

import { request } from './core/backend'
import { remoteIsland } from './core/island'
import { MOCK } from './core/mode'

export interface GitStatus {
  installed: boolean
  version?: string
  /** Whether the app can install it: only on macOS, through Apple's Command Line Tools. */
  installable: boolean
}

/** `waiting` is Apple's window open, with the install up to the user. */
export type GitPhase = 'checking' | 'missing' | 'opening' | 'waiting' | 'ready'

export interface GitState {
  phase: GitPhase
  installable: boolean
  error: string
}

export const POLL_MS = 3000
/** Apple's install takes minutes; a window cancelled is not waited on for ever. */
export const WAIT_MS = 30 * 60 * 1000
/** How long the simulator's pretend install takes. */
export const SIMULATED_INSTALL_MS = 4000

// the simulator has no backend to ask, and git is there unless a clean Mac is played (see simulateNoGit)
let state: GitState = { phase: MOCK ? 'ready' : 'checking', installable: true, error: '' }
const listeners = new Set<() => void>()
let poll = 0
let waitedSince = 0
let asking = false
let simulated = 0

function set(next: Partial<GitState>) {
  state = { ...state, ...next }
  listeners.forEach((f) => f())
}

function stopPolling() {
  window.clearInterval(poll)
  poll = 0
}

export const gitState = () => state

/** Asks the backend once. Not reaching it is not a git problem: the connection has its own message. */
export async function checkGit(): Promise<void> {
  if (MOCK || asking) return
  asking = true
  try {
    const s = await request<GitStatus>('GET', '/git')
    if (s.installed) {
      stopPolling()
      set({ phase: 'ready', installable: s.installable, error: '' })
    } else if (state.phase === 'waiting' && Date.now() - waitedSince > WAIT_MS) {
      stopPolling()
      set({ phase: 'missing', installable: s.installable })
    } else {
      set({ phase: state.phase === 'waiting' || state.phase === 'opening' ? state.phase : 'missing', installable: s.installable })
    }
  } catch {
    // keep what is known
  } finally {
    asking = false
  }
}

/** The simulator only, for trying the install: plays a Mac with no git, or puts git back. */
export function simulateNoGit(on: boolean) {
  if (!MOCK) return
  window.clearTimeout(simulated)
  set({ phase: on ? 'missing' : 'ready', installable: true, error: '' })
}

/** Only call this once the user asked for it: it opens Apple's installer. */
export async function installGit(): Promise<void> {
  if (remoteIsland()) return
  if (state.phase === 'opening' || state.phase === 'ready') return
  if (MOCK) {
    // Apple's window is pretended open, and the install done a moment later
    set({ phase: 'waiting', error: '' })
    window.clearTimeout(simulated)
    simulated = window.setTimeout(() => set({ phase: 'ready' }), SIMULATED_INSTALL_MS)
    return
  }
  set({ phase: 'opening', error: '' })
  try {
    await request('POST', '/git/install', { consent: true })
  } catch (e) {
    set({ phase: 'missing', error: (e as Error).message })
    return
  }
  set({ phase: 'waiting' })
  waitedSince = Date.now()
  if (!poll) poll = window.setInterval(() => void checkGit(), POLL_MS)
  await checkGit()
}

// git may be installed outside the app, in a terminal, while it is in the background
const onFocus = () => {
  if (state.phase !== 'ready') void checkGit()
}

export function subscribeGit(listener: () => void) {
  if (!listeners.size && !MOCK) {
    window.addEventListener('focus', onFocus)
    if (state.phase === 'checking') void checkGit()
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    if (!listeners.size) window.removeEventListener('focus', onFocus)
  }
}

/** Forgets everything; for tests. */
export function resetGit(next: Partial<GitState> = {}) {
  stopPolling()
  window.clearTimeout(simulated)
  asking = false
  state = { phase: MOCK ? 'ready' : 'checking', installable: true, error: '', ...next }
}
