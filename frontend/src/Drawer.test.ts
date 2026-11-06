import { afterEach, expect, it, vi } from 'vitest'
import { holdSheets, putAwaySheets } from './Drawer'
import { DEFAULT_PREFS, usePrefs } from './prefs'

afterEach(() => usePrefs.setState({ mapClick: DEFAULT_PREFS.mapClick }))

it('closes the drawer on a click on the map by default, open sheets and all', () => {
  const away = vi.fn()
  const release = holdSheets(away)
  expect(putAwaySheets()).toBe(false)
  expect(away).not.toHaveBeenCalled()
  release()
})

it('set to close the sheets first, puts away the open sheets first, and the drawer only once none are open', () => {
  usePrefs.setState({ mapClick: 'sheets' })
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
