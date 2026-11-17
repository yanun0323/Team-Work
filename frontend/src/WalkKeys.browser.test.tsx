// The keys in the corner that walk the user, in WebKit: lit from the keyboard and by the pointer, not while typing.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import './fusion.css'
import { WalkKeys } from './WalkKeys'
import { useWalk, useWalkKeys } from './walkByHand'

let root: Root | null = null
let box: HTMLDivElement | null = null

function Keys({ on }: { on: boolean }) {
  useWalkKeys(on)
  return (
    <>
      <input aria-label="name" />
      <WalkKeys />
    </>
  )
}

async function show(on = true) {
  if (!box) {
    box = document.createElement('div')
    document.body.append(box)
    root = createRoot(box)
  }
  await act(async () => root?.render(<Keys on={on} />))
}

const lit = () => [...document.querySelectorAll('.fx-walk-key[data-lit]')].map((b) => b.textContent)
const press = (code: string, type: 'keydown' | 'keyup' = 'keydown', at: EventTarget = window, extra: KeyboardEventInit = {}) =>
  act(() => void at.dispatchEvent(new KeyboardEvent(type, { code, key: code.slice(3).toLowerCase(), bubbles: true, ...extra })))

beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true))

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  box?.remove()
  box = null
  vi.unstubAllGlobals()
})

it('lights the keys held on the keyboard, and lets them all go when walking ends', async () => {
  await show()
  expect(document.querySelector('.fx-walk-keys')?.hasAttribute('data-idle')).toBe(true)
  await press('KeyW')
  await press('KeyD')
  expect(lit()).toEqual(['W', 'D'])
  expect(document.querySelector('.fx-walk-keys')?.hasAttribute('data-idle')).toBe(false)
  await press('KeyW', 'keyup')
  expect(lit()).toEqual(['D'])
  await show(false)
  expect(lit()).toEqual([])
})

it('leaves the keys to typing, and to shortcuts', async () => {
  await show()
  const input = document.querySelector('input') as HTMLInputElement
  await act(() => input.focus())
  expect(document.querySelector('.fx-walk-keys')?.hasAttribute('data-typing')).toBe(true)
  await press('KeyA', 'keydown', input)
  expect(lit()).toEqual([])
  await act(() => input.blur())
  expect(document.querySelector('.fx-walk-keys')?.hasAttribute('data-typing')).toBe(false)
  await press('KeyS', 'keydown', window, { metaKey: true })
  expect(lit()).toEqual([])
  await press('KeyS')
  await press('KeyD', 'keydown', window, { metaKey: true })
  // ⌘ lets go of what was held: macOS sends no key-up for it
  expect(lit()).toEqual([])
})

it('claims the walking keys, so the Mac app does not beep, but leaves typing and shortcuts alone', async () => {
  await show()
  // dispatchEvent answers false when a listener called preventDefault
  const kept = (code: string, at: EventTarget = window, extra: KeyboardEventInit = {}) => {
    let free = true
    act(() => void (free = at.dispatchEvent(new KeyboardEvent('keydown', { code, key: code.slice(3).toLowerCase(), bubbles: true, cancelable: true, ...extra }))))
    return !free
  }
  expect(kept('KeyW')).toBe(true)
  expect(kept('KeyW', window, { repeat: true })).toBe(true)
  expect(kept('KeyQ')).toBe(false)
  expect(kept('KeyW', window, { metaKey: true })).toBe(false)
  const input = document.querySelector('input') as HTMLInputElement
  await act(() => input.focus())
  expect(kept('KeyW', input)).toBe(false)
})

it('walks while a key on the screen is held with the pointer', async () => {
  await show()
  const s = [...document.querySelectorAll<HTMLButtonElement>('.fx-walk-key')].find((b) => b.textContent === 'S') as HTMLButtonElement
  const at = s.getBoundingClientRect()
  const pointer = (type: string) => new PointerEvent(type, { pointerId: 1, bubbles: true, clientX: at.x + 5, clientY: at.y + 5, isPrimary: true })
  await act(() => void s.dispatchEvent(pointer('pointerdown')))
  expect(lit()).toEqual(['S'])
  expect(useWalk.getState().taps).toEqual(['s'])
  await act(() => void s.dispatchEvent(pointer('pointerup')))
  expect(lit()).toEqual([])
})
