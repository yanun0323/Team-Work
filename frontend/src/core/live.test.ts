import { beforeEach, expect, it, vi } from 'vitest'
import { addLive, clearAllLive, clearLive, useLive } from './live'

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (fn: () => void) => { queueMicrotask(fn); return 1 })
  clearAllLive()
})

const settled = () => new Promise((done) => setTimeout(done))

it('adds up the pieces of one reply', async () => {
  addLive('c', '逐')
  addLive('c', '字')
  await settled()
  expect(useLive.getState().texts.c).toBe('逐字')
})

it('forgets a piece still waiting for its frame when cleared', async () => {
  addLive('c', '舊')
  clearLive('c')
  await settled()
  expect(useLive.getState().texts.c).toBeUndefined()
})
