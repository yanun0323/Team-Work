// What the file browser keeps while the app runs: each company's opened folders and their listings, and the text of
// every file being edited, by company and path. It lives outside the tab and the sheets, so a change of tab or a sheet
// put away leaves it as it was.

import { create } from 'zustand'
import { listProjectTree, type TreeEntry } from './core/ops'

/** A text file as it is being edited. */
export interface FileDraft {
  /** The text in the editor, with LF line ends, as a text box keeps them. */
  text: string
  /** The text as read or last saved, with LF line ends; the draft is unsaved while `text` differs. */
  base: string
  /** The fingerprint of the file's content when read or last saved, to save against. */
  hash: string
  /** The file's lines end in CRLF: they go back that way. */
  crlf: boolean
}

/** Where a company's file browser is: the folders opened in its tree. */
export interface BrowserView { expanded: string[] }

/** One folder's level of the tree, as far as it has been read. */
export type DirState =
  | { status: 'loading'; entries?: TreeEntry[]; truncated?: boolean }
  | { status: 'ok'; entries: TreeEntry[]; truncated: boolean }
  | { status: 'error'; message: string }

interface State {
  drafts: Record<string, FileDraft>
  views: Record<string, BrowserView>
  /** Each folder's listing, by company and path ('' is the project itself), as last read. */
  dirs: Record<string, DirState>
  /** A company being left while it has unsaved drafts, and what leaving does once the user agrees. */
  leaving: { teamId: string; proceed: () => void } | null
}

export const useFileDrafts = create<State>(() => ({ drafts: {}, views: {}, dirs: {}, leaving: null }))

export const draftKey = (teamId: string, path: string) => `${teamId}\n${path}`

export const isDirty = (d: FileDraft | undefined) => !!d && d.text !== d.base

/** A file as read from disk, ready to edit: line ends made LF, and whether they were CRLF. */
export function draftOf(text: string, hash: string): FileDraft {
  const crlf = text.includes('\r\n')
  const lf = crlf ? text.replace(/\r\n/g, '\n') : text
  return { text: lf, base: lf, hash, crlf }
}

/** The text to write for a draft, with the line ends the file had. */
export const textToSave = (d: FileDraft) => (d.crlf ? d.text.replace(/\r?\n/g, '\r\n') : d.text)

export const draftAt = (teamId: string, path: string) => useFileDrafts.getState().drafts[draftKey(teamId, path)]

export function setDraft(teamId: string, path: string, d: FileDraft) {
  useFileDrafts.setState((s) => ({ drafts: { ...s.drafts, [draftKey(teamId, path)]: d } }))
}

export function editDraftText(teamId: string, path: string, text: string) {
  const key = draftKey(teamId, path)
  useFileDrafts.setState((s) => (s.drafts[key] ? { drafts: { ...s.drafts, [key]: { ...s.drafts[key], text } } } : s))
}

/** After a save: what was written is the new base, and its hash the one to save against next. */
export function markSaved(teamId: string, path: string, saved: string, hash: string) {
  const key = draftKey(teamId, path)
  useFileDrafts.setState((s) => (s.drafts[key] ? { drafts: { ...s.drafts, [key]: { ...s.drafts[key], base: saved, hash } } } : s))
}

export function dropDraft(teamId: string, path: string) {
  const key = draftKey(teamId, path)
  useFileDrafts.setState((s) => {
    if (!(key in s.drafts)) return s
    const drafts = { ...s.drafts }
    delete drafts[key]
    return { drafts }
  })
}

/** The paths of a company's unsaved drafts. */
export const unsavedIn = (drafts: Record<string, FileDraft>, teamId: string) =>
  Object.entries(drafts).filter(([k, d]) => k.startsWith(`${teamId}\n`) && isDirty(d)).map(([k]) => k.slice(teamId.length + 1))

export const anyUnsaved = () => Object.values(useFileDrafts.getState().drafts).some(isDirty)

/** Forgets a draft with nothing unsaved, so the file is read afresh next time; an unsaved one stays to come back to. */
export function forgetClean(teamId: string, path: string) {
  if (!isDirty(draftAt(teamId, path))) dropDraft(teamId, path)
}

const NO_VIEW: BrowserView = { expanded: [] }

export const viewOf = (views: Record<string, BrowserView>, teamId: string) => views[teamId] ?? NO_VIEW

export function editView(teamId: string, f: (v: BrowserView) => Partial<BrowserView>) {
  useFileDrafts.setState((s) => {
    const v = viewOf(s.views, teamId)
    return { views: { ...s.views, [teamId]: { ...v, ...f(v) } } }
  })
}

export function toggleFolder(teamId: string, path: string, open?: boolean) {
  editView(teamId, (v) => {
    const has = v.expanded.includes(path)
    const want = open ?? !has
    if (want === has) return {}
    return { expanded: want ? [...v.expanded, path] : v.expanded.filter((x) => x !== path) }
  })
}

export const dirAt = (dirs: Record<string, DirState>, teamId: string, path: string): DirState | undefined => dirs[draftKey(teamId, path)]

/** Reads one folder's level again, keeping what was listed before on show while it is read. */
export function loadDir(teamId: string, path: string) {
  const key = draftKey(teamId, path)
  const put = (d: DirState) => useFileDrafts.setState((s) => ({ dirs: { ...s.dirs, [key]: d } }))
  const was = useFileDrafts.getState().dirs[key]
  put(was?.status === 'ok' ? { ...was, status: 'loading' } : { status: 'loading' })
  return listProjectTree(teamId, path).then(
    (r) => put({ status: 'ok', ...r }),
    (e: Error) => put({ status: 'error', message: e.message }),
  )
}

/**
 * Leaving a company (closing its file or going to another): at once without unsaved drafts, or else once the user
 * agrees. The drafts stay either way.
 */
export function leaveTeam(teamId: string | null, proceed: () => void) {
  if (!teamId || !unsavedIn(useFileDrafts.getState().drafts, teamId).length) {
    useFileDrafts.setState({ leaving: null })
    return proceed()
  }
  useFileDrafts.setState({ leaving: { teamId, proceed } })
}

export function answerLeaving(leave: boolean) {
  const asked = useFileDrafts.getState().leaving
  useFileDrafts.setState({ leaving: null })
  if (leave) asked?.proceed()
}

/** Has the browser ask before the page closes or reloads while any draft is unsaved. Returns the undo. */
export function guardUnload() {
  const onUnload = (e: BeforeUnloadEvent) => {
    if (!anyUnsaved()) return
    e.preventDefault()
    e.returnValue = ''
  }
  window.addEventListener('beforeunload', onUnload)
  return () => window.removeEventListener('beforeunload', onUnload)
}
