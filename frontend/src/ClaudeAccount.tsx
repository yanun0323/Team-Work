import { tr } from './core/i18n'
import { useRemote } from './core/island'
import { useCallback, useEffect, useRef, useState } from 'react'
import { claudeStatus, INSTALL_COMMAND, installClaude, loginClaude, phaseOf, type ClaudePhase } from './claudeCode'

/**
 * The 帳號 field of a Claude subscription: Claude Code has to be there first, and installing it takes the
 * user's agreement, given by the button itself. Tells `onModels` what the signed-in account offers.
 */
export function ClaudeAccount({ describedBy, onModels }: { describedBy?: string; onModels: (models: string[]) => void }) {
  const [phase, setPhase] = useState<ClaudePhase>('checking')
  // on another island signing in opens a browser on that computer
  const remote = useRemote()
  const [error, setError] = useState('')
  const running = useRef<AbortController | null>(null)
  const report = useRef(onModels)
  report.current = onModels

  /** One step at a time; a new one, or leaving the form, stops the last. Ends by checking where things stand. */
  const step = useCallback(async (during: ClaudePhase, fallback: ClaudePhase, work?: (signal: AbortSignal) => Promise<void>) => {
    running.current?.abort()
    const ctl = new AbortController()
    running.current = ctl
    setPhase(during)
    setError('')
    try {
      await work?.(ctl.signal)
      const status = await claudeStatus(ctl.signal)
      setPhase(phaseOf(status))
      report.current(status.signedIn ? status.models : [])
    } catch (e) {
      if (ctl.signal.aborted) return
      setPhase(fallback)
      setError((e as Error).message)
    }
  }, [])

  const check = useCallback(() => void step('checking', 'checking'), [step])
  useEffect(() => {
    check()
    return () => running.current?.abort()
  }, [check])
  const stop = (back: ClaudePhase) => {
    running.current?.abort()
    setPhase(back)
  }

  return (
    <div className="fx-field">
      <span>{tr('帳號')}</span>
      <div className="fx-claude" aria-live="polite">
        {phase === 'signedIn' && <p className="fx-signed" role="status">{tr('✓ 已登入 Claude')}</p>}
        {phase === 'checking' && !error && <p>{tr('正在檢查 Claude Code…')}</p>}
        {phase === 'checking' && error && <button type="button" className="fx-control fx-login fx-hit" onClick={check}>{tr('重試')}</button>}
        {phase === 'missing' && (
          <>
            <p>{tr('Claude 訂閱要透過 Claude Code 使用，這台電腦還沒安裝。同意後會從 claude.ai 下載並執行官方安裝程式：')}</p>
            <code>{INSTALL_COMMAND}</code>
            <button type="button" className="fx-control fx-login fx-hit" onClick={() => void step('installing', 'missing', installClaude)}>{tr('同意並安裝')}</button>
          </>
        )}
        {phase === 'installing' && (
          <>
            <p role="status">{tr('正在安裝 Claude Code…')}</p>
            <button type="button" className="fx-control fx-login fx-hit" onClick={() => stop('missing')}>{tr('取消')}</button>
          </>
        )}
        {phase === 'signedOut' && remote && <p className="fx-d-muted">{tr('登入會在對方電腦上打開瀏覽器，請到那台電腦登入')}</p>}
        {phase === 'signedOut' && !remote && (
          <button type="button" className="fx-control fx-login fx-hit" aria-describedby={describedBy} onClick={() => void step('loggingIn', 'signedOut', loginClaude)}>{tr('登入 Claude')}</button>
        )}
        {phase === 'loggingIn' && (
          <>
            <p role="status">{tr('請在瀏覽器完成登入…')}</p>
            <button type="button" className="fx-control fx-login fx-hit" onClick={() => stop('signedOut')}>{tr('取消')}</button>
          </>
        )}
        {error && <p className="fx-field-error" role="alert">{error}</p>}
      </div>
    </div>
  )
}
