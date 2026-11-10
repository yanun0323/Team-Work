import { tr } from './core/i18n'
import { apiBase } from './core/island'
import { idempotencyKey } from './core/backend'
// The backend's setup of Claude Code, which a Claude subscription runs through. This is the one thing the
// frontend asks the backend so far: the rest of it still runs on the simulator.

export interface ClaudeStatus {
  installed: boolean
  version?: string
  signedIn: boolean
  models: string[]
}

export const INSTALL_COMMAND = 'curl -fsSL https://claude.ai/install.sh | bash'

const unreachable = () => tr('連不上後端，請先執行 make dev')

async function call(path: string, init?: RequestInit): Promise<Response> {
  let res: Response
  try {
    const method = init?.method ?? 'GET'
    res = await fetch(`${apiBase()}/claude-code${path}`, method === 'GET' ? init : { ...init, headers: { ...init?.headers, 'Idempotency-Key': idempotencyKey() } })
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    throw new Error(unreachable())
  }
  if (res.ok) return res
  // the dev proxy answers without JSON when the backend is not running
  const body = await res.json().catch(() => null) as { error?: { message?: string } } | null
  throw new Error(body?.error?.message ?? unreachable())
}

const post = (path: string, body: unknown, signal: AbortSignal) =>
  call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal })

export const claudeStatus = async (signal: AbortSignal): Promise<ClaudeStatus> => (await call('', { signal })).json()

/** Only call this once the user has agreed: it downloads and runs Anthropic's installer. */
export const installClaude = async (signal: AbortSignal) => { await post('/install', { consent: true }, signal) }

export const loginClaude = async (signal: AbortSignal) => { await post('/login', {}, signal) }

export type ClaudePhase = 'checking' | 'missing' | 'installing' | 'signedOut' | 'loggingIn' | 'signedIn'

export const phaseOf = (s: ClaudeStatus): ClaudePhase => (!s.installed ? 'missing' : s.signedIn ? 'signedIn' : 'signedOut')
