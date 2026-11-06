// Following someone on the island when the map is left alone: after a while on the main screen with no click, drag,
// wheel or key, the camera starts following; the next one stops it, and a click still does what it does. No React.

/** What counts as the player's hands on the map. */
const INPUTS = ['pointerdown', 'wheel', 'keydown'] as const
/** How often the wait is checked, in milliseconds. */
const CHECK_MS = 1000

export interface IdleWatch {
  dispose: () => void
}

/**
 * Listens on `target` (the window) before anything else does. Each input starts the wait again; while following, it
 * also stops following. A press goes on through, so a click on something answers at once; `stop` is told it was a
 * press, to keep it from dragging the view on its way back. A wheel on the map (`onMap`) goes no further, so it doesn't
 * zoom it. The wait runs only while `canStart`, and not at all while `seconds` is 0.
 */
export function watchIdle(target: EventTarget, o: {
  seconds: () => number
  canStart: () => boolean
  following: () => boolean
  start: () => void
  stop: (e: Event) => void
  onMap: (e: Event) => boolean
}): IdleWatch {
  let last = Date.now()
  const input = (e: Event) => {
    last = Date.now()
    if (!o.following()) return
    o.stop(e)
    if (e.type !== 'wheel' || !o.onMap(e)) return
    e.stopPropagation()
    e.preventDefault()
  }
  const listen = { capture: true, passive: false }
  for (const type of INPUTS) target.addEventListener(type, input, listen)
  const timer = setInterval(() => {
    const seconds = o.seconds()
    if (!seconds || !o.canStart()) last = Date.now()
    else if (!o.following() && Date.now() - last >= seconds * 1000) o.start()
  }, CHECK_MS)
  return {
    dispose: () => {
      clearInterval(timer)
      for (const type of INPUTS) target.removeEventListener(type, input, listen)
    },
  }
}
