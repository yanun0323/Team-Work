import { useState } from 'react'
import { attempt, cancelLogin, pasteLogin, startLogin } from './core/ops'
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
  return (
    <div className="fx-field">
      <span>帳號</span>
      <div className="fx-claude" aria-live="polite">
        {auth.signedIn && !login && <p className="fx-signed" role="status">✓ 已登入</p>}
        {login && !login.error && (
          <>
            {login.url && <p>請在瀏覽器完成登入{login.userCode ? '，並輸入代碼' : ''}：<a href={login.url} target="_blank" rel="noreferrer">打開登入頁<span className="fx-sr">（另開分頁）</span></a></p>}
            {login.userCode && <code>{login.userCode}</code>}
            {login.command && <p>正在確認 Claude Code 的登入…</p>}
            {login.method === 'browser' && (
              <>
                <label className="fx-claude-paste">
                  <span>瀏覽器停在打不開的頁面時，貼上它的網址</span>
                  <input className="fx-control" value={pasted} spellCheck={false} autoComplete="off" onChange={(e) => setPasted(e.target.value)} />
                </label>
                <button type="button" className="fx-control fx-login fx-hit" disabled={!pasted.trim()}
                  onClick={() => void attempt(() => pasteLogin(id, pasted))}>送出</button>
              </>
            )}
            <button type="button" className="fx-control fx-login fx-hit" onClick={() => void attempt(() => cancelLogin(id))}>取消</button>
          </>
        )}
        {login?.error && <p className="fx-field-error" role="alert">{login.error}</p>}
        {!auth.signedIn && (!login || login.error) && (
          <>
            <button type="button" className="fx-control fx-login fx-hit" onClick={() => start(openai ? 'browser' : undefined)}>{openai ? '用瀏覽器登入' : '確認登入'}</button>
            {openai && <button type="button" className="fx-control fx-login fx-hit" onClick={() => start('device')}>用裝置代碼登入</button>}
          </>
        )}
      </div>
    </div>
  )
}
