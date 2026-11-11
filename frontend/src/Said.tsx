// A mention in what someone wrote, drawn as a small blue button: "@name" opens the employee, "$skill" its instructions,
// a file opens to read and a folder in Finder. Files and folders show an outline of one in place of their "#". What a
// mention can open comes from the sheet the text is on; where it opens nothing, it is drawn the same but stays text.

import { createContext, useContext } from 'react'
import { colon, tr } from './core/i18n'
import { useStore } from './core/store'
import { PixelFace } from './core/voxel/PixelFace'
import { ID_WORD, type IdLookup, type SaidPart } from './mentions'

export interface SaidActions {
  /** Opens an employee; `canPerson` says whether they are still there to open. */
  person?: (id: string) => void
  canPerson?: (id: string) => boolean
  /** Opens a task's record by its id. */
  fact?: (id: string) => void
  /** Opens a task by its id. */
  task?: (id: string) => void
  file?: (path: string) => void
  folder?: (path: string) => void
  skill?: (name: string) => void
}

export const SaidContext = createContext<SaidActions>({})

const FileOutline = () => (
  <svg className="fx-said-icon" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
    <path d="M4 1.75h5l3 3v9.5H4z M9 1.75v3h3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
  </svg>
)

const FolderOutline = () => (
  <svg className="fx-said-icon" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
    <path d="M1.75 4.25v8.5h12.5v-7H7.5L6 3.25H1.75z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
  </svg>
)

/** How one gone is shown where an id named them: faint, with the step their run was of. */
export const goneCrew = (step?: string) => (step ? tr('已刪除的員工（{step}）', { step }) : tr('已刪除的員工'))

/**
 * The words for one an id named who is not here: gone, or for a run nobody works yet, its step; or for a run no task
 * has, that it is gone.
 */
const absent = ({ id, step }: { id?: string; step?: string }) => (id ? goneCrew(step) : step || tr('已移除的步驟'))

export const FACT_KIND = { decision: '決策', constraint: '限制' } as const

/** A record in a few words: its kind and how it starts. */
const factWords = ({ kind, text }: NonNullable<SaidPart['fact']>) => {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim())
  return `${tr(FACT_KIND[kind])}${colon()}${chars.length > 12 ? `${chars.slice(0, 12).join('')}…` : chars.join('')}`
}

/** A text with the ids `ids` knows written as names, for where only words go, as a label. */
export function idsAsNames(text: string, ids: IdLookup, replicas: Record<string, { name: string }>) {
  return text.replace(ID_WORD, (word) => {
    const named = ids(word)
    if (!named) return word
    if (named.kind === 'fact') return named.fact ? factWords(named.fact) : tr('已移除的紀錄')
    return (named.id && replicas[named.id]?.name) || absent(named)
  })
}

/** An employee named by an id: their face and name, opening them, with another task's on hover; faint words when they are gone. */
function CrewChip({ id, step, task }: { id?: string; step?: string; task?: string }) {
  const act = useContext(SaidContext)
  const r = useStore((s) => (id ? s.world.replicas[id] : undefined))
  const title = task && (step ? `${task} · ${step}` : task)
  if (!r) return <span className="fx-said-gone" title={title}>{absent({ id, step })}</span>
  const body = <><PixelFace look={r.look} name={r.name} size={14} />{r.name}</>
  return act.person && (act.canPerson?.(r.id) ?? true)
    ? <button type="button" className="fx-said fx-said-crew fx-hit" title={title} onClick={() => act.person!(r.id)}>{body}</button>
    : <span className="fx-said fx-said-crew" title={title}>{body}</span>
}

/** A record named by its id: its kind and first words, opening the whole of it on a sheet; faint words when it is gone. */
function FactChip({ id, fact }: { id: string; fact?: SaidPart['fact'] }) {
  const act = useContext(SaidContext)
  if (!fact) return <span className="fx-said-gone">{tr('已移除的紀錄')}</span>
  return act.fact
    ? <button type="button" className="fx-said fx-said-fact fx-hit" onClick={() => act.fact!(id)}>{factWords(fact)}</button>
    : <span className="fx-said fx-said-fact">{factWords(fact)}</span>
}

/** One mention, as `saidParts` found it. */
export function SaidChip({ part }: { part: SaidPart }) {
  if (part.kind === 'crew') return <CrewChip id={part.id} step={part.step} task={part.task} />
  if (part.kind === 'fact') return <FactChip id={part.text} fact={part.fact} />
  return <Mentioned part={part} />
}

function Mentioned({ part }: { part: SaidPart }) {
  const act = useContext(SaidContext)
  const { kind, text } = part
  const path = part.path ?? ''
  const label = kind === '#' ? path || text : text
  const open = kind === '@' ? (part.id && act.person && (act.canPerson?.(part.id) ?? true) ? () => act.person!(part.id!) : undefined)
    : kind === '#' ? (part.dir ? act.folder && (() => act.folder!(path)) : act.file && (() => act.file!(path)))
    : kind === '$' ? act.skill && (() => act.skill!(part.skill ?? text.slice(1)))
    : undefined
  const body = <>{kind === '#' && (part.dir ? <FolderOutline /> : <FileOutline />)}{label}</>
  const className = `fx-said fx-said-${kind === '@' ? 'person' : kind === '#' ? (part.dir ? 'folder' : 'file') : 'skill'}`
  return open
    ? <button type="button" className={`${className} fx-hit`} onClick={open}>{body}</button>
    : <span className={className}>{body}</span>
}
