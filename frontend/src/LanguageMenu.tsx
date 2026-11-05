// The globe on the map's top right: another way to the language picked in the airport's settings.

import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Check } from './Controls'
import { htmlLang, tr } from './core/i18n'
import type { Locale } from './core/domain/types'
import { setLanguage } from './core/ops'
import { useStore } from './core/store'

export const LANGUAGES = ['zh', 'zh-Hans', 'en', 'ja', 'ko'] as const satisfies readonly Locale[]
/** Each language in its own words, whichever is showing. */
export const LANGUAGE_NAMES: Record<Locale, string> = { zh: '繁體中文', 'zh-Hans': '简体中文', en: 'English', ja: '日本語', ko: '한국어' }

export function LanguageMenu() {
  const language = useStore((s) => s.world.language)
  const act = useStore((s) => s.act)
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const items = useRef<Array<HTMLButtonElement | null>>([])

  useEffect(() => {
    if (!open) return
    items.current[LANGUAGES.indexOf(language)]?.focus()
    const away = (e: PointerEvent) => !root.current?.contains(e.target as Node) && setOpen(false)
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
    // the language changes only as the menu closes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const close = () => {
    setOpen(false)
    button.current?.focus()
  }
  const onKey = (e: KeyboardEvent) => {
    const at = items.current.indexOf(document.activeElement as HTMLButtonElement)
    const last = LANGUAGES.length - 1
    const to = { ArrowDown: at === last ? 0 : at + 1, ArrowUp: at <= 0 ? last : at - 1, Home: 0, End: last }[e.key]
    if (to !== undefined) items.current[to]?.focus()
    else if (e.key === 'Escape') close()
    else if (e.key === 'Tab') setOpen(false)
    else return
    if (e.key !== 'Tab') e.preventDefault()
    e.stopPropagation()
  }

  return (
    <div className="fx-language" ref={root} onKeyDown={open ? onKey : undefined}>
      <button ref={button} type="button" className="fx-settings-trigger fx-tag" aria-label={tr('語言')} aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen(!open)}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10" />
          <path d="M2 12h20" />
          <path d="M12 2a15 15 0 0 1 0 20a15 15 0 0 1 0-20" />
        </svg>
      </button>
      {open && (
        <div role="menu" aria-label={tr('語言')} className="fx-slip fx-language-menu">
          {LANGUAGES.map((l, i) => (
            <button key={l} ref={(el) => { items.current[i] = el }} type="button" role="menuitemradio" aria-checked={l === language} lang={htmlLang(l)}
              onClick={() => { if (l !== language) act((x) => void setLanguage(x, l)); close() }}>
              <span className="fx-slip-check">{l === language && <Check />}</span>
              {LANGUAGE_NAMES[l]}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
