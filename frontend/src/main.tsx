import { tr } from './core/i18n'
import { createRoot } from 'react-dom/client'
import { useAppLanguage, useBackend, useSimLoop, useStore } from './core/store'
import { unreachable } from './core/backend'
import { World } from './World'
import './fonts.css'
import './fusion.css'

function App() {
  // the fake runtime keeps the company files live
  useSimLoop()
  useBackend()
  useAppLanguage()
  const loaded = useStore((s) => s.loaded)
  return <div className="fusion">{loaded && <World />}<Trouble /></div>
}

/** Says when the backend can't be reached, or turned something down. */
function Trouble() {
  const offline = useStore((s) => s.offline)
  const failure = useStore((s) => s.failure)
  const setFailure = useStore((s) => s.setFailure)
  if (!offline && !failure) return null
  return (
    <div className="fx-trouble" role="alert">
      <span>{offline ? unreachable() : failure}</span>
      {!offline && <button type="button" className="fx-tool fx-hit" aria-label={tr('關閉')} title={tr('關閉')} onClick={() => setFailure('')}>✕</button>}
    </div>
  )
}

createRoot(document.getElementById('root') as HTMLElement).render(<App />)
