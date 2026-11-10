import { tr } from './core/i18n'
import { useRemote } from './core/island'
import { useState } from 'react'
import { attempt, cancelLogin, logout, pasteLogin, startLogin } from './core/ops'
import { useStore } from './core/store'

/**
 * The 帳號 field of a subscription the backend has: signed in or not, and how far along a sign-in is, as the
 * backend reports it on the provider.
 */
export function SubscriptionLogin({ id }: { id: string }) {
  const provider = useStore((s) => s.world.providers[id])
  const [pasted, setPasted] = useState('')
  const auth = provider?.auth
  if (auth?.kind !== 'subscription') return null
  const openai = provider.kind === 'openai'
  const login = auth.login
  const start = (method?: 'browser' | 'device') => void attempt(() => startLogin(id, method))
  // on another island a browser sign-in opens on that computer, and comes back to it
  const remote = useRemote()
  return (
    <div className="fx-field">
      <span>{tr('帳號')}</span>
      <div className="fx-claude" aria-live="polite">
        {auth.signedIn && !login && (
          <>
            <p className="fx-signed" role="status">{tr('✓ 已登入')}</p>
            <button type="button" className="fx-control fx-login fx-hit" onClick={() => void attempt(() => logout(id))}>{tr('登出')}</button>
          </>
        )}
        {login && !login.error && (
          <>
            {login.url && <p>{tr('請在瀏覽器完成登入{a}：', { a: login.userCode ? tr('，並輸入代碼') : '' })}<a href={login.url} target="_blank" rel="noreferrer">{tr('打開登入頁')}<span className="fx-sr">{tr('（另開分頁）')}</span></a></p>}
            {login.userCode && <code>{login.userCode}</code>}
            {login.command && <p>{tr('正在確認 Claude Code 的登入…')}</p>}
            {login.method === 'browser' && (
              <>
                <label className="fx-claude-paste">
                  <span>{tr('瀏覽器停在打不開的頁面時，貼上它的網址')}</span>
                  <input className="fx-control" value={pasted} spellCheck={false} autoComplete="off" onChange={(e) => setPasted(e.target.value)} />
                </label>
                <button type="button" className="fx-control fx-login fx-hit" disabled={!pasted.trim()}
                  onClick={() => void attempt(() => pasteLogin(id, pasted))}>{tr('送出')}</button>
              </>
            )}
            <button type="button" className="fx-control fx-login fx-hit" onClick={() => void attempt(() => cancelLogin(id))}>{tr('取消')}</button>
          </>
        )}
        {login?.error && <p className="fx-field-error" role="alert">{login.error}</p>}
        {!auth.signedIn && (!login || login.error) && (
          <>
            {!remote && <button type="button" className="fx-control fx-login fx-hit" onClick={() => start(openai ? 'browser' : undefined)}>{openai ? tr('用瀏覽器登入') : tr('確認登入')}</button>}
            {remote && <p className="fx-d-muted">{openai ? tr('用瀏覽器登入會在對方電腦上打開，這裡請用裝置代碼登入') : tr('登入會在對方電腦上打開瀏覽器，請到那台電腦登入')}</p>}
            {openai && <button type="button" className="fx-control fx-login fx-hit" onClick={() => start('device')}>{tr('用裝置代碼登入')}</button>}
          </>
        )}
      </div>
    </div>
  )
}
