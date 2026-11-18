import { useRef, useState, type KeyboardEvent } from 'react'
import { version } from '../package.json'
import { useStore } from './core/store'
import { tr } from './core/i18n'
import { Markdown } from './Markdown'
import { notesIn, RELEASES } from './releaseNotesText'

export default function ReleaseNotes() {
  const locale = useStore((s) => s.world.language)
  const [picked, setPicked] = useState(() => (RELEASES.some((r) => r.version === version) ? version : RELEASES[0]?.version))
  const tabs = useRef<Array<HTMLButtonElement | null>>([])
  const at = Math.max(0, RELEASES.findIndex((r) => r.version === picked))
  const shown = RELEASES[at]

  // up and down move between versions, as in the help
  const onTabKey = (e: KeyboardEvent) => {
    const next = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: RELEASES.length - 1 }[e.key]
    if (next === undefined || !RELEASES.length) return
    e.preventDefault()
    const j = (next + RELEASES.length) % RELEASES.length
    setPicked(RELEASES[j].version)
    tabs.current[j]?.focus()
  }

  return shown ? (
    <div className="fx-help-body">
      <nav className="fx-help-nav" aria-label={tr('版本')} onKeyDown={onTabKey}>
        {RELEASES.map((r, i) => (
          <button key={r.version} ref={(el) => void (tabs.current[i] = el)} type="button" aria-current={r.version === shown.version ? 'page' : undefined}
            aria-controls="fx-notes-panel" onClick={() => setPicked(r.version)}>
            v{r.version}
          </button>
        ))}
      </nav>
      {/* keyed, so each version turns in like a fresh page */}
      <section key={shown.version} id="fx-notes-panel" className="fx-page fx-help-page fx-notes-page" aria-labelledby="fx-notes-version">
        <h2 id="fx-notes-version">v{shown.version}</h2>
        <Markdown text={notesIn(shown, locale)} />
      </section>
    </div>
  ) : (
    <p className="fx-help-page">{tr('還沒有更新內容')}</p>
  )
}
