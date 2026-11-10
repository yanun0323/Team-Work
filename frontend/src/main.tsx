import { tr } from './core/i18n'
import { useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { holdBoot, revealBoot } from './boot'
import { useAppLanguage, useBackend, useSimLoop, useStore } from './core/store'
import { unreachable } from './core/backend'
import { useRemote } from './core/island'
import { World } from './World'
import { GitGate } from './GitInstall'
import './fonts.css'
import './fusion.css'

const BOOT_LIMIT_MS = 15000

function App() {
  // the fake runtime keeps the company files live
  useSimLoop()
  useBackend()
  useAppLanguage()
  const loaded = useStore((s) => s.loaded)
  const offline = useStore((s) => s.offline)
  // another island's lost connection is said by its own slip (IslandBar)
  const remote = useRemote()
  useEffect(() => holdBoot(offline && !remote), [offline, remote])
  // the scene lifts the startup screen on its first frames; never leave it covering a scene that didn't draw
  useEffect(() => {
    if (!loaded) return
    const timer = setTimeout(revealBoot, BOOT_LIMIT_MS)
    return () => clearTimeout(timer)
  }, [loaded])
  return <div className="fusion"><GitGate>{loaded && <World />}</GitGate><Trouble /></div>
}

/** Says when the backend can't be reached, or turned something down. */
function Trouble() {
  const remote = useRemote()
  const offline = useStore((s) => s.offline) && !remote
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
