// Dev builds only: a strip in the bottom left corner to put the town at any time of day.

import { useEffect, useState } from 'react'
import { tr, type Key } from './core/i18n'
import { debugDaylight, phaseOf, SCENES } from './daylight'
import { usePrefs } from './prefs'

const MINUTES = 24 * 60
const NAMES: Record<keyof typeof SCENES, Key> = { dawn: '清晨', noon: '正午', dusk: '黃昏', midnight: '午夜' }

const clock = (phase: number) => {
  const m = Math.round(phase * MINUTES) % MINUTES
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

export function DaylightDebug() {
  const daylight = usePrefs((s) => s.daylight)
  const [picked, setPicked] = useState<number | null>(debugDaylight.phase)
  // while following the preference, the slider shows where the day is now
  const [, tick] = useState(0)
  useEffect(() => {
    if (picked !== null) return
    const id = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [picked])
  const pick = (phase: number | null) => {
    debugDaylight.phase = phase
    setPicked(phase)
  }
  const phase = picked ?? phaseOf(daylight, new Date())
  return (
    <div className="fx-daylight-debug fx-tag" role="group" aria-label={tr('時間')}>
      <button type="button" aria-pressed={picked === null} onClick={() => pick(null)}>{tr('依設定')}</button>
      {(Object.keys(SCENES) as (keyof typeof SCENES)[]).map((k) => (
        <button key={k} type="button" aria-pressed={picked === SCENES[k]} onClick={() => pick(SCENES[k])}>{tr(NAMES[k])}</button>
      ))}
      <input type="range" min={0} max={MINUTES - 1} step={1} value={Math.round(phase * MINUTES) % MINUTES} aria-label={tr('時間')}
        aria-valuetext={clock(phase)} onChange={(e) => pick(Number(e.target.value) / MINUTES)} />
      <output>{clock(phase)}</output>
    </div>
  )
}
