// The app's name with the time and date, in the corner of the main screen.

import { useEffect, useState } from 'react'
import { useStore } from './core/store'
import type { Locale } from './core/domain/types'

export function clockText(now: Date, locale: Locale) {
  const tag = locale === 'zh' ? 'zh-TW' : 'en-US'
  return {
    time: new Intl.DateTimeFormat(tag, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now),
    date: new Intl.DateTimeFormat(tag, { year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }).format(now),
  }
}

export function Brand() {
  const locale = useStore((s) => s.world.language)
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(timer)
  }, [])
  const { time, date } = clockText(now, locale)
  return (
    <div className="fx-brand fx-tag">
      <h1>Team Work</h1>
      <p><time dateTime={now.toISOString()}>{time}　{date}</time></p>
    </div>
  )
}
