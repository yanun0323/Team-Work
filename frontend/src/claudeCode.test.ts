import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeStatus, installClaude, loginClaude, phaseOf } from './claudeCode'

const signal = new AbortController().signal
const answer = (status: number, body?: unknown) => vi.fn(async () => new Response(body === undefined ? null : JSON.stringify(body), { status }))

afterEach(() => vi.unstubAllGlobals())

describe('claude code setup', () => {
  it('goes from missing, to signed out, to signed in', () => {
    expect(phaseOf({ installed: false, signedIn: false, models: [] })).toBe('missing')
    expect(phaseOf({ installed: true, signedIn: false, models: [] })).toBe('signedOut')
    expect(phaseOf({ installed: true, signedIn: true, models: ['claude-code/opus'] })).toBe('signedIn')
  })

  it('says the user agreed when it installs, and only then', async () => {
    const f = answer(204)
    vi.stubGlobal('fetch', f)
    await claudeStatus(signal).catch(() => {})
    expect(f.mock.calls.at(-1)).toEqual(['/api/v1/claude-code', { signal }])
    await installClaude(signal)
    const [path, init] = f.mock.calls.at(-1) as unknown as [string, RequestInit]
    expect(path).toBe('/api/v1/claude-code/install')
    expect(init.method).toBe('POST')
    expect(init.body).toBe('{"consent":true}')
  })

  it('shows the message the backend gives', async () => {
    vi.stubGlobal('fetch', answer(400, { error: { code: 'invalid_request', message: '登入沒有完成' } }))
    await expect(loginClaude(signal)).rejects.toThrow('登入沒有完成')
  })

  it('says to start the backend when it is not there', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    await expect(claudeStatus(signal)).rejects.toThrow('make server')
    vi.stubGlobal('fetch', answer(500)) // the dev proxy, with nothing behind it
    await expect(claudeStatus(signal)).rejects.toThrow('make server')
  })

  it('lets a cancel through as a cancel', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('stop', 'AbortError') }))
    await expect(installClaude(signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
})
