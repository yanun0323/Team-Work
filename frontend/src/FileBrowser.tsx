// The company file's 檔案瀏覽 tab: the project folder as a tree, read one opened folder at a time, beside the open
// file. Text files are edited in a plain text box and saved by hand against the fingerprint they were read with, so
// a change made elsewhere meanwhile is never written over; pictures are only shown. What is being edited lives in
// fileDrafts, so it outlasts a change of tab.

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { tr } from './core/i18n'
import { ApiError } from './core/backend'
import { createProjectEntry, listProjectTree, openFolder, openProjectFile, projectImageUrl, saveProjectFile, type TreeEntry } from './core/ops'
import {
  draftAt, draftKey, draftOf, dropDraft, editDraftText, isDirty, markSaved, openFile, setDraft, textToSave, toggleFolder,
  useFileDrafts, viewOf,
} from './fileDrafts'

export const isImage = (path: string) => /\.(png|jpe?g|gif|webp)$/i.test(path)

/** The folder a path is in; '' for the project itself. */
export const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')

const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1)

// ---------- reading and writing ----------

/** One folder's level of the tree, as far as it has been read. */
export type DirState =
  | { status: 'loading'; entries?: TreeEntry[]; truncated?: boolean }
  | { status: 'ok'; entries: TreeEntry[]; truncated: boolean }
  | { status: 'error'; message: string }

/** The open file, as far as it has been read. */
export type FileState =
  | { status: 'loading' }
  | { status: 'ready' }
  | { status: 'image' }
  | { status: 'unsupported'; message: string }
  | { status: 'error'; message: string }

/**
 * Reads a file to edit unless it has unsaved changes, which are kept as they are. A file that is not text, or too big,
 * cannot be shown, which is not the same as failing to read it.
 */
export async function loadFile(teamId: string, path: string, signal?: AbortSignal): Promise<FileState> {
  if (isImage(path)) return { status: 'image' }
  if (isDirty(draftAt(teamId, path))) return { status: 'ready' }
  try {
    const { text, hash } = await openProjectFile(teamId, path, signal)
    setDraft(teamId, path, draftOf(text, hash))
    return { status: 'ready' }
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    if (e instanceof ApiError && e.code === 'unsupported') return { status: 'unsupported', message: e.message }
    return { status: 'error', message: (e as Error).message }
  }
}

export type SaveOutcome = { ok: true } | { ok: false; conflict: boolean; message: string }

/**
 * Saves a draft against the hash it was read with. A refusal because the file changed or went away elsewhere is a
 * conflict: the draft stays, and nothing is written.
 */
export async function saveDraft(teamId: string, path: string): Promise<SaveOutcome> {
  const d = draftAt(teamId, path)
  if (!d) return { ok: true }
  const sent = d.text
  try {
    const hash = await saveProjectFile(teamId, path, textToSave(d), d.hash)
    markSaved(teamId, path, sent, hash)
    return { ok: true }
  } catch (e) {
    return { ok: false, conflict: e instanceof ApiError && e.code === 'conflict', message: (e as Error).message }
  }
}

/** The listings of a company's opened folders: the project itself, and each folder opened in its tree. */
function useDirs(teamId: string, expanded: string[]) {
  const [dirs, setDirs] = useState<Record<string, DirState>>({})
  const stop = useRef(new AbortController())
  useEffect(() => () => stop.current.abort(), [])
  const load = useCallback((path: string) => {
    setDirs((ds) => {
      const was = ds[path]
      return { ...ds, [path]: was?.status === 'ok' ? { ...was, status: 'loading' } : { status: 'loading' } }
    })
    return listProjectTree(teamId, path, stop.current.signal).then(
      (r) => setDirs((ds) => ({ ...ds, [path]: { status: 'ok', ...r } })),
      (e: Error) => { if (e.name !== 'AbortError') setDirs((ds) => ({ ...ds, [path]: { status: 'error', message: e.message } })) },
    )
  }, [teamId])
  // the project and every folder left open, once; a folder opened later is read as it opens
  const loaded = useRef(new Set<string>())
  useEffect(() => {
    for (const path of ['', ...expanded]) {
      if (loaded.current.has(path)) continue
      loaded.current.add(path)
      void load(path)
    }
  }, [expanded, load])
  const refresh = () => {
    for (const path of ['', ...expanded]) void load(path)
  }
  return { dirs, load, refresh }
}

// ---------- the tab ----------

export default function FileBrowser({ teamId }: { teamId: string }) {
  const view = useFileDrafts((s) => viewOf(s.views, teamId))
  const { dirs, load, refresh } = useDirs(teamId, view.expanded)
  const [creating, setCreating] = useState<Creating | null>(null)
  const [reread, setReread] = useState(0)
  const tree = useRef<HTMLDivElement>(null)

  const onCreated = async (made: TreeEntry) => {
    setCreating(null)
    await load(parentOf(made.path))
    if (made.kind === 'file') openFile(teamId, made.path)
    tree.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(made.path)}"]`)?.focus()
  }

  const root = dirs['']
  return (
    <div className="fx-files">
      <div className="fx-files-tree" ref={tree}>
        <div className="fx-files-bar">
          <NewTools parent="" onCreate={setCreating} />
          <ToolButton label={tr('重新整理')} onClick={() => { refresh(); setReread((n) => n + 1) }}><RefreshIcon /></ToolButton>
        </div>
        {root?.status === 'error'
          ? <p className="fx-files-note" role="alert">{root.message}</p>
          : <Level teamId={teamId} path="" dirs={dirs} expanded={view.expanded} open={view.open} creating={creating}
              onCreate={setCreating} onCancelCreate={() => setCreating(null)} onCreated={onCreated}
              onToggle={(path) => toggleFolder(teamId, path)} />}
      </div>
      <div className="fx-files-view">
        {view.open
          ? <FileView key={`${view.open}\n${reread}`} teamId={teamId} path={view.open} />
          : <p className="fx-empty">{tr('選一個檔案來看')}</p>}
      </div>
    </div>
  )
}

interface Creating { parent: string; kind: TreeEntry['kind'] }

interface LevelProps {
  teamId: string
  path: string
  dirs: Record<string, DirState>
  expanded: string[]
  open: string | null
  creating: Creating | null
  onToggle: (path: string) => void
  onCreate: (c: Creating) => void
  onCancelCreate: () => void
  onCreated: (made: TreeEntry) => void
}

/** The entries of one folder, folders first, with the folders that are open shown under them. */
export function Level(p: LevelProps) {
  const { teamId, path, dirs, creating } = p
  const dir = dirs[path]
  const drafts = useFileDrafts((s) => s.drafts)
  const naming = creating?.parent === path ? <NameInput key={creating.kind} teamId={teamId} parent={path} kind={creating.kind} onCancel={p.onCancelCreate} onCreated={p.onCreated} /> : null
  let body: ReactNode
  if (!dir || (dir.status === 'loading' && !dir.entries)) body = <li className="fx-files-note">{tr('讀取中…')}</li>
  else if (dir.status === 'error') body = <li className="fx-files-note" role="alert">{dir.message}</li>
  else if (!dir.entries!.length) body = <li className="fx-files-note">{tr('空資料夾')}</li>
  else body = dir.entries!.map((x) => {
    if (x.kind === 'file') {
      const unsaved = isDirty(drafts[draftKey(teamId, x.path)])
      return (
        <li key={x.path}>
          <button type="button" className="fx-files-row fx-hit" data-path={x.path} aria-current={p.open === x.path || undefined}
            onClick={() => openFile(teamId, x.path)}>
            <span className="fx-files-name">{x.name}</span>
            {unsaved && <span className="fx-files-dot" title={tr('未儲存')}><span className="fx-sr">{tr('未儲存')}</span></span>}
          </button>
        </li>
      )
    }
    const isOpen = p.expanded.includes(x.path)
    return (
      <li key={x.path}>
        <div className="fx-files-dir">
          <button type="button" className="fx-files-row fx-files-folder fx-hit" data-path={x.path} aria-expanded={isOpen} onClick={() => p.onToggle(x.path)}>
            <span className="fx-files-name">{x.name}</span>
          </button>
          <NewTools parent={x.path} onCreate={(c) => {
            if (!isOpen) p.onToggle(x.path)
            p.onCreate(c)
          }} />
        </div>
        {isOpen && <Level {...p} path={x.path} />}
      </li>
    )
  })
  return (
    <ul className="fx-files-level">
      {naming && <li>{naming}</li>}
      {body}
      {dir?.status !== 'error' && dir?.truncated && <li className="fx-files-note">{tr('只列出前 {count} 項', { count: 5000 })}</li>}
    </ul>
  )
}

function NewTools({ parent, onCreate }: { parent: string; onCreate: (c: Creating) => void }) {
  return (
    <span className="fx-files-tools">
      <ToolButton label={tr('新增檔案')} onClick={() => onCreate({ parent, kind: 'file' })}><NewFileIcon /></ToolButton>
      <ToolButton label={tr('新增資料夾')} onClick={() => onCreate({ parent, kind: 'dir' })}><NewFolderIcon /></ToolButton>
    </span>
  )
}

/** The name of a new file or folder: Enter makes it, Esc gives up. A refusal stays beside it, to correct. */
function NameInput({ teamId, parent, kind, onCancel, onCreated }: Creating & { teamId: string; onCancel: () => void; onCreated: (x: TreeEntry) => void }) {
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const id = `fx-files-new-${parent}`
  const submit = async () => {
    setBusy(true)
    try {
      onCreated(await createProjectEntry(teamId, parent, name, kind))
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing && !busy) { e.preventDefault(); void submit() }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel() }
  }
  return (
    <span className="fx-files-new">
      <input className="fx-control" autoFocus value={name} disabled={busy} aria-invalid={!!error || undefined}
        aria-label={kind === 'file' ? tr('新增檔案') : tr('新增資料夾')} aria-describedby={error ? id : undefined}
        onChange={(e) => { setName(e.target.value); setError('') }} onKeyDown={onKey} onBlur={() => { if (!name && !busy) onCancel() }} />
      {error && <span id={id} className="fx-files-error" role="alert">{error}</span>}
    </span>
  )
}

// ---------- the open file ----------

/** The open file: edited if it is text, shown if it is a picture, or else why it cannot be shown. */
export function FileView({ teamId, path }: { teamId: string; path: string }) {
  const [state, setState] = useState<FileState>({ status: 'loading' })
  const read = useCallback(() => {
    const stop = new AbortController()
    setState({ status: 'loading' })
    loadFile(teamId, path, stop.signal).then(setState, () => {})
    return () => stop.abort()
  }, [teamId, path])
  useEffect(read, [read])
  return <FilePane teamId={teamId} path={path} state={state} onReread={() => { dropDraft(teamId, path); read() }} onImageError={(message) => setState({ status: 'error', message })} />
}

/** What FileView shows for a file in a given state. */
export function FilePane({ teamId, path, state, onReread, onImageError }: {
  teamId: string; path: string; state: FileState; onReread: () => void; onImageError: (message: string) => void
}) {
  const draft = useFileDrafts((s) => s.drafts[draftKey(teamId, path)])
  const unsaved = state.status === 'ready' && isDirty(draft)
  const [saving, setSaving] = useState(false)
  const [problem, setProblem] = useState<{ conflict: boolean; message: string } | null>(null)
  const [closing, setClosing] = useState(false)
  const name = nameOf(path)

  const save = async () => {
    if (saving || !unsaved) return
    setSaving(true)
    const r = await saveDraft(teamId, path)
    setSaving(false)
    setProblem(r.ok ? null : r)
  }
  const close = () => (unsaved ? setClosing(true) : openFile(teamId, null))
  const onKey = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 's') {
      e.preventDefault()
      void save()
    }
  }

  let body: ReactNode
  if (state.status === 'loading') body = <p className="fx-files-note">{tr('讀取中…')}</p>
  else if (state.status === 'error') body = <p className="fx-files-note" role="alert">{state.message}</p>
  else if (state.status === 'image') body = <img className="fx-d-image" src={projectImageUrl(teamId, path)} alt={path} onError={() => onImageError(tr('{name} 讀不到，請到專案資料夾打開', { name }))} />
  else if (state.status === 'unsupported') body = (
    <div className="fx-files-note">
      <p><b>{tr('無法預覽')}</b></p>
      <p>{state.message}</p>
      <button type="button" className="fx-tool fx-tool-text fx-hit" onClick={() => openFolder(teamId, parentOf(path))}>{tr('在 Finder 顯示')}</button>
    </div>
  )
  else body = draft && (
    <textarea className="fx-files-text" value={draft.text} spellCheck={false} aria-label={path}
      onChange={(e) => editDraftText(teamId, path, e.target.value)} />
  )

  return (
    <div className="fx-files-pane" onKeyDown={onKey}>
      <header className="fx-files-head">
        <span className="fx-files-title">
          <b>{name}</b>
          {unsaved && <span className="fx-files-dot" title={tr('未儲存')}><span className="fx-sr">{tr('未儲存')}</span></span>}
          <code>{path}</code>
        </span>
        {state.status === 'ready' && <button type="button" className="fx-save" disabled={!unsaved || saving} onClick={() => void save()}>{saving ? tr('儲存中…') : tr('儲存')}</button>}
        <button type="button" className="fx-tool fx-hit" aria-label={tr('關閉')} title={tr('關閉')} onClick={close}><CloseIcon /></button>
      </header>
      {closing && (
        <div className="fx-files-ask" role="alertdialog" aria-label={tr('捨棄未儲存的修改？')}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setClosing(false) } }}>
          <span>{tr('捨棄未儲存的修改？')}</span>
          <button type="button" className="fx-tool fx-tool-text fx-hit" autoFocus onClick={() => setClosing(false)}>{tr('取消')}</button>
          <button type="button" className="fx-tool fx-tool-ask fx-hit" onClick={() => { dropDraft(teamId, path); openFile(teamId, null) }}>{tr('捨棄')}</button>
        </div>
      )}
      {problem && (
        <div className="fx-files-ask" role="alert">
          <span>{problem.message}</span>
          {problem.conflict && <>
            <button type="button" className="fx-tool fx-tool-text fx-hit" onClick={() => { setProblem(null); onReread() }}>{tr('重新讀取')}</button>
            <button type="button" className="fx-tool fx-tool-text fx-hit" onClick={() => setProblem(null)}>{tr('保留我的修改')}</button>
          </>}
        </div>
      )}
      {body}
    </div>
  )
}

// ---------- icons ----------

function ToolButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return <button type="button" className="fx-tool fx-hit" aria-label={label} title={label} onClick={onClick}>{children}</button>
}

const icon = (d: ReactNode) => <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round">{d}</svg>
const NewFileIcon = () => icon(<><path d="M3.5 1.75h5.5l3.5 3.5v9h-9z" /><path d="M8 7.5v5M5.5 10h5" /></>)
const NewFolderIcon = () => icon(<><path d="M1.75 13.25v-10h4.2l1.5 1.75h6.8v8.25z" /><path d="M8 7v4.5M5.75 9.25h4.5" /></>)
const RefreshIcon = () => icon(<><path d="M13 8a5 5 0 1 1-1.6-3.7" /><path d="M13 2.5v3h-3" /></>)
const CloseIcon = () => icon(<path d="M4 4l8 8M12 4l-8 8" />)
