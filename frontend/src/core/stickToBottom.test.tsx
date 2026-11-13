import { act, createRoot } from '@react-three/fiber'
import type { WebGLRenderer } from 'three'
import { afterEach, expect, it, vi } from 'vitest'
import { useStickToBottom } from './model'

const roots: ReturnType<typeof createRoot>[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => { root.unmount() })
  vi.unstubAllGlobals()
})

// A scrolling list without layout: the test says how tall its content is and when the browser scrolls it.
function list(scrollHeight = 1000) {
  const heard: Record<string, ((e: object) => void)[]> = {}
  let top = scrollHeight - 400
  const el = {
    scrollHeight, clientHeight: 400,
    get scrollTop() { return top },
    set scrollTop(v: number) { top = Math.max(0, Math.min(v, el.scrollHeight - el.clientHeight)) },
    // a smooth scroll the test plays out itself, step by step
    scrollTo: vi.fn(),
    addEventListener: (type: string, f: (e: object) => void) => { (heard[type] ??= []).push(f) },
    removeEventListener: () => {},
  }
  const fire = (type: string, e: object = {}) => (heard[type] ?? []).forEach((f) => f({ target: el, ...e }))
  return { el, fire, scroll: () => fire('scroll'), gap: () => el.scrollHeight - el.scrollTop - el.clientHeight }
}

async function harness(el: object) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('requestAnimationFrame', (f: () => void) => { f(); return 0 })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('addEventListener', () => {})
  vi.stubGlobal('removeEventListener', () => {})
  const changed: (() => void)[] = []
  vi.stubGlobal('MutationObserver', class {
    constructor(f: () => void) { changed.push(f) }
    observe() {}
    disconnect() {}
  })
  const canvas = {} as HTMLCanvasElement
  const gl = { render: vi.fn(), setSize: vi.fn(), setPixelRatio: vi.fn(), domElement: canvas } as unknown as WebGLRenderer
  const root = createRoot(canvas)
  roots.push(root)
  await root.configure({ gl, frameloop: 'never', size: { width: 1, height: 1, top: 0, left: 0 } })
  let pin: (smooth?: boolean) => void = () => {}
  function View({ dep }: { dep: number }) {
    const [ref, p] = useStickToBottom<HTMLElement>(dep)
    ref.current = el as HTMLElement
    pin = p
    return null
  }
  return {
    render: async (dep: number) => { await act(async () => { root.render(<View dep={dep} />) }) },
    pin: (smooth?: boolean) => pin(smooth),
    // what a commit that changes the list's lines tells its observers
    change: () => changed.forEach((f) => f()),
  }
}

it('stays at the bottom when a row above shifts the list and the browser scrolls it to keep its place', async () => {
  const l = list()
  const h = await harness(l.el)
  await h.render(0)
  expect(l.gap()).toBe(0)
  // a "loading" row goes away above while the reply grows below; scroll anchoring moves scrollTop and fires scroll
  l.el.scrollHeight += 130
  l.el.scrollTop -= 33
  h.change()
  l.scroll()
  l.el.scrollHeight += 50
  await h.render(1)
  expect(l.gap()).toBe(0)
})

it('lets the list stay where the reader scrolled up to', async () => {
  const l = list()
  const h = await harness(l.el)
  await h.render(0)
  l.el.scrollTop -= 300
  l.scroll()
  l.el.scrollHeight += 50
  h.change()
  await h.render(1)
  expect(l.gap()).toBe(350)
})

it('stops following the moment the reader scrolls up, however little, while a reply streams in', async () => {
  const l = list()
  const h = await harness(l.el)
  await h.render(0)
  // a nudge up on the trackpad: a few pixels, well short of what reads as away from the bottom
  l.fire('wheel', { deltaY: -5 })
  l.el.scrollTop -= 5
  l.scroll()
  l.el.scrollHeight += 50
  h.change()
  await h.render(1)
  expect(l.gap()).toBe(55)
})

it('stops following when the reader goes up by key or by finger', async () => {
  for (const up of [
    (l: ReturnType<typeof list>) => l.fire('keydown', { key: 'ArrowUp' }),
    (l: ReturnType<typeof list>) => { l.fire('touchstart', { touches: [{ clientY: 100 }] }); l.fire('touchmove', { touches: [{ clientY: 104 }] }) },
  ]) {
    const l = list()
    const h = await harness(l.el)
    await h.render(0)
    up(l)
    l.el.scrollTop -= 4
    l.scroll()
    l.el.scrollHeight += 50
    h.change()
    await h.render(1)
    expect(l.gap()).toBe(54)
  }
})

it('follows again once the reader scrolls back down to the bottom', async () => {
  const l = list()
  const h = await harness(l.el)
  await h.render(0)
  l.fire('wheel', { deltaY: -40 })
  l.el.scrollTop -= 40
  l.scroll()
  l.fire('wheel', { deltaY: 30 })
  l.el.scrollTop += 30
  l.scroll()
  l.el.scrollHeight += 50
  h.change()
  await h.render(1)
  expect(l.gap()).toBe(0)
})

it('keeps following after a scroll up on a list too short to scroll', async () => {
  const l = list(400)
  const h = await harness(l.el)
  await h.render(0)
  l.fire('wheel', { deltaY: -20 })
  l.el.scrollHeight += 150
  h.change()
  await h.render(1)
  expect(l.gap()).toBe(0)
})

it('keeps following what arrives while a smooth scroll heads down to the bottom', async () => {
  const l = list()
  const h = await harness(l.el)
  await h.render(0)
  l.fire('wheel', { deltaY: -300 })
  l.el.scrollTop -= 300
  l.scroll()
  h.pin(true)
  expect(l.el.scrollTo).toHaveBeenCalled()
  // part way down, more of the reply comes in
  l.el.scrollTop += 100
  l.scroll()
  l.el.scrollHeight += 50
  h.change()
  await h.render(1)
  expect(l.gap()).toBe(0)
})
