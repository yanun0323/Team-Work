// The file browser's sheets, taped over the map like every other detail: a file in the company's project as it is on
// disk, and its edit sheet. Text is edited in a plain text box and saved
// against the fingerprint it was read with, so a change made elsewhere meanwhile is never written over. What is being
// edited lives in fileDrafts, so it outlasts the edit sheet being put away.

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { tr } from './core/i18n'
import { ApiError } from './core/backend'
import { openFolder, openProjectFile, projectImageUrl, saveProjectFile } from './core/ops'
import { useAutoGrow } from './Controls'
import { EditTool, Heading, type Head } from './DrawerDetail'
import { CodeFile } from './Highlight'
import { Markdown } from './Markdown'
import {
  draftAt, draftKey, draftOf, dropDraft, editDraftText, forgetClean, isDirty, markSaved, setDraft, textToSave, useFileDrafts,
} from './fileDrafts'

export const isImage = (path: string) => /\.(png|jpe?g|gif|webp)$/i.test(path)

/** The folder a path is in; '' for the project itself. */
export const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')

const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1)

// ---------- reading and writing ----------

/** A file as far as it has been read. */
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

/** A file read on a sheet, read again whenever `again` changes. */
function useFile(teamId: string, path: string, again: unknown) {
  const [state, setState] = useState<FileState>({ status: 'loading' })
  const [reads, setReads] = useState(0)
  useEffect(() => {
    const stop = new AbortController()
    setState((s) => (s.status === 'ready' ? s : { status: 'loading' }))
    loadFile(teamId, path, stop.signal).then(setState, () => {})
    return () => stop.abort()
  }, [teamId, path, again, reads])
  return { state, setState, reread: () => setReads((n) => n + 1) }
}

// ---------- the file ----------

/** A file in the company's project as it is on disk: Markdown rendered, other text as it is, a picture shown. */
export function FileDetail({ teamId, path, editing, onEdit, ...h }: Head & { teamId: string; path: string; editing: boolean; onEdit: () => void }) {
  const draft = useFileDrafts((s) => s.drafts[draftKey(teamId, path)])
  // read again once a save gives the file a new fingerprint
  const { state, setState } = useFile(teamId, path, draft?.hash)
  // put away with nothing being edited: the next look reads the file afresh
  useEffect(() => () => forgetClean(teamId, path), [teamId, path])
  const name = nameOf(path)
  const unsaved = isDirty(draft)
  return (
    <>
      {state.status === 'ready' && <div className="fx-tools"><EditTool onClick={onEdit} open={editing} /></div>}
      <header className="fx-d-head">
        <Heading {...h}>{name}</Heading>
        <p className="fx-d-meta"><code>{path}</code>{unsaved && <span className="fx-files-unsaved">{tr('有未儲存的修改')}</span>}</p>
      </header>
      <div className="fx-doc-note">
        {state.status === 'loading' && <p className="fx-d-text">{tr('讀取中…')}</p>}
        {state.status === 'error' && <p className="fx-d-text" role="alert">{state.message}</p>}
        {state.status === 'image' && (
          <img className="fx-d-image" src={projectImageUrl(teamId, path)} alt={path}
            onError={() => setState({ status: 'error', message: tr('{name} 讀不到，請到專案資料夾打開', { name }) })} />
        )}
        {state.status === 'unsupported' && <>
          <p className="fx-d-text">{state.message}</p>
          <button type="button" className="fx-save fx-plain" onClick={() => openFolder(teamId, parentOf(path))}>{tr('在 Finder 顯示')}</button>
        </>}
        {state.status === 'ready' && draft && (/\.mdx?$/i.test(path)
          ? <Markdown text={draft.base} project={{ dir: parentOf(path), imageUrl: (p) => projectImageUrl(teamId, p) }} />
          : <CodeFile path={path} text={draft.base} />)}
      </div>
    </>
  )
}

// ---------- editing it ----------

/**
 * A text file being edited. 儲存 saves and puts the sheet away; Command+S saves and stays. Put away unsaved, the draft is
 * kept to come back to; 捨棄修改 drops it.
 */
export function FileEdit({ teamId, path, onDone, ...h }: Head & { teamId: string; path: string; onDone: () => void }) {
  const draft = useFileDrafts((s) => s.drafts[draftKey(teamId, path)])
  const { state, reread } = useFile(teamId, path, null)
  const [saving, setSaving] = useState(false)
  const [problem, setProblem] = useState<{ conflict: boolean; message: string } | null>(null)
  const box = useRef<HTMLTextAreaElement>(null)
  const ready = state.status === 'ready' && !!draft
  useAutoGrow(box, draft?.text ?? '', ready)
  useEffect(() => () => forgetClean(teamId, path), [teamId, path])
  const unsaved = ready && isDirty(draft)

  const save = async (andClose: boolean) => {
    if (saving) return
    if (!unsaved) return andClose && onDone()
    setSaving(true)
    const r = await saveDraft(teamId, path)
    setSaving(false)
    setProblem(r.ok ? null : r)
    if (r.ok && andClose) onDone()
  }
  const onSubmit = (e: FormEvent) => {
    e.preventDefault()
    void save(true)
  }
  const onKey = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 's') {
      e.preventDefault()
      void save(false)
    }
  }
  const discard = () => {
    setProblem(null)
    dropDraft(teamId, path)
    reread()
  }

  return (
    <form className="fx-d-form" onSubmit={onSubmit} onKeyDown={onKey}>
      <header className="fx-d-head">
        <Heading {...h}>{tr('編輯 {name}', { name: nameOf(path) })}</Heading>
        <p className="fx-d-meta"><code>{path}</code></p>
      </header>
      {state.status === 'loading' && <p className="fx-d-text">{tr('讀取中…')}</p>}
      {(state.status === 'error' || state.status === 'unsupported') && <p className="fx-d-text" role="alert">{state.message}</p>}
      {ready && (
        <textarea ref={box} className="fx-control fx-files-text" value={draft.text} spellCheck={false} aria-label={path}
          onChange={(e) => editDraftText(teamId, path, e.target.value)} />
      )}
      {problem && <p className="fx-field-error" role="alert">{problem.message}</p>}
      {ready && (
        <div className="fx-files-acts">
          <button type="submit" className="fx-save" disabled={saving}>{saving ? tr('儲存中…') : tr('儲存')}</button>
          {/* changed elsewhere: reading it again is how to go on, and it drops what was typed, as 捨棄修改 does */}
          {problem?.conflict
            ? <button type="button" className="fx-save fx-plain" disabled={saving} onClick={discard}>{tr('重新讀取')}</button>
            : unsaved && <button type="button" className="fx-save fx-plain" disabled={saving} onClick={discard}>{tr('捨棄修改')}</button>}
        </div>
      )}
    </form>
  )
}
