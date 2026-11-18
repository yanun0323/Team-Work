import { tr } from './core/i18n'
import LICENSE from '../../LICENSE?raw'
import { SOCIAL_ICONS } from './socialIcons'
import { VERSION } from './update'

const LINKS = [
  { label: 'GitHub', href: 'https://github.com/yanun0323/Team-Work' },
  { label: 'Buy Me a Coffee', href: 'https://buymeacoffee.com/yanun' },
]
// a new issue on GitHub, its body ending with the version so reports say which build they came from
const ISSUE_URL = `https://github.com/yanun0323/Team-Work/issues/new?body=${encodeURIComponent(`\n\n---\n${VERSION}`)}`

export function About() {
  return (
    <div className="fx-page fx-d-groups">
      {/* each a sticky note stuck on the page */}
      <ul className="fx-links">
        {LINKS.map((x) => (
          <li key={x.label}><a className="fx-link" href={x.href} target="_blank" rel="noreferrer">
            <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path d={SOCIAL_ICONS[x.label]} fill="currentColor" /></svg>
            <span>{x.label}</span><span className="fx-sr">{tr('（另開分頁）')}</span>
          </a></li>
        ))}
      </ul>
      <section className="fx-d-group" aria-labelledby="fx-license">
        <h4 id="fx-license">{tr('授權')}</h4>
        <pre className="fx-license" tabIndex={0}>{LICENSE}</pre>
      </section>
      <section className="fx-d-group" aria-labelledby="fx-version">
        <h4 id="fx-version">{tr('版本')}</h4>
        <code>{VERSION}</code>
      </section>
      <a className="fx-save" href={ISSUE_URL} target="_blank" rel="noreferrer">
        {tr('問題回報')}<span className="fx-sr">{tr('（另開分頁）')}</span>
      </a>
    </div>
  )
}
