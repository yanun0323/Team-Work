// useStickToBottom on a real list in WebKit, the engine of the macOS app, so its layout, clamping and scroll events
// are the browser's own.
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import '../fusion.css'
import { useStickToBottom } from './model'

let root: Root | null = null
let box: HTMLDivElement | null = null
afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  box?.remove()
  box = null
  vi.unstubAllGlobals()
})

type Rows = { above: number[]; lines: number[]; below: number; loading: boolean }
let set: (f: (r: Rows) => Rows) => void = () => {}
let pin: (smooth?: boolean) => void = () => {}

function List({ first }: { first: Rows }) {
  const [rows, setRows] = useState(first)
  set = setRows
  const [ref, p] = useStickToBottom<HTMLOListElement>(rows)
  pin = p
  return (
    <ol ref={ref} style={{ height: 400, overflowY: 'auto', margin: 0, padding: '6px 4px', listStyle: 'none' }}>
      {rows.loading && <li data-scroll-skip style={{ height: 30 }}>loading</li>}
      {[...rows.above, ...rows.lines].map((h) => <li key={h} data-row={h} style={{ height: 100 }}>{h}</li>)}
      {rows.below > 0 && <li data-row="below" style={{ height: rows.below }} />}
    </ol>
  )
}

async function mount(lines = 20, below = 0) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  box = document.createElement('div')
  document.body.append(box)
  root = createRoot(box)
  await act(async () => root!.render(<List first={{ above: [], lines: Array.from({ length: lines }, (_, i) => i), below, loading: false }} />))
  await frames()
}

const frames = () => act(async () => { await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))) })
const change = async (f: (r: Rows) => Rows) => { await act(async () => set(f)); await frames() }
const el = () => box!.querySelector('ol')!
const gap = () => el().scrollHeight - el().scrollTop - el().clientHeight
const at = (row: string | number) => box!.querySelector(`[data-row="${row}"]`)!.getBoundingClientRect().top - el().getBoundingClientRect().top
const fire = (type: string, init: object) => el().dispatchEvent(Object.assign(new Event(type, { bubbles: true }), init))
async function scroll(by: number) {
  el().scrollTop += by
  await frames()
}

it('stays at the bottom when a row above comes and goes while the reply grows', async () => {
  await mount()
  expect(gap()).toBeLessThan(1)
  await change((r) => ({ ...r, loading: true, below: 130 }))
  expect(gap()).toBeLessThan(1)
  await change((r) => ({ ...r, loading: false, below: 180 }))
  expect(gap()).toBeLessThan(1)
})

it('lets the list stay where the reader scrolled up to', async () => {
  await mount()
  fire('wheel', { deltaY: -300 })
  await scroll(-300)
  const top = at(14)
  await change((r) => ({ ...r, below: 50 }))
  expect(Math.abs(at(14) - top)).toBeLessThan(1)
  expect(Math.abs(gap() - 350)).toBeLessThan(1)
})

it('stops following the moment the reader scrolls up, however little, while a reply streams in', async () => {
  await mount()
  // a nudge up on the trackpad: a few pixels, well short of what reads as away from the bottom
  fire('wheel', { deltaY: -5 })
  await scroll(-5)
  await change((r) => ({ ...r, below: 50 }))
  expect(Math.abs(gap() - 55)).toBeLessThan(1)
})

it('stops following when the reader goes up by key or by finger', async () => {
  for (const up of [
    () => fire('keydown', { key: 'ArrowUp' }),
    () => { fire('touchstart', { touches: [{ clientY: 100 }] }); fire('touchmove', { touches: [{ clientY: 104 }] }) },
  ]) {
    await mount()
    up()
    await scroll(-4)
    await change((r) => ({ ...r, below: 50 }))
    expect(Math.abs(gap() - 54)).toBeLessThan(1)
    await act(async () => root?.unmount())
    box?.remove()
  }
})

it('follows again once the reader scrolls back down to the bottom', async () => {
  await mount()
  fire('wheel', { deltaY: -40 })
  await scroll(-40)
  fire('wheel', { deltaY: 30 })
  await scroll(30)
  await change((r) => ({ ...r, below: 50 }))
  expect(gap()).toBeLessThan(1)
})

it('keeps following after a scroll up on a list too short to scroll', async () => {
  await mount(3)
  fire('wheel', { deltaY: -20 })
  await change((r) => ({ ...r, below: 250 }))
  expect(gap()).toBeLessThan(1)
})

it('keeps following what arrives while a smooth scroll heads down to the bottom', async () => {
  await mount()
  fire('wheel', { deltaY: -300 })
  await scroll(-300)
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  await act(async () => pin(true))
  // part way down, more of the reply comes in
  await change((r) => ({ ...r, below: 50 }))
  for (let i = 0; i < 60 && gap() > 1; i++) await frames()
  expect(gap()).toBeLessThan(1)
})

it('holds the reader in place when what is below them goes away', async () => {
  await mount(20, 600)
  fire('wheel', { deltaY: -100 })
  await scroll(-100)
  const top = at(19)
  // a reply being written ends; the message it becomes is not in yet
  await change((r) => ({ ...r, below: 0 }))
  expect(Math.abs(at(19) - top)).toBeLessThan(1)
  await change((r) => ({ ...r, below: 600 }))
  expect(Math.abs(at(19) - top)).toBeLessThan(1)
  // the blank space it took is gone once the rows fill it again
  fire('wheel', { deltaY: 100 })
  await scroll(10000)
  expect(Math.abs(at('below') + 600 - (el().clientHeight - 6))).toBeLessThan(1)
})

it('holds the reader in place as rows come in above, under a row that stays first', async () => {
  await mount()
  fire('wheel', { deltaY: -1000 })
  el().scrollTop = 0
  await frames()
  await change((r) => ({ ...r, loading: true }))
  const top = at(0)
  await change((r) => ({ ...r, loading: false, above: [-3, -2, -1] }))
  expect(Math.abs(at(0) - top)).toBeLessThan(1)
  expect(Math.abs(at(-1) - (top - 100))).toBeLessThan(1)
})
