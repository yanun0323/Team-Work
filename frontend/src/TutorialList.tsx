// The tutorial list beside the clock: the next few steps to try. It is only on screen on the main map, so ticks and new
// steps wait for the user to come back to it.

import { useEffect, useRef, useState } from 'react'
import { tr } from './core/i18n'
import { useStore } from './core/store'
import { playSound } from './sound'
import { listed, newlyMet, seed, tutorialOf, updateTutorial, type TutorialGoal } from './tutorial'

/** How many rows show at rest, and when the list is opened up. */
export const ROWS = 3
export const OPEN_ROWS = 8
/** The pointer has to rest this long before the list opens, so passing over it does nothing. */
const OPEN_DELAY = 150
/** The tick draws in, then the row fades and closes up; both are in fusion.css. */
const TICK_MS = 900
/** A new step slides in; it counts as seen once it has. */
const SLIDE_MS = 450
/** One cue for what comes in one go: a tick and the steps it lets in. */
const CUE_GAP = 2500

export function TutorialList({ onGo }: { onGo: (goal: TutorialGoal) => void }) {
  const w = useStore((s) => s.world)
  const ready = useStore((s) => s.loaded && !s.offline)
  const t = tutorialOf(w)
  const { items, quiet } = listed(t)
  const ticking = items.filter((s) => t.done.includes(s.id)).map((s) => s.id)
  // new steps come in once the ticks have gone
  const shown = ticking.length ? items.filter((s) => t.shown.includes(s.id)) : items
  const fresh = shown.filter((s) => !t.shown.includes(s.id)).map((s) => s.id)
  const met = ready && t.seeded ? newlyMet(w, t) : []

  const [open, setOpen] = useState(false)
  const list = useRef<HTMLOListElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const cued = useRef(0)
  const cue = () => {
    if (Date.now() - cued.current > CUE_GAP) playSound('soundTutorial')
    cued.current = Date.now()
  }

  // the first run puts down what an old hand has done already, without a tick
  useEffect(() => {
    if (ready && !t.seeded) updateTutorial(seed(w, t))
  }, [ready, t.seeded]) // eslint-disable-line react-hooks/exhaustive-deps

  const metKey = met.join()
  useEffect(() => {
    if (metKey) updateTutorial({ done: metKey.split(',') })
  }, [metKey])

  // done before it was ever shown: there was nothing on screen to cross off
  const quietKey = quiet.join()
  useEffect(() => {
    if (quietKey) updateTutorial({ played: quietKey.split(','), shown: quietKey.split(',') })
  }, [quietKey])

  const tickKey = ticking.join()
  useEffect(() => {
    if (!tickKey || t.hidden) return
    cue()
    const done = setTimeout(() => updateTutorial({ played: tickKey.split(',') }), TICK_MS)
    return () => clearTimeout(done)
  }, [tickKey, t.hidden]) // eslint-disable-line react-hooks/exhaustive-deps

  const freshKey = fresh.join()
  useEffect(() => {
    if (!freshKey || !t.seeded || t.hidden) return
    cue()
    const seen = setTimeout(() => updateTutorial({ shown: freshKey.split(',') }), SLIDE_MS)
    return () => clearTimeout(seen)
  }, [freshKey, t.seeded, t.hidden]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => clearTimeout(timer.current), [])
  // closing goes back to the top, where the next step is
  useEffect(() => {
    if (!open && list.current) list.current.scrollTop = 0
  }, [open])

  if (!ready || !t.seeded || t.hidden || shown.length === 0) return null
  const enter = () => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setOpen(true), OPEN_DELAY)
  }
  const leave = () => {
    clearTimeout(timer.current)
    setOpen(false)
  }
  return (
    <nav className={open ? 'fx-tutorial fx-tag fx-tutorial-open' : 'fx-tutorial fx-tag'} aria-label={tr('教學')}
      onMouseEnter={enter} onMouseLeave={leave}
      onFocus={() => { clearTimeout(timer.current); setOpen(true) }}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false) }}>
      <ol ref={list}>
        {shown.map((s, i) => {
          const done = t.done.includes(s.id)
          return (
            <li key={s.id} className={done ? 'fx-tutorial-done' : fresh.includes(s.id) ? 'fx-tutorial-new' : undefined}>
              <button type="button" className="fx-hit" disabled={done} tabIndex={open || i < ROWS ? undefined : -1} onClick={() => onGo(s.goal)}>
                <svg className="fx-tutorial-mark" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
                  <circle cx="7" cy="7" r="5.5" />
                  {done && <path d="M4.2 7.2 6.2 9.1 9.9 5" />}
                </svg>
                <span>{tr(s.text)}</span>
              </button>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
