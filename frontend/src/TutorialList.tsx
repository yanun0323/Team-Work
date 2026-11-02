// The tutorial list beside the clock: the next few steps to try. It is only on screen on the main map, so ticks and new
// steps wait for the user to come back to it.

import { useEffect, useRef } from 'react'
import { tr } from './core/i18n'
import { useStore } from './core/store'
import { playSound } from './sound'
import { listed, newlyMet, seed, tutorialOf, updateTutorial, type TutorialGoal } from './tutorial'

/** How many steps show at once; the rest wait their turn. */
export const ROWS = 5
/** The tick draws in, then the row fades and closes up; both are in fusion.css. */
const TICK_MS = 1000
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

  if (!ready || !t.seeded || t.hidden || shown.length === 0) return null
  return (
    <nav className="fx-tutorial fx-tag" aria-label={tr('教學')}>
      <ol>
        {shown.slice(0, ROWS).map((s) => {
          const done = t.done.includes(s.id)
          return (
            <li key={s.id} className={done ? 'fx-tutorial-done' : fresh.includes(s.id) ? 'fx-tutorial-new' : undefined}>
              <button type="button" className="fx-hit" disabled={done} onClick={() => onGo(s.goal)}>
                <svg className="fx-tutorial-mark" width="18" height="18" viewBox="0 0 14 14" aria-hidden="true">
                  {done && <circle className="fx-tutorial-burst" cx="7" cy="7" r="5.5" />}
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
