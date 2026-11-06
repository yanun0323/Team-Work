import { expect, it, vi } from 'vitest'
import { holdSheets, putAwaySheets } from './Drawer'

it('lets a click on the map put away the open sheets first, and the company only once none are open', () => {
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
  const older = holdSheets(() => {})
  const newer = vi.fn()
  holdSheets(newer)
  older()
  expect(putAwaySheets()).toBe(true)
  expect(newer).toHaveBeenCalledOnce()
})
