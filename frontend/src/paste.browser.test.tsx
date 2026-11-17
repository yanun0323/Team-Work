// The drawers pasting on and lifting off, in WebKit: through View Transitions where there are some, else as before.
import { act, useLayoutEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import './fusion.css'
import { canPaste, pasteIn, usePaste } from './paste'

let root: Root | null = null
let box: HTMLDivElement | null = null

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  box = document.createElement('div')
  box.style.cssText = 'position:relative;width:1000px;height:700px'
  document.body.append(box)
  root = createRoot(box)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  box?.remove()
  box = null
  vi.unstubAllGlobals()
})

function Sheet({ id, leaving, onGone }: { id: string; leaving: boolean; onGone: () => void }) {
  const paste = usePaste(leaving, onGone)
  return <aside data-id={id} className={leaving ? 'fx-drawer leaving' : 'fx-drawer'} {...paste}><div className="fx-sheet">{id}</div></aside>
}

/** Shows the sheet `shown`; one that goes away stays, leaving, until it says it is gone, as World.tsx does. */
function Host({ shown, gone }: { shown: string | null; gone: (id: string) => void }) {
  const [kept, setKept] = useState<string[]>(shown ? [shown] : [])
  if (shown && !kept.includes(shown)) setKept([...kept, shown])
  return kept.map((id) => (
    <Sheet key={id} id={id} leaving={id !== shown} onGone={() => { gone(id); setKept((k) => k.filter((x) => x !== id)) }} />
  ))
}

const show = (shown: string | null, gone: (id: string) => void = () => {}) => act(async () => root!.render(<Host shown={shown} gone={gone} />))

async function frames(n = 3) {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => requestAnimationFrame(r)) })
}

/** The animations running now on pictures of sheets, as `part:animation`. */
const pictures = () => document.documentElement.getAnimations({ subtree: true })
  .flatMap((a) => {
    const pseudo = (a.effect as KeyframeEffect | null)?.pseudoElement ?? ''
    const part = pseudo.match(/^::view-transition-(new|old)\(paste-\d+\)$/)?.[1]
    return part ? [`${part}:${(a as CSSAnimation).animationName}`] : []
  })
  .sort()

const sheet = (id: string) => document.querySelector<HTMLElement>(`[data-id="${id}"]`)
const named = (el: HTMLElement | null) => el?.style.getPropertyValue('view-transition-name') ?? ''

// the transition's end: no pictures left, and a little after for its promise
async function settle() {
  for (let i = 0; i < 120 && document.documentElement.getAnimations({ subtree: true }).length; i++) await frames(1)
  await frames(2)
}

it('pastes a sheet on as a picture, then leaves the sheet as it was', async () => {
  expect(canPaste()).toBe(true)
  await show('a')
  await frames()
  expect(pictures()).toEqual(['new:fx-paste'])
  // the sheet itself does not animate, which is what made WebKit paint it every frame
  expect(sheet('a')!.getAnimations()).toEqual([])
  await settle()
  expect(pictures()).toEqual([])
  expect(named(sheet('a'))).toBe('')
  expect(getComputedStyle(sheet('a')!).opacity).toBe('1')
})

/** Puts the sheet on the page inside a transition once `open`, as World.tsx does for one coming from nothing. */
function Opener({ open }: { open: boolean }) {
  const [shown, setShown] = useState(false)
  useLayoutEffect(() => { if (open && !shown) pasteIn(() => setShown(true)) }, [open, shown])
  return shown ? <Sheet id="a" leaving={false} onGone={() => {}} /> : null
}

it('pastes on a sheet put on the page inside the transition, never drawn before its picture', async () => {
  // every value data-paste has had
  const values: string[] = []
  const watch = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'attributes') values.push(r.oldValue ?? '', (r.target as HTMLElement).dataset.paste ?? '')
      for (const n of r.addedNodes) if (n instanceof HTMLElement && n.dataset.paste !== undefined) values.push(n.dataset.paste)
    }
  })
  watch.observe(box!, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-paste'], attributeOldValue: true })
  await act(async () => root!.render(<Opener open />))
  // not on the page until the transition makes its changes
  expect(sheet('a')).toBeNull()
  await frames()
  expect(sheet('a')).not.toBeNull()
  expect(pictures()).toEqual(['new:fx-paste'])
  await settle()
  watch.disconnect()
  expect(values).not.toContain('waiting')
  expect(named(sheet('a'))).toBe('')
})

it('lifts a closed sheet off as a picture and takes it off the page once', async () => {
  const gone = vi.fn()
  await show('a', gone)
  await settle()
  await show(null, gone)
  await frames()
  expect(pictures()).toEqual(['old:fx-unpaste'])
  expect(sheet('a')).toBeNull()
  await settle()
  expect(gone).toHaveBeenCalledTimes(1)
  expect(gone).toHaveBeenCalledWith('a')
})

it('lifts one sheet off and pastes the next on in the same transition', async () => {
  const gone = vi.fn()
  await show('a', gone)
  await settle()
  await show('b', gone)
  await frames()
  expect(pictures()).toEqual(['new:fx-paste', 'old:fx-unpaste'])
  await settle()
  expect(gone).toHaveBeenCalledTimes(1)
  expect(sheet('a')).toBeNull()
  expect(sheet('b')).not.toBeNull()
  expect(named(sheet('b'))).toBe('')
})

it('animates the sheet itself where there are no View Transitions', async () => {
  const start = Document.prototype.startViewTransition
  // @ts-expect-error taken away for this test
  delete Document.prototype.startViewTransition
  try {
    expect(canPaste()).toBe(false)
    const gone = vi.fn()
    await show('a', gone)
    expect(sheet('a')!.getAnimations().map((a) => (a as CSSAnimation).animationName)).toEqual(['fx-paste'])
    await settle()
    await show(null, gone)
    expect(sheet('a')!.getAnimations().map((a) => (a as CSSAnimation).animationName)).toEqual(['fx-unpaste'])
    await settle()
    expect(gone).toHaveBeenCalledTimes(1)
    expect(sheet('a')).toBeNull()
  } finally {
    Document.prototype.startViewTransition = start
  }
})
