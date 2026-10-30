import { createRoot } from 'react-dom/client'
import { useBackend, useSimLoop, useStore } from './core/store'
import { UNREACHABLE } from './core/backend'
import { World } from './World'
import './fonts.css'
import './fusion.css'

function App() {
  // the fake runtime keeps the company files live
  useSimLoop()
  useBackend()
  return <div className="fusion"><World /><Trouble /></div>
}

/** Says when the backend can't be reached, or turned something down. */
function Trouble() {
  const offline = useStore((s) => s.offline)
  const failure = useStore((s) => s.failure)
  const setFailure = useStore((s) => s.setFailure)
  if (!offline && !failure) return null
  return (
    <div className="fx-trouble" role="alert">
      <span>{offline ? UNREACHABLE : failure}</span>
      {!offline && <button type="button" className="fx-tool fx-hit" aria-label="關閉" title="關閉" onClick={() => setFailure('')}>✕</button>}
    </div>
  )
}

createRoot(document.getElementById('root') as HTMLElement).render(<App />)
