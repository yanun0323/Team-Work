// Picking a folder on the computer whose island is shown, inside the page. On another island the system's folder
// dialog would open on that computer's screen, and the Mac app's would pick a folder on this one; so a new company
// there browses the other computer's folders here instead: from home, a level at a time.

import { tr } from './core/i18n'
import { useEffect, useRef, useState } from 'react'
import { request } from './core/backend'

export interface FolderLevel {
  path: string
  parent: string | null
  home: string
  folders: Array<{ name: string; path: string }>
}

/** One level of folders; with no path, the home folder's. */
export const listFolders = (path: string, signal?: AbortSignal) =>
  request<FolderLevel>('GET', `/folders${path ? `?path=${encodeURIComponent(path)}` : ''}`, undefined, signal)

type Shown =
  | { status: 'loading'; level?: FolderLevel }
  | { status: 'ok'; level: FolderLevel }
  | { status: 'error'; message: string; level?: FolderLevel }

/** Starts at `from` when it is a full path, else at home. `onPick` gets the folder chosen. */
export function FolderBrowser({ from, onPick, onClose }: { from: string; onPick: (path: string) => void; onClose: () => void }) {
  const [want, setWant] = useState(() => (from.trim().startsWith('/') ? from.trim() : ''))
  const [shown, setShown] = useState<Shown>({ status: 'loading' })
  const head = useRef<HTMLParagraphElement>(null)
  useEffect(() => {
    const ctl = new AbortController()
    setShown((s) => ({ status: 'loading', level: 'level' in s ? s.level : undefined }))
    listFolders(want, ctl.signal).then(
      (level) => setShown({ status: 'ok', level: { ...level, folders: level.folders ?? [] } }),
      (e: Error) => {
        if (e.name === 'AbortError') return
        setShown((s) => ({ status: 'error', message: e.message, level: 'level' in s ? s.level : undefined }))
      },
    )
    return () => ctl.abort()
  }, [want])
  const level = shown.level
  const open = (path: string) => {
    setWant(path)
    head.current?.focus({ preventScroll: true })
  }
  return (
    <div className="fx-folders" role="group" aria-label={tr('選擇資料夾')}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }}>
      <div className="fx-folders-head">
        <button type="button" className="fx-tool fx-hit" disabled={!level?.parent || shown.status === 'loading'}
          aria-label={tr('上一層')} title={tr('上一層')} onClick={() => level?.parent && open(level.parent)}>
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
        <p ref={head} tabIndex={-1} className="fx-folders-path" aria-live="polite"><code>{level?.path ?? want}</code></p>
      </div>
      {shown.status === 'error' && (
        <div className="fx-folders-note" role="alert">
          <span>{shown.message}</span>
          <button type="button" className="fx-add fx-hit" onClick={() => open(level?.home ?? '')}>{tr('回到家目錄')}</button>
        </div>
      )}
      {shown.status === 'loading' && !level && <p className="fx-folders-note" role="status">{tr('載入中…')}</p>}
      {level && (
        <ul className="fx-folders-list" aria-busy={shown.status === 'loading' || undefined}>
          {level.folders.map((f) => (
            <li key={f.path}>
              <button type="button" className="fx-folders-item fx-hit" onClick={() => open(f.path)}>
                <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M1.75 4.25v8.5h12.5v-7h-6.5l-1.5-1.5z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" /></svg>
                <span>{f.name}</span>
              </button>
            </li>
          ))}
          {!level.folders.length && shown.status === 'ok' && <li className="fx-folders-note">{tr('這裡沒有子資料夾')}</li>}
        </ul>
      )}
      <div className="fx-settings-file-acts">
        <button type="button" className="fx-save" disabled={!level || shown.status !== 'ok'} onClick={() => level && onPick(level.path)}>{tr('選這個資料夾')}</button>
        <button type="button" className="fx-save fx-save-quiet" onClick={onClose}>{tr('取消')}</button>
      </div>
    </div>
  )
}
