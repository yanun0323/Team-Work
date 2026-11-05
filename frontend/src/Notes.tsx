// A company's notes: a sticky note pinned to the corner of its file, opening on a sheet of their own. They are
// the Markdown in the project's .team-work/NOTES.md, shown rendered with its HTML and pictures; a click on them turns the sheet into an
// editor, saved as one types and once more when it is left.

import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { create } from 'zustand'
import { tr } from './core/i18n'
import { projectImageUrl, readNotes, saveNotes } from './core/ops'
import { useAutoGrow } from './Controls'
import { EditTool, Heading, type Head } from './DrawerDetail'
import { Markdown, MarkdownLine } from './Markdown'

export const NOTES_FILE = '.team-work/NOTES.md'

/** How long typing has to pause before the notes are written. */
const SAVE_AFTER = 600

/** How many lines of the notes the pinned note shows. */
const PIN_LINES = 5

/** Each company's notes as last read or typed, shared by the pinned note and the sheet. */
const useNotesText = create<Record<string, string>>(() => ({}))
const keepText = (teamId: string, text: string) => useNotesText.setState({ [teamId]: text })

/** A line on the pinned note: what kind of block it starts, its mark (a list number), and its text with inline marks kept. */
export type NoteLine = { kind: 'heading' | 'todo' | 'done' | 'item' | 'number' | 'quote' | 'code' | 'text'; mark?: string; text: string }

/** The first lines of the notes with something on them, for the pinned note: each one's block read off its start. */
export function noteLines(text: string, count = PIN_LINES) {
  const out: NoteLine[] = []
  let fenced = false
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    let m: RegExpMatchArray | null
    if (line.startsWith('```')) {
      fenced = !fenced
      continue
    }
    if (!line) continue
    if (fenced) out.push({ kind: 'code', text: raw })
    else if ((m = line.match(/^#{1,6}\s+(.*)$/))) out.push({ kind: 'heading', text: m[1] })
    else if ((m = line.match(/^[-*+]\s+\[([ xX])\]\s+(.*)$/))) out.push({ kind: m[1] === ' ' ? 'todo' : 'done', text: m[2] })
    else if ((m = line.match(/^[-*+]\s+(.*)$/))) out.push({ kind: 'item', text: m[1] })
    else if ((m = line.match(/^(\d+[.)])\s+(.*)$/))) out.push({ kind: 'number', mark: m[1], text: m[2] })
    else if ((m = line.match(/^>\s?(.*)$/))) out.push({ kind: 'quote', text: m[1] })
    else out.push({ kind: 'text', text: line })
    if (out.length === count) break
  }
  return out
}

const MARKS: Partial<Record<NoteLine['kind'], string>> = { todo: '☐', done: '☑', item: '•' }

/** One line of the pinned note, drawn as Markdown; no links, as the note itself is a button. */
function PeekLine({ line }: { line: NoteLine }) {
  const mark = line.mark ?? MARKS[line.kind]
  return (
    <span className={`fx-notes-line fx-notes-${line.kind}`}>
      {mark && <span className="fx-notes-mark">{mark}</span>}
      {line.kind === 'code' ? <code>{line.text}</code> : <MarkdownLine text={line.text} noLinks />}
    </span>
  )
}

/** The sticky note stuck askew on the company file's upper right corner, one corner lifting a little, the first lines of
 * the notes on it; it opens them. */
export function NotesPin({ teamId, open, onOpen }: { teamId: string; open: boolean; onOpen: () => void }) {
  const text = useNotesText((s) => s[teamId])
  // read for each company, and again on coming back to the app, as the file may have been edited elsewhere
  useEffect(() => {
    const stop = new AbortController()
    const load = () => readNotes(teamId, stop.signal).then((t) => keepText(teamId, t), () => {})
    load()
    window.addEventListener('focus', load)
    return () => {
      stop.abort()
      window.removeEventListener('focus', load)
    }
  }, [teamId])
  return (
    <button type="button" className="fx-notes-pin fx-hit" aria-label={tr('筆記')} title={tr('筆記')} aria-expanded={open} onClick={onOpen}>
      {/* the shadow of the lifted corner, under the paper */}
      <span className="fx-notes-lift" aria-hidden="true" />
      <span className="fx-notes-paper" aria-hidden="true">
        <span className="fx-notes-peek">
          {noteLines(text ?? '').map((line, i) => <PeekLine key={i} line={line} />)}
        </span>
      </span>
    </button>
  )
}

/** The notes on their sheet: read as Markdown, or written in a box once clicked. */
export function NotesSheet({ teamId, ...h }: Head & { teamId: string }) {
  const [text, setText] = useState<string>()
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(false)
  const box = useRef<HTMLTextAreaElement>(null)
  // what the file says, as far as this sheet knows, and the timer of a save waiting for typing to pause
  const saved = useRef<string>(undefined)
  const timer = useRef(0)
  const latest = useRef<string>(undefined)
  latest.current = text

  const save = () => {
    window.clearTimeout(timer.current)
    const next = latest.current
    if (next === undefined || next === saved.current) return
    saved.current = next
    saveNotes(teamId, next).then(() => setError(''), (e: Error) => {
      saved.current = undefined
      setError(e.message)
    })
  }

  // read on opening, and again on coming back to the app, as the file may have been edited elsewhere
  const editingNow = useRef(editing)
  editingNow.current = editing
  useEffect(() => {
    const stop = new AbortController()
    const load = () => {
      if (editingNow.current) return
      readNotes(teamId, stop.signal).then((t) => {
        if (editingNow.current) return
        saved.current = t
        setText(t)
        keepText(teamId, t)
        setError('')
      }, (e: Error) => { if (e.name !== 'AbortError') setError(e.message) })
    }
    load()
    window.addEventListener('focus', load)
    return () => {
      stop.abort()
      window.removeEventListener('focus', load)
      // put away mid-sentence: what was typed is kept
      save()
    }
  }, [teamId])

  useAutoGrow(box, text ?? '', editing)
  useEffect(() => {
    const el = box.current
    if (!editing || !el) return
    el.focus({ preventScroll: true })
    el.setSelectionRange(el.value.length, el.value.length)
  }, [editing])

  const leave = () => {
    save()
    setEditing(false)
  }
  // a click on the notes writes in them, unless it follows a link or ends a selection
  const onRead = (e: MouseEvent) => {
    if (text === undefined || (e.target as HTMLElement).closest('a, summary') || window.getSelection()?.toString()) return
    setEditing(true)
  }

  return (
    <>
      {/* pressing a tool keeps the box focused, so leaving it is the tool's doing, not the blur's */}
      <div className="fx-tools" onMouseDown={(e) => { if (editing) e.preventDefault() }}>
        <EditTool pressed={editing} onClick={() => (editing ? leave() : text !== undefined && setEditing(true))} />
      </div>
      <header className="fx-d-head">
        <Heading {...h}>{tr('筆記')}</Heading>
        <p className="fx-d-meta"><code>{NOTES_FILE}</code></p>
      </header>
      <div className={editing ? 'fx-doc-note fx-notes fx-notes-editing' : 'fx-doc-note fx-notes'}>
        {editing ? (
          <textarea ref={box} className="fx-notes-box" value={text} spellCheck={false} aria-label={tr('筆記')}
            onChange={(e) => {
              setText(e.target.value)
              keepText(teamId, e.target.value)
              window.clearTimeout(timer.current)
              timer.current = window.setTimeout(save, SAVE_AFTER)
            }}
            onBlur={leave} />
        ) : (
          <div className="fx-notes-read" onClick={onRead}>
            {text === undefined ? !error && <p className="fx-d-text">{tr('讀取中…')}</p>
              : text.trim() ? <Markdown text={text} project={{ dir: '.team-work', imageUrl: (p) => projectImageUrl(teamId, p) }} />
              : <p className="fx-notes-empty">{tr('點一下開始寫')}</p>}
          </div>
        )}
      </div>
      {error && <p className="fx-d-text" role="alert">{error}</p>}
    </>
  )
}
