import { afterEach, expect, it, vi } from 'vitest'

vi.mock('./core/mode', () => ({ MOCK: false }))

import { DEFAULT_PREFS, usePrefs } from './prefs'
import { emptyWorld } from './core/backend'
import { useStore } from './core/store'
import { setFailureHandler } from './core/ops'
import { resetSettings } from './Settings'

const turn = () => new Promise((resolve) => setTimeout(resolve, 0))
afterEach(() => {
  vi.unstubAllGlobals()
  usePrefs.setState(DEFAULT_PREFS)
  useStore.getState().setFailure('')
})

it('loads server preferences on snapshots and patches without reading browser storage', () => {
  const getItem = vi.fn(() => JSON.stringify({ state: { shadows: true } }))
  vi.stubGlobal('localStorage', { getItem, setItem: vi.fn() })
  const w = emptyWorld()
  w.preferences = { ...DEFAULT_PREFS, shadows: false, defaultTab: 'crew', musicVolume: 0, soundTakeoff: false }
  useStore.getState().receive({ type: 'snapshot', world: w })
  expect(usePrefs.getState().shadows).toBe(false)
  expect(usePrefs.getState().defaultTab).toBe('crew')
  expect(usePrefs.getState().musicVolume).toBe(0)
  expect(usePrefs.getState().soundTakeoff).toBe(false)
  const preferences = { ...w.preferences, clouds: false, effectsVolume: 82, soundLanding: false, musicStyle: 'chiptune' as const, soundNotice: false }
  useStore.getState().receive({ type: 'patch', upserts: [{ kind: 'preferences', id: 'world', data: preferences }] })
  expect(usePrefs.getState().clouds).toBe(false)
  expect(usePrefs.getState().effectsVolume).toBe(82)
  expect(usePrefs.getState().musicStyle).toBe('chiptune')
  expect(usePrefs.getState().soundNotice).toBe(false)
  expect(usePrefs.getState().soundLanding).toBe(false)
  expect(useStore.getState().world.preferences).toEqual(preferences)
  expect(getItem).not.toHaveBeenCalled()
})

it('sends only changed fields and leaves rejected preferences unchanged', async () => {
  setFailureHandler(useStore.getState().setFailure)
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: 'save failed' } }), { status: 409 }))
  vi.stubGlobal('fetch', fetch)
  usePrefs.getState().set({ shadows: false })
  await turn()
  expect(fetch).toHaveBeenCalledWith('/api/v1/settings/preferences', expect.objectContaining({ method: 'PATCH', body: '{"shadows":false}' }))
  expect(usePrefs.getState().shadows).toBe(true)
  expect(useStore.getState().failure).toBe('save failed')
})

it('takes persisted company positions from server snapshots and changes', () => {
  const w = emptyWorld()
  const team = { id: 'team-1', plot: { at: [10, 10], style: 'villa', seed: 123 } }
  useStore.getState().receive({ type: 'snapshot', world: w })
  useStore.getState().receive({ type: 'patch', upserts: [{ kind: 'team', id: team.id, data: team }] })
  expect(useStore.getState().world.teams[team.id].plot).toEqual(team.plot)
  useStore.getState().receive({ type: 'patch', deletes: [{ kind: 'team', id: team.id }] })
  expect(useStore.getState().world.teams[team.id]).toBeUndefined()
})

it('resets every preference and the language, and leaves the global AGENTS.md alone', async () => {
  const fetch = vi.fn().mockImplementation(async () => new Response(null, { status: 204 }))
  vi.stubGlobal('fetch', fetch)
  resetSettings()
  await turn()
  const calls = fetch.mock.calls.map(([url, init]) => [String(url).replace(/^.*\/api\/v1/, ''), init.method, JSON.parse(init.body)])
  expect(calls).toEqual([
    ['/settings/preferences', 'PATCH', DEFAULT_PREFS],
    ['/settings/language', 'PUT', { language: 'zh' }],
  ])
})
