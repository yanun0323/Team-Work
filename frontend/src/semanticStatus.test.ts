import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('./core/mode', () => ({ MOCK: false }))

import { useIsland } from './core/island'
import { canRestart, OFF, pollDelay, readSemanticStatus, restartApp, saveSemanticSearch } from './semanticStatus'

const answer = (status: number, body?: unknown) =>
  vi.fn(async () => new Response(body === undefined ? null : JSON.stringify(body), { status }))
const calls = (f: ReturnType<typeof answer>) => f.mock.calls as unknown as Array<[string, RequestInit]>
const bridge = (postMessage: (x: null) => Promise<unknown>) => vi.stubGlobal('webkit', { messageHandlers: { restart: { postMessage } } })

beforeEach(() => useIsland.setState({ island: { id: 'b', name: 'Studio' }, notice: '' }))
afterEach(() => {
  vi.unstubAllGlobals()
  useIsland.setState({ island: null, notice: '' })
})

it('reads the status from this computer even while another island is shown', async () => {
  const f = answer(200, OFF)
  vi.stubGlobal('fetch', f)
  await expect(readSemanticStatus()).resolves.toEqual(OFF)
  expect(calls(f)[0][0]).toBe('/api/v1/settings/semantic-search')
  expect(calls(f)[0][1].method).toBe('GET')
})

it('saves the switch on this computer alone, and throws what the backend refused', async () => {
  const f = answer(204)
  vi.stubGlobal('fetch', f)
  await saveSemanticSearch(true)
  expect(calls(f)[0][0]).toBe('/api/v1/settings/preferences')
  expect(calls(f)[0][1].method).toBe('PATCH')
  expect(JSON.parse(calls(f)[0][1].body as string)).toEqual({ semanticSearch: true })
  vi.stubGlobal('fetch', answer(500, { error: { code: 'internal', message: '設定存不進去' } }))
  await expect(saveSemanticSearch(false)).rejects.toThrow('設定存不進去')
})

it('looks again every second while something moves, and seldom otherwise', () => {
  for (const s of ['downloading', 'compiling', 'indexing'] as const) expect(pollDelay(s)).toBe(1000)
  for (const s of ['disabled', 'restart_required', 'ready', 'error'] as const) expect(pollDelay(s)).toBeGreaterThan(1000)
})

it('restarts only through the Mac app, and passes on why it would not', async () => {
  expect(canRestart()).toBe(false)
  await expect(restartApp()).rejects.toThrow()

  const post = vi.fn(async () => ({ accepted: true }))
  bridge(post)
  expect(canRestart()).toBe(true)
  await expect(restartApp()).resolves.toBeUndefined()
  expect(post).toHaveBeenCalledWith(null)

  bridge(() => Promise.reject('無法啟動新的 App'))
  await expect(restartApp()).rejects.toThrow('無法啟動新的 App')
  bridge(async () => ({ accepted: false }))
  await expect(restartApp()).rejects.toThrow()
  bridge(async () => undefined)
  await expect(restartApp()).rejects.toThrow()
})
