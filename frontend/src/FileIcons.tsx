// The icons of files and folders, by what a name shows them to be: in the 檔案瀏覽 tree and the "#" menu alike.

import type { ReactNode } from 'react'

/** What a file's icon shows it to be, by its name. */
export type FileKind = 'media' | 'shell' | 'text'

export function fileKind(name: string): FileKind {
  if (/\.(png|jpe?g|gif|webp|svg|bmp|ico|heic|tiff?|mp4|mov|m4v|webm|mkv|avi|mp3|wav|m4a|aac|flac|ogg)$/i.test(name)) return 'media'
  if (/\.(sh|bash|zsh|fish|command)$/i.test(name)) return 'shell'
  return 'text'
}

const icon = (kind: string, d: ReactNode) => (
  <svg className={`fx-files-icon fx-files-icon-${kind}`} viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"
    fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" strokeLinecap="round">{d}</svg>
)
// filled, in Finder's sky blue: the back and tab a shade deeper than the front
const folder = (kind: string, front: string) => (
  <svg className={`fx-files-icon fx-files-icon-${kind}`} viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
    <path className="fx-files-folder-back" d="M1.5 3.5a1 1 0 0 1 1-1h3.4l1.6 1.6h6a1 1 0 0 1 1 1V12.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" />
    <path className="fx-files-folder-front" d={front} />
  </svg>
)
export const FolderIcon = () => folder('folder', 'M1.5 6a1 1 0 0 1 1-1h11a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z')
export const FolderOpenIcon = () => folder('folder-open', 'M3.4 7a1 1 0 0 1 .95-.7h10.4a.75.75 0 0 1 .7 1l-1.7 5.5a1 1 0 0 1-.95.7H2.3a.75.75 0 0 1-.7-1z')

export function FileIcon({ kind }: { kind: FileKind }) {
  const page = <path d="M3.75 1.75h5.5l3 3v9.5h-8.5z" />
  if (kind === 'media') return icon('media', <><rect x="2" y="2.75" width="12" height="10.5" rx="1" /><circle cx="5.75" cy="6.25" r="1.1" /><path d="M2.5 12.5l3.75-3.75 2.5 2.5 1.75-1.75 3 3" /></>)
  if (kind === 'shell') return icon('shell', <><rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1" /><path d="M4.5 6.25l2 1.75-2 1.75M8 10h3.25" /></>)
  return icon('file', <>{page}<path d="M9.25 1.75v3h3M5.75 8h4.5M5.75 10.5h4.5" /></>)
}

/** A row's icon: a folder, open or shut, or a file by its name. */
export function EntryIcon({ name, dir, open }: { name: string; dir: boolean; open?: boolean }) {
  return dir ? (open ? <FolderOpenIcon /> : <FolderIcon />) : <FileIcon kind={fileKind(name)} />
}
