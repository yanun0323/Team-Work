import { beforeEach, expect, it, vi } from 'vitest'
import { addLive, clearAllLive, clearLive, setOutput, useLive } from './live'

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

it('shows only the latest lines of a running command, until it ends', () => {
  setOutput('c', '1\n2')
  setOutput('c', '2\n3')
  expect(useLive.getState().outputs.c).toBe('2\n3')
  setOutput('c', '')
  expect(useLive.getState().outputs.c).toBeUndefined()
  setOutput('c', '4')
  clearAllLive()
  expect(useLive.getState().outputs).toEqual({})
})
