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
function list() {
  const scrolls: (() => void)[] = []
  let top = 600
  const el = {
    scrollHeight: 1000, clientHeight: 400,
    get scrollTop() { return top },
    set scrollTop(v: number) { top = Math.max(0, Math.min(v, el.scrollHeight - el.clientHeight)) },
    addEventListener: (type: string, f: () => void) => { if (type === 'scroll') scrolls.push(f) },
    removeEventListener: () => {},
  }
  return { el, scroll: () => scrolls.forEach((f) => f()), gap: () => el.scrollHeight - el.scrollTop - el.clientHeight }
}

async function harness(el: object) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('requestAnimationFrame', (f: () => void) => { f(); return 0 })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
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
  function View({ dep }: { dep: number }) {
    const [ref] = useStickToBottom<HTMLElement>(dep)
    ref.current = el as HTMLElement
    return null
  }
  return {
    render: async (dep: number) => { await act(async () => { root.render(<View dep={dep} />) }) },
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
