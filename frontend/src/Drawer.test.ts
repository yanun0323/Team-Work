import { afterEach, expect, it, vi } from 'vitest'
import { holdSheets, putAwaySheets } from './Drawer'
import { DEFAULT_PREFS, usePrefs } from './prefs'

afterEach(() => usePrefs.setState({ mapClick: DEFAULT_PREFS.mapClick }))

it('set to go straight back, closes the drawer on a click on the map, open sheets and all', () => {
  usePrefs.setState({ mapClick: 'home' })
  const away = vi.fn()
  const release = holdSheets(away)
  expect(putAwaySheets()).toBe(false)
  expect(away).not.toHaveBeenCalled()
  release()
})

it('by default, puts away the open sheets first, and the drawer only once none are open', () => {
  expect(DEFAULT_PREFS.mapClick).toBe('sheets')
  expect(putAwaySheets()).toBe(false)
  const away = vi.fn()
  const release = holdSheets(away)
  expect(putAwaySheets()).toBe(true)
  expect(away).toHaveBeenCalledOnce()
  release()
  expect(putAwaySheets()).toBe(false)
  expect(away).toHaveBeenCalledOnce()
})

it('keeps the newer hold when an older one is released late', () => {
  usePrefs.setState({ mapClick: 'sheets' })
  const older = holdSheets(() => {})
  const newer = vi.fn()
  const release = holdSheets(newer)
  older()
  expect(putAwaySheets()).toBe(true)
  expect(newer).toHaveBeenCalledOnce()
  release()
})
