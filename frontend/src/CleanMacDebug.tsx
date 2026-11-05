// `make dev-mock` only: plays a Mac fresh out of the box, with no git, to try what the app does about it.

import { tr } from './core/i18n'
import { useGit } from './GitInstall'
import { simulateNoGit } from './gitTool'

export function CleanMacDebug() {
  // pressed while git is missing; the pretend install lets it go by itself
  const clean = useGit().phase !== 'ready'
  return (
    <div className="fx-daylight-debug fx-tag" role="group" aria-label={tr('模擬')}>
      <button type="button" aria-pressed={clean} onClick={() => simulateNoGit(!clean)}>{tr('乾淨 Mac')}</button>
    </div>
  )
}
