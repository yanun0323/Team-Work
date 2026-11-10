// Without git the app does not run: everything greys out under a note with the button that installs it.

import { useSyncExternalStore, type ReactNode } from 'react'
import { useRemote } from './core/island'
import { remoteWindowReason } from './core/ops'
import { tr } from './core/i18n'
import { gitState, installGit, subscribeGit } from './gitTool'

export const useGit = () => useSyncExternalStore(subscribeGit, gitState, gitState)

/** Whether git is known to be missing. Not knowing yet is not missing, so the app is not stopped while it asks. */
export const gitMissing = (phase: ReturnType<typeof gitState>['phase']) => phase !== 'ready' && phase !== 'checking'

/** Nothing once git is there, or where the app cannot install it itself. */
export function GitInstall() {
  const { phase, installable, error } = useGit()
  const remote = useRemote()
  if (!gitMissing(phase) || !installable) return null
  return (
    <span className="fx-git" aria-live="polite">
      {phase === 'waiting' && !remote ? (
        <>
          <span role="status">{tr('請在 Apple 的視窗完成安裝…')}</span>
          <button type="button" className="fx-save" onClick={() => void installGit()}>{tr('再開一次')}</button>
        </>
      ) : (
        <button type="button" className="fx-save" disabled={remote || phase === 'opening'} title={remote ? remoteWindowReason() : undefined} onClick={() => void installGit()}>{tr('安裝')}</button>
      )}
      {error && <span className="fx-git-error" role="alert">{error}</span>}
    </span>
  )
}

/** The whole app, stopped and greyed out under the note while git is missing. */
export function GitGate({ children }: { children: ReactNode }) {
  const { phase, installable } = useGit()
  const halted = gitMissing(phase)
  return (
    <>
      <div className={halted ? 'fx-app fx-halted' : 'fx-app'} aria-hidden={halted || undefined} inert={halted || undefined}>
        {children}
      </div>
      {halted && (
        <div className="fx-gate">
          <section className="fx-gate-note" role="alertdialog" aria-modal="true" aria-labelledby="fx-gate-title">
            <h2 id="fx-gate-title">{tr('缺少必要套件')}</h2>
            <p>{installable ? tr('這台 Mac 還沒有 git，需要安裝 Apple 的開發者工具才能使用。') : tr('這台電腦還沒有 git，請先安裝。')}</p>
            <GitInstall />
          </section>
        </div>
      )}
    </>
  )
}
