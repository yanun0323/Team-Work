// How the drawers (.fx-drawer) come and go: pasted onto the map, and lifted off it again.
//
// Both are View Transitions: the browser draws the sheet as a picture and moves the picture (fusion.css,
// `::view-transition-new(*.paste-in)` and `::view-transition-old(*.paste-out)`). As a CSS animation on the sheet itself, WebKit
// painted the whole sheet again every frame, which on a big window held up opening a company for a good part of a
// second. Only the sheets take part: the rest of the page, the island too, goes on being drawn as it is
// (`:root { view-transition-name: none }`).
//
// Where View Transitions or their classes are missing, the CSS animations on .fx-drawer play as before; with reduced
// motion, neither does.

import { useLayoutEffect, useRef, useState, type AnimationEvent } from 'react'
import { flushSync } from 'react-dom'

/** Whether sheets come and go through View Transitions here. */
export function canPaste(): boolean {
  if (typeof document === 'undefined' || !('startViewTransition' in document)) return false
  if (typeof CSS === 'undefined' || !CSS.supports('view-transition-class', 'paste')) return false
  return !(typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches)
}

// The transition about to start, and the changes it will make: sheets that come and go together, as when one drawer
// gives way to another, go in one transition, since starting a second would cut the first short.
let pending: { updates: Array<() => void>; done: Promise<void> } | null = null
// the transition whose changes are being made right now, so a sheet put on the page by them knows it is in one
let making: Promise<void> | null = null
let count = 0

/** Makes `update` in a View Transition, with any others asked for before it starts; resolves once it is over. */
function transition(update: () => void): Promise<void> {
  if (pending) {
    pending.updates.push(update)
    return pending.done
  }
  const updates = [update]
  let done: Promise<void> = Promise.resolve()
  const t = document.startViewTransition(() => {
    pending = null
    making = done
    try {
      flushSync(() => { for (const u of updates) u() })
    } finally {
      making = null
    }
  })
  // a transition cut short by another still makes its changes; only the animation is lost
  done = t.finished.catch(() => {})
  pending = { updates, done }
  return done
}

/**
 * Puts a sheet on the page in a View Transition, by `update`: from nothing, the cheaper way, as the page is not drawn
 * again until the picture of the sheet can paste it on. A sheet already on the page when it starts is drawn once
 * unseen, then once more for its picture; on a big window that cost a good part of what the transition saves.
 */
export function pasteIn(update: () => void) {
  void transition(update)
}

/** Whether a transition's changes are being made right now: what is put on the page now is pasted on by it. */
export const inPaste = () => making !== null

/**
 * Gives `el` a name of its own for a transition, so it is drawn as a picture, and says which way it goes; `false` takes
 * it away again. A class each way, as WebKit runs the animations of both pictures of a named sheet even when one of
 * them is missing, and waits for them: a sheet going waited out the 560ms paste of a picture that was never there.
 */
function name(el: HTMLElement, way: 'in' | 'out' | false) {
  if (way) {
    el.style.setProperty('view-transition-name', `paste-${++count}`)
    el.style.setProperty('view-transition-class', `paste-${way}`)
  } else {
    el.style.removeProperty('view-transition-name')
    el.style.removeProperty('view-transition-class')
  }
}

/**
 * Props for a drawer's <aside>: it pastes itself on as it mounts and lifts off once `leaving`, then calls `onGone`.
 * Whether it goes through View Transitions is settled as it mounts, so it leaves the way it came.
 */
export function usePaste(leaving: boolean, onGone: () => void) {
  const ref = useRef<HTMLElement>(null)
  const [vt] = useState(canPaste)
  const gone = useRef(onGone)
  gone.current = onGone

  // coming: put on the page by a transition (pasteIn), it only needs a name for its picture; else unseen until a
  // transition of its own shows the picture (still there for focus). Itself again once it is on.
  useLayoutEffect(() => {
    const el = ref.current
    if (!vt || !el) return
    const on = () => { if (!el.matches('.leaving')) name(el, false) }
    el.dataset.paste = ''
    if (making) {
      name(el, 'in')
      void making.then(on)
      return
    }
    el.dataset.paste = 'waiting'
    void transition(() => {
      el.dataset.paste = ''
      name(el, 'in')
    }).then(on)
  }, [vt])

  // going: drawn as it is, then taken off the page, its picture lifting off
  useLayoutEffect(() => {
    const el = ref.current
    if (!vt || !leaving || !el) return
    el.dataset.paste = ''
    name(el, 'out')
    void transition(() => gone.current())
  }, [vt, leaving])

  return {
    ref,
    // without View Transitions, the CSS animation ending is the sign it is off
    onAnimationEnd: (e: AnimationEvent) => { if (leaving && !vt && e.target === e.currentTarget) onGone() },
  }
}
