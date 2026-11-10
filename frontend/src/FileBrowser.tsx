// The company file's 檔案瀏覽 tab: the project folder as a tree, each folder read as it is opened. Like the other tabs it
// is a list: a file opens on a sheet of its own (FileSheets), where it can be edited.

import { useRemote } from './core/island'
import { useEffect, type ReactNode } from 'react'
import { tr } from './core/i18n'
import { openFolder } from './core/ops'
import type { Item } from './DrawerDetail'
import { dirAt, draftKey, isDirty, loadDir, toggleFolder, useFileDrafts, viewOf } from './fileDrafts'
import { FileIcon, fileKind, FolderIcon, FolderOpenIcon } from './FileIcons'

/** Which sheet is open (by itemKey), and how to open one. */
interface Opens { teamId: string; open: string | null; onOpen: (x: Item) => void }

const fileKey = (path: string) => `file:${path}`

export function Files(p: Opens) {
  const { teamId } = p
  const expanded = useFileDrafts((s) => viewOf(s.views, teamId).expanded)
  // the project and every folder left open, on coming to the tab and again on coming back to the app, as files may
  // have changed elsewhere; a folder opened later is read as it opens
  useEffect(() => {
    const load = () => {
      for (const path of ['', ...viewOf(useFileDrafts.getState().views, teamId).expanded]) void loadDir(teamId, path)
    }
    load()
    window.addEventListener('focus', load)
    return () => window.removeEventListener('focus', load)
  }, [teamId])
  const toggle = (path: string) => {
    const opening = !expanded.includes(path)
    toggleFolder(teamId, path)
    if (opening) void loadDir(teamId, path)
  }
  return (
    <div className="fx-d-groups">
      <Level {...p} path="" expanded={expanded} onToggle={toggle} />
    </div>
  )
}

/** The entries of one folder, folders first, with the folders that are open shown under them. */
export function Level(p: Opens & { path: string; expanded: string[]; onToggle: (path: string) => void }) {
  const { teamId, path } = p
  const dir = useFileDrafts((s) => dirAt(s.dirs, teamId, path))
  const remote = useRemote()
  const drafts = useFileDrafts((s) => s.drafts)
  let body: ReactNode
  if (!dir || (dir.status === 'loading' && !dir.entries)) body = <li className="fx-files-note">{tr('讀取中…')}</li>
  else if (dir.status === 'error') body = <li className="fx-files-note" role="alert">{dir.message}</li>
  else if (!dir.entries!.length) body = <li className="fx-files-note">{tr('空資料夾')}</li>
  else body = dir.entries!.map((x) => {
    if (x.kind === 'file') {
      const unsaved = isDirty(drafts[draftKey(teamId, x.path)])
      return (
        <li key={x.path}>
          <button type="button" className={`fx-files-row fx-hit${x.ignored ? ' fx-files-ignored' : ''}`} data-path={x.path} aria-expanded={p.open === fileKey(x.path)}
            aria-controls="fx-detail" onClick={() => p.onOpen({ kind: 'file', path: x.path })}>
            <FileIcon kind={fileKind(x.name)} />
            <span className="fx-files-name">{x.name}</span>
            {unsaved && <span className="fx-files-dot" title={tr('未儲存')}><span className="fx-sr">{tr('未儲存')}</span></span>}
          </button>
        </li>
      )
    }
    const isOpen = p.expanded.includes(x.path)
    return (
      <li key={x.path}>
        <div className="fx-files-line">
          <button type="button" className={`fx-files-row fx-files-folder${x.ignored ? ' fx-files-ignored' : ''}`} data-path={x.path} aria-expanded={isOpen} onClick={() => p.onToggle(x.path)}>
            {isOpen ? <FolderOpenIcon /> : <FolderIcon />}
            <span className="fx-files-name">{x.name}</span>
          </button>
          {/* shown while the row is hovered or focused; on another island Finder would open on that computer's screen */}
          {!remote && <button type="button" className="fx-files-finder" aria-label={tr('在 Finder 打開')} title={tr('在 Finder 打開')} onClick={() => openFolder(teamId, x.path)}>
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path d="M1.75 12.5v-9h4.2l1.5 1.75h6.8v7.25z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
            </svg>
          </button>}
        </div>
        {isOpen && <Level {...p} path={x.path} />}
      </li>
    )
  })
  return (
    <ul className="fx-files-level">
      {body}
      {dir?.status !== 'error' && dir?.truncated && <li className="fx-files-note">{tr('只列出前 {count} 項', { count: 5000 })}</li>}
    </ul>
  )
}
