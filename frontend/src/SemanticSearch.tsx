// The experimental semantic search on the settings page: one switch, and how far the model has got once the app
// restarts with it on. It is this computer's own, so it stays the same on another island, and it is not shown at all
// where the computer cannot run it.

import { useCallback, useEffect, useState } from 'react'
import { Toggle } from './Controls'
import { tr } from './core/i18n'
import { useStore } from './core/store'
import { useRemote } from './core/island'
import { canRestart, pollDelay, readSemanticStatus, restartApp, saveSemanticSearch, type SemanticStatus } from './semanticStatus'

type Store = ReturnType<typeof useStore.getState>

/** Whether ending the app now would stop work under way. */
export const workRunning = (s: Store) => Object.values(s.world.subTasks).some((x) => x.status === 'progressing' && !x.cancelled)
  || Object.values(s.world.tasks).some((t) => t.stage === 'merging')
  || Object.values(s.world.chats).some((c) => c.replyAt !== undefined)

const MB = 1_000_000
const mb = (bytes: number) => Math.round(bytes / MB).toLocaleString()

/** The line saying where it stands; empty when there is nothing to say. */
export function statusLine(s: SemanticStatus, bridge: boolean): string {
  const p = s.progress
  switch (s.state) {
    case 'restart_required': return bridge ? tr('重新啟動後生效') : tr('重新啟動 Team Work 後生效')
    case 'downloading': return p.totalBytes
      ? tr('下載模型中 {done} / {total} MB', { done: mb(p.downloadedBytes), total: mb(p.totalBytes) })
      : tr('下載模型中 {done} MB', { done: mb(p.downloadedBytes) })
    case 'compiling': return tr('編譯模型中')
    case 'indexing': return tr('建立索引中 {done} / {total} 個檔案', { done: p.completedFiles, total: p.completedFiles + p.pendingFiles })
    case 'ready': return tr('可以使用')
    default: return ''
  }
}

/** How far along, 0–1, when it can be told; compiling never can. */
export function share(s: SemanticStatus): number | null {
  const p = s.progress
  if (s.state === 'downloading' && p.totalBytes) return Math.min(1, p.downloadedBytes / p.totalBytes)
  if (s.state === 'indexing' && p.completedFiles + p.pendingFiles > 0) return p.completedFiles / (p.completedFiles + p.pendingFiles)
  return null
}

export type RestartStep = 'idle' | 'asking' | 'going'

export interface SemanticViewProps {
  /** Null until the first answer. */
  status: SemanticStatus | null
  /** Why reading the status failed, if it did. */
  loadError: string
  saving: boolean
  saveError: string
  /** The Mac app can restart itself. */
  bridge: boolean
  restart: RestartStep
  restartError: string
  /** Work is under way that a restart would stop. */
  busy: boolean
  onToggle: (on: boolean) => void
  onRetry: () => void
  onRestart: () => void
  onRestartBlur: () => void
}

/** The section as the props say; nothing while loading or where it is not supported. */
export function SemanticSearchView(p: SemanticViewProps) {
  const s = p.status
  if (!s && !p.loadError) return null
  if (s && (!s.supported || s.state === 'unsupported')) return null
  const line = s ? statusLine(s, p.bridge) : ''
  const part = s ? share(s) : null
  const error = s?.state === 'error' && s.error ? tr('{message}，詳情見 {log}', { message: s.error.message, log: s.error.log || 'backend.log' }) : ''
  const alert = [p.saveError, p.restartError, error, p.loadError].filter(Boolean)
  return (
    <section className="fx-d-group" aria-labelledby="fx-prefs-labs">
      <h4 id="fx-prefs-labs">{tr('實驗性功能')}</h4>
      {s && (
        <div className="fx-fields">
          <Toggle label={tr('語意搜尋')} checked={s.enabled} disabled={p.saving} onChange={p.onToggle} />
        </div>
      )}
      <div role="status" className="fx-labs-status">
        {line && <p>{line}</p>}
        {part !== null && <progress className="fx-labs-bar" value={part} max={1} aria-label={line} />}
        {s?.state === 'compiling' && <progress className="fx-labs-bar" aria-label={line} />}
        {s?.reason && s.state !== 'error' && <p className="fx-d-muted">{s.reason}</p>}
      </div>
      {s?.state === 'restart_required' && p.bridge && (
        <div className="fx-settings-file-acts">
          <button type="button" className={p.restart === 'asking' ? 'fx-save fx-danger' : 'fx-save'} disabled={p.restart === 'going'}
            onClick={p.onRestart} onBlur={p.onRestartBlur}>
            {p.restart === 'going' ? tr('重新啟動中…') : p.restart === 'asking' ? (p.busy ? tr('工作會中斷，確定重新啟動') : tr('確定重新啟動')) : tr('重新啟動')}
          </button>
        </div>
      )}
      <div role="alert">{alert.map((x) => <p key={x}>{x}</p>)}</div>
      {!s && <div className="fx-settings-file-acts"><button type="button" className="fx-save" onClick={p.onRetry}>{tr('重試')}</button></div>}
    </section>
  )
}

/** Reads this computer's status on opening, again and again while it moves, and stops on leaving. */
export function SemanticSearchSection() {
  return <SemanticSearchView {...useSemanticSearch()} />
}

/** The section's state and what its switch and buttons do. */
export function useSemanticSearch(): SemanticViewProps {
  const [status, setStatus] = useState<SemanticStatus | null>(null)
  const [loadError, setLoadError] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [restart, setRestart] = useState<RestartStep>('idle')
  const [restartError, setRestartError] = useState('')
  const [tick, setTick] = useState(0)
  const remote = useRemote()
  // on another island its world is that computer's, whose work a restart here would not stop; say it may anyway
  const busy = useStore((s) => remote || workRunning(s))
  const again = useCallback(() => setTick((n) => n + 1), [])

  useEffect(() => {
    const stop = new AbortController()
    let timer = 0
    readSemanticStatus(stop.signal).then((next) => {
      setStatus(next)
      setLoadError('')
      timer = window.setTimeout(again, pollDelay(next.state))
    }, (e: Error) => {
      if (e.name === 'AbortError') return
      setLoadError(e.message)
      timer = window.setTimeout(again, 5000)
    })
    return () => {
      stop.abort()
      window.clearTimeout(timer)
    }
  }, [tick, again])

  const toggle = async (on: boolean) => {
    if (saving) return
    setSaving(true)
    setSaveError('')
    try {
      await saveSemanticSearch(on)
      setRestart('idle')
      setRestartError('')
    } catch (e) {
      setSaveError((e as Error).message)
    } finally {
      setSaving(false)
      again()
    }
  }
  const press = async () => {
    if (restart === 'going') return
    if (restart === 'idle') return setRestart('asking')
    setRestart('going')
    setRestartError('')
    try {
      // the app quits from here; the button stays put until it does
      await restartApp()
    } catch (e) {
      setRestart('idle')
      setRestartError((e as Error).message || tr('沒辦法重新啟動，請自行重新啟動 Team Work'))
    }
  }

  return {
    status, loadError, saving, saveError, bridge: canRestart(), restart, restartError, busy,
    onToggle: (on) => void toggle(on), onRetry: again, onRestart: () => void press(),
    onRestartBlur: () => setRestart((r) => (r === 'asking' ? 'idle' : r)),
  }
}
