// The landmarks' roads on the profile, in WebKit as the macOS app draws them: the note a stop floats over the page
// when pointed at or focused, and what a stop reached does when pressed.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import './fusion.css'
import './core/store'
import { LandmarkRoads } from './LandmarkRoads'
import type { LandmarkRoad } from './core/landmarks'
import type { LandmarkKind } from './core/domain/types'

const road: LandmarkRoad = { kind: 'park', stage: 1, value: 12, steps: [10, 50, 200] }
let root: Root | null = null
let box: HTMLDivElement | null = null
let shows: Array<LandmarkKind | null> = []

async function draw(at: 'top' | 'middle', shown: LandmarkKind | null = null) {
  box?.remove()
  box = document.createElement('div')
  box.style.cssText = `position: fixed; left: 40px; width: 360px; ${at === 'top' ? 'top: 0' : 'top: 300px'}`
  document.body.append(box)
  root = createRoot(box)
  await act(async () => root!.render(<LandmarkRoads roads={[road]} shown={shown} onShow={(k) => shows.push(k)} />))
}

beforeEach(() => { shows = [] })

afterEach(() => {
  act(() => root?.unmount())
  box?.remove()
  root = box = null
})

const stops = () => [...box!.querySelectorAll<HTMLButtonElement>('.fx-road-node')]
const note = () => box!.querySelector<HTMLElement>('.fx-road-note')

it('floats what a stop asks for over the page, by the stop, taking no room', async () => {
  await draw('middle')
  const list = box!.querySelector('.fx-road')!
  const height = list.getBoundingClientRect().height
  await userEvent.hover(stops()[1])
  expect(note()).not.toBeNull()
  expect(note()!.matches(':popover-open')).toBe(true)
  expect(note()!.textContent).toContain('完成 50 個任務')
  expect(note()!.textContent).toContain('12 / 50')
  expect(list.getBoundingClientRect().height).toBe(height)
  const n = note()!.getBoundingClientRect(), s = stops()[1].getBoundingClientRect()
  // above the stop, centred on it, inside the window
  expect(n.bottom).toBeLessThanOrEqual(s.top)
  expect(Math.abs((n.left + n.right) / 2 - (s.left + s.right) / 2)).toBeLessThan(4)
  expect(n.left).toBeGreaterThanOrEqual(0)
  await userEvent.unhover(stops()[1])
  expect(note()).toBeNull()
})

it('puts the note under a stop with no room above it', async () => {
  await draw('top')
  await userEvent.hover(stops()[0])
  expect(note()!.getBoundingClientRect().top).toBeGreaterThanOrEqual(stops()[0].getBoundingClientRect().bottom)
  expect(note()!.textContent).toContain('已解鎖')
})

it('shows the note to the keyboard too, and Esc puts it away first', async () => {
  await draw('middle')
  await userEvent.tab()
  expect(document.activeElement).toBe(stops()[0])
  expect(note()).not.toBeNull()
  // while it is up, Esc is the note's, not the profile's
  expect(stops()[0].dataset.esc).toBe('box')
  await userEvent.keyboard('{Escape}')
  expect(note()).toBeNull()
  expect(stops()[0].dataset.esc).toBeUndefined()
  await userEvent.tab()
  expect(document.activeElement).toBe(stops()[1])
  expect(note()!.textContent).toContain('12 / 50')
})

it('shows a landmark reached on the map, and stops showing it when pressed again; one not reached does nothing', async () => {
  await draw('middle')
  // not pressable as far as the pointer goes; clicked anyway, it does nothing
  expect(stops()[1].getAttribute('aria-disabled')).toBe('true')
  await act(async () => stops()[1].click())
  expect(shows).toEqual([])
  await userEvent.click(stops()[0])
  expect(shows).toEqual(['park'])
  await draw('middle', 'park')
  expect(stops()[0].getAttribute('aria-pressed')).toBe('true')
  await userEvent.click(stops()[0])
  expect(shows).toEqual(['park', null])
})
