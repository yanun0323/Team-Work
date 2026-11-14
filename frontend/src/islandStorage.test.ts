import { afterEach, expect, it, vi } from 'vitest'

vi.mock('./core/mode', () => ({ MOCK: false }))

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules() })

it('restores project sizes on each island switch, including before its world arrives', async () => {
  const data = new Map<string, string>([['projectBytes', '{"same":100}'], ['remote\u0000projectBytes', '{"same":900}']])
  vi.stubGlobal('localStorage', { getItem: (k: string) => data.get(k), setItem: (k: string, v: string) => data.set(k, v) })
  const { useIsland } = await import('./core/island')
  const { useProjectBytes } = await import('./projectSize')
  expect(useProjectBytes.getState()).toEqual({ same: 100 })
  useIsland.setState({ island: { id: 'remote', name: 'Remote' } })
  expect(useProjectBytes.getState()).toEqual({ same: 900 })
  useProjectBytes.setState({ same: 901 }, true)
  expect(data.get('remote\u0000projectBytes')).toBe('{"same":901}')
  expect(data.get('projectBytes')).toBe('{"same":100}')
  useIsland.setState({ island: null })
  expect(useProjectBytes.getState()).toEqual({ same: 100 })
})
