// A box to write in, for a chat or a task. A word starting with "@", or "$" where there are employees, opens a list: arrows move, Tab, Enter or
// a click picks, Esc closes. With nothing to pick, Enter sends if there is onSend, else it starts a new line, and Tab indents the lines.
// Shift+Tab always outdents them. Tab never moves the focus.

import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { FileInfo, SkillInfo } from './core/domain/types'
import { useAutoGrow } from './Controls'
import { tr } from './core/i18n'
import { replicaSkills, searchFiles } from './core/ops'
import { useStore } from './core/store'
import { acceptMention, fileChoices, mentionAt, skillChoices, type MentionChoice } from './mentions'
import { indentLines } from './indent'

export function MentionBox({ box, value, teamId, replicaIds = [], label, placeholder, rows = 2, below, grow, onChange, onSend }: {
  box?: RefObject<HTMLTextAreaElement | null>
  value: string
  /** The company whose files "@" offers; with none, the box is a plain one. */
  teamId: string
  /** Whose skills "$" offers; with no one, "$" offers nothing. */
  replicaIds?: string[]
  label: string
  placeholder?: string
  rows?: number
  /** Open the list under the box, where there is no room above it. */
  below?: boolean
  /** Grow with the text. */
  grow?: boolean
  onChange: (text: string) => void
  onSend?: () => void
}) {
  const own = useRef<HTMLTextAreaElement>(null)
  const field = box ?? own
  useAutoGrow(field, value, grow)
  const id = useId()
  const [cursor, setCursor] = useState(0)
  const [focused, setFocused] = useState(false)
  // the word whose list was closed with Esc
  const [closedAt, setClosedAt] = useState<number | null>(null)
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [files, setFiles] = useState<FileInfo[]>([])
  const [active, setActive] = useState(0)
  const list = useRef<HTMLUListElement>(null)
  // the selection to put back once the text set from here is in the box
  const caret = useRef<[number, number] | null>(null)

  const found = focused && teamId ? mentionAt(value, cursor) : null
  const mention = found && found.start !== closedAt ? found : null
  const kind = mention?.kind
  const query = mention?.query ?? ''
  const start = mention?.start
  const staff = [...new Set(replicaIds)].join(' ')

  // once per "$" word, so a skill added meanwhile shows up the next time
  useEffect(() => {
    if (kind !== '$') return
    const ask = new AbortController()
    const world = useStore.getState().world
    Promise.all(staff.split(' ').filter(Boolean).map((id) => replicaSkills(world, id, ask.signal)))
      .then((lists) => setSkills([...new Map(lists.flat().map((s) => [s.name, s])).values()]))
      .catch(() => {})
    return () => ask.abort()
  }, [kind, staff, start])

  useEffect(() => {
    if (kind !== '@') { setFiles([]); return }
    const ask = new AbortController()
    searchFiles(teamId, query, ask.signal).then(setFiles).catch(() => {})
    return () => ask.abort()
  }, [kind, teamId, query])

  useEffect(() => { setActive(0) }, [kind, query])

  const choices: MentionChoice[] = kind === '$' ? skillChoices(query, skills) : kind === '@' ? fileChoices(files) : []
  const open = choices.length > 0
  const picked = Math.min(active, choices.length - 1)

  useEffect(() => {
    list.current?.children[picked]?.scrollIntoView({ block: 'nearest' })
  }, [picked, open])

  useLayoutEffect(() => {
    if (caret.current === null) return
    field.current?.setSelectionRange(...caret.current)
    caret.current = null
  }, [value, field])

  const accept = (choice: MentionChoice) => {
    if (!mention) return
    const next = acceptMention(value, mention, choice)
    caret.current = [next.cursor, next.cursor]
    setCursor(next.cursor)
    onChange(next.text)
  }

  return (
    <>
      {open && (
        <ul ref={list} id={`${id}-list`} role="listbox" aria-label={kind === '$' ? tr('技能') : tr('檔案和資料夾')} className={`fx-slip ${below ? 'fx-mention-below' : 'fx-mention'}`}>
          {choices.map((c, i) => (
            <li key={c.key} id={`${id}-${i}`} role="option" aria-selected={i === picked} className={`fx-mention-row${i === picked ? ' active' : ''}`}
              // only a mouse really moving: a list opening under a resting one must not change the pick
              onMouseMove={(e) => { if (e.movementX || e.movementY) setActive(i) }}
              onMouseDown={(e) => e.preventDefault()} // the box keeps the focus
              onClick={() => accept(c)}>
              <b>{c.name}</b>
              {c.hint && <span>{c.hint}</span>}
            </li>
          ))}
        </ul>
      )}
      <textarea ref={field} className="fx-control" rows={rows} value={value} aria-label={label} placeholder={placeholder}
        role="combobox" aria-autocomplete="list" aria-haspopup="listbox" aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined} aria-activedescendant={open ? `${id}-${picked}` : undefined}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onSelect={(e) => setCursor(e.currentTarget.selectionStart)}
        onChange={(e) => {
          const at = e.target.selectionStart
          setCursor(at)
          if (!mentionAt(e.target.value, at)) setClosedAt(null)
          onChange(e.target.value)
        }}
        onKeyDown={(e) => {
          // not while a Chinese word is still being picked in the input method
          if (e.nativeEvent.isComposing) return
          if (open) {
            const move = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0
            if (move) {
              e.preventDefault()
              setActive((picked + move + choices.length) % choices.length)
              return
            }
            if ((e.key === 'Tab' || e.key === 'Enter') && !e.shiftKey) {
              e.preventDefault()
              accept(choices[picked])
              return
            }
            if (e.key === 'Escape') {
              e.stopPropagation() // the list only, not the whole drawer
              setClosedAt(mention?.start ?? null)
              return
            }
          }
          if (e.key === 'Tab' && !e.altKey && !e.ctrlKey && !e.metaKey) {
            e.preventDefault()
            const box = e.currentTarget
            const next = indentLines(value, box.selectionStart, box.selectionEnd, e.shiftKey)
            if (next.text === value) return // nothing to outdent
            caret.current = [next.start, next.end]
            setCursor(next.end)
            onChange(next.text)
            return
          }
          if (onSend && e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            onSend()
          }
        }} />
    </>
  )
}
