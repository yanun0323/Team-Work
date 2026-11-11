import { afterEach, describe, expect, it, vi } from 'vitest'
import { COVER_MS, coverIsland, FULL_INTRO, introFor, nextIntro, revealBoot, setPilot, SHORT_INTRO, travel } from './boot'

const storage = (value: string | null = null) => ({ getItem: vi.fn(() => value), setItem: vi.fn() })

describe('introFor', () => {
  it('plays the whole landing once, then the short one', () => {
    expect(introFor(false, false)).toBe(FULL_INTRO)
    expect(introFor(true, false)).toBe(SHORT_INTRO)
  })

  it('does not move the camera when motion is reduced', () => {
    expect(introFor(false, true)).toBeNull()
    expect(introFor(true, true)).toBeNull()
  })
})

describe('nextIntro', () => {
  it('remembers that the first landing has played', () => {
    const first = storage()
    expect(nextIntro(first, false)).toBe(FULL_INTRO)
    expect(first.setItem).toHaveBeenCalledOnce()
    expect(nextIntro(storage('1'), false)).toBe(SHORT_INTRO)
  })

  it('still starts when storage is unavailable', () => {
    const broken = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } }
    expect(nextIntro(broken, false)).toBe(FULL_INTRO)
  })
})

/** Just enough of a page for the startup screen: elements with ids, data attributes, children and events. */
function fakePage() {
  type El = {
    id: string; className: string; textContent: string; src: string; alt: string; dataset: Record<string, string>
    children: El[]; listeners: Record<string, Array<() => void>>; removed: boolean
    setAttribute: (k: string, v: string) => void; appendChild: (c: El) => El; remove: () => void
    addEventListener: (type: string, f: () => void) => void; dispatchEvent: (e: { type: string }) => boolean
  }
  const body: El[] = []
  const make = (): El => {
    const el: El = {
      id: '', className: '', textContent: '', src: '', alt: '', dataset: {}, children: [], listeners: {}, removed: false,
      setAttribute: () => {},
      appendChild: (c) => (el.children.push(c), c),
      remove: () => { el.removed = true; body.splice(body.indexOf(el), 1) },
      addEventListener: (type, f) => { (el.listeners[type] ??= []).push(f) },
      dispatchEvent: (e) => { const fs = el.listeners[e.type] ?? []; el.listeners[e.type] = []; fs.forEach((f) => f()); return true },
    }
    return el
  }
  const document = {
    createElement: make,
    getElementById: (id: string) => body.find((e) => e.id === id) ?? null,
    body: { appendChild: (c: El) => (body.push(c), c) },
  }
  return { document, body }
}

describe('coverIsland', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('changes the island only once the clouds have closed, and keeps them until the landing', () => {
    vi.useFakeTimers()
    const page = fakePage()
    vi.stubGlobal('document', page.document)
    vi.stubGlobal('Event', class { constructor(public type: string) {} })
    const swap = vi.fn()
    coverIsland(swap)
    const boot = page.document.getElementById('boot')!
    expect(boot.dataset.covering).toBe('1')
    expect(boot.children.filter((c) => c.className.startsWith('c'))).toHaveLength(21)
    // a plane flies across over the clouds while they wait
    expect(boot.children.find((c) => c.className === 'boot-plane')?.src).toBe('/boot/plane.svg')
    expect(swap).not.toHaveBeenCalled()

    // asked again while closing, it swaps along with the first, under the same clouds
    const again = vi.fn()
    coverIsland(again)
    expect(page.body).toHaveLength(1)

    vi.advanceTimersByTime(COVER_MS.motion)
    expect(swap).toHaveBeenCalledOnce()
    expect(again).toHaveBeenCalledOnce()
    expect(boot.dataset.covering).toBeUndefined()
    expect(boot.removed).toBe(false)

    // covered already: at once
    const third = vi.fn()
    coverIsland(third)
    expect(third).toHaveBeenCalledOnce()

    revealBoot('short')
    expect(boot.dataset.leaving).toBe('short')
    // going again while they part brings new clouds in
    const fourth = vi.fn()
    coverIsland(fourth)
    expect(boot.removed).toBe(true)
    expect(page.document.getElementById('boot')).not.toBe(boot)
    expect(fourth).not.toHaveBeenCalled()
    vi.advanceTimersByTime(COVER_MS.motion)
    expect(fourth).toHaveBeenCalledOnce()
  })

  it('swaps at once with no page', () => {
    const swap = vi.fn()
    coverIsland(swap)
    expect(swap).toHaveBeenCalledOnce()
  })
})

describe('travel', () => {
  afterEach(() => {
    setPilot(null)
    vi.unstubAllGlobals()
  })

  it('flies there when the scene can', () => {
    const pilot = vi.fn()
    setPilot(pilot)
    const swap = vi.fn()
    travel(swap)
    expect(pilot).toHaveBeenCalledWith(swap, false)
    travel(swap, true)
    expect(pilot).toHaveBeenLastCalledWith(swap, true)
    // the scene swaps once this island is out of sight, not before
    expect(swap).not.toHaveBeenCalled()
  })

  it('closes the clouds instead with no scene, or with reduced motion', () => {
    const swap = vi.fn()
    travel(swap)
    expect(swap).toHaveBeenCalledOnce()

    const pilot = vi.fn()
    setPilot(pilot)
    vi.stubGlobal('matchMedia', () => ({ matches: true }))
    const calm = vi.fn()
    travel(calm)
    expect(pilot).not.toHaveBeenCalled()
    expect(calm).toHaveBeenCalledOnce()
  })
})
