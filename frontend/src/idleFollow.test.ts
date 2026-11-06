import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { watchIdle } from './idleFollow'

beforeEach(() => void vi.useFakeTimers())
afterEach(() => void vi.useRealTimers())

/** A watcher on a bare event target, with the map's state in plain variables. */
function setup(seconds = 60) {
  const target = new EventTarget()
  const state = { seconds, main: true, following: false, onMap: true, starts: 0, stops: 0 }
  const stopped: string[] = []
  const watch = watchIdle(target, {
    seconds: () => state.seconds,
    canStart: () => state.main,
    following: () => state.following,
    start: () => void (state.starts++, state.following = true),
    stop: (e) => void (state.stops++, state.following = false, stopped.push(e.type)),
    onMap: () => state.onMap,
  })
  const fire = (type: string) => {
    const e = new Event(type, { cancelable: true })
    target.dispatchEvent(e)
    return e
  }
  return { state, watch, fire, stopped }
}

it('starts following once the main screen is left alone for the wait', () => {
  const { state } = setup(60)
  vi.advanceTimersByTime(59_000)
  expect(state.starts).toBe(0)
  vi.advanceTimersByTime(1_000)
  expect(state.starts).toBe(1)
})

it('counts the wait again from each click, drag or wheel', () => {
  const { state, fire } = setup(10)
  for (const type of ['pointerdown', 'wheel', 'keydown']) {
    vi.advanceTimersByTime(9_000)
    fire(type)
  }
  vi.advanceTimersByTime(9_000)
  expect(state.starts).toBe(0)
  vi.advanceTimersByTime(1_000)
  expect(state.starts).toBe(1)
})

it('counts only time spent on the main screen, and never when off', () => {
  const { state } = setup(10)
  state.main = false
  vi.advanceTimersByTime(60_000)
  expect(state.starts).toBe(0)
  state.main = true
  vi.advanceTimersByTime(9_000)
  expect(state.starts).toBe(0)
  vi.advanceTimersByTime(1_000)
  expect(state.starts).toBe(1)

  const off = setup(0)
  vi.advanceTimersByTime(3 * 3600_000)
  expect(off.state.starts).toBe(0)
})

it('stops following on a wheel, which then does nothing else on the map', () => {
  const { state, fire } = setup(10)
  vi.advanceTimersByTime(10_000)
  expect(fire('wheel').defaultPrevented).toBe(true)
  expect(state.stops).toBe(1)
  // the wait starts again from there
  vi.advanceTimersByTime(9_000)
  expect(state.starts).toBe(1)
  vi.advanceTimersByTime(1_000)
  expect(state.starts).toBe(2)
})

it('stops following on a press and lets it through, so whatever was clicked answers at once', () => {
  const { state, fire, stopped } = setup(10)
  vi.advanceTimersByTime(10_000)
  expect(fire('pointerdown').defaultPrevented).toBe(false)
  expect(fire('click').defaultPrevented).toBe(false)
  expect(state.stops).toBe(1)
  // told what stopped it, so the press can be kept from dragging the map
  expect(stopped).toEqual(['pointerdown'])
})

it('lets a wheel off the map through while stopping, and leaves input alone when not following', () => {
  const { state, fire } = setup(10)
  vi.advanceTimersByTime(10_000)
  state.onMap = false
  expect(fire('wheel').defaultPrevented).toBe(false)
  expect(state.stops).toBe(1)
  state.onMap = true
  expect(fire('wheel').defaultPrevented).toBe(false)
  expect(state.stops).toBe(1)
})

it('stops listening once disposed', () => {
  const { state, watch, fire } = setup(10)
  watch.dispose()
  vi.advanceTimersByTime(60_000)
  expect(state.starts).toBe(0)
  state.following = true
  fire('pointerdown')
  expect(state.stops).toBe(0)
})
