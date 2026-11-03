// The button under a message that copies the chat up to there for an employee to go on with: the one it had first,
// then the rest of the company. The menu floats over the page, as the chat it sits in scrolls and would cut it off:
// it opens down, or up where the window has no room below, and closes when what is under it scrolls away.

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import { tr } from './core/i18n'
import type { Replica } from './core/domain/types'
import { CrewRow } from './Pickers'

export function HandOffMenu({ crew, chairId, end, disabled, label = tr('交給…'), icon = <HandOffIcon />, text, onPick }: {
  /** Who it can go to, in order. */
  crew: Replica[]
  /** Who chairs the meeting, to stamp them so. */
  chairId?: string
  /** The button and menu, for another pick of someone, such as who chairs a meeting. */
  label?: string
  icon?: ReactNode
  /** A worded button among a sheet's tools, in place of the icon. */
  text?: boolean
  /** Line the menu up with the button's end, under the user's messages. */
  end?: boolean
  disabled?: boolean
  onPick: (replicaId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [place, setPlace] = useState<CSSProperties & { up?: boolean }>({})
  const root = useRef<HTMLSpanElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const items = useRef<Array<HTMLButtonElement | null>>([])

  useLayoutEffect(() => {
    const slip = menu.current
    const at = button.current?.getBoundingClientRect()
    if (!open || !slip || !at) return
    slip.showPopover?.()
    const gap = 6, edge = 8
    const up = window.innerHeight - at.bottom < slip.offsetHeight + gap + edge && at.top > window.innerHeight - at.bottom
    const left = end ? at.right - slip.offsetWidth : at.left
    setPlace({
      up,
      top: up ? Math.max(edge, at.top - gap - slip.offsetHeight) : at.bottom + gap,
      left: Math.min(Math.max(edge, left), window.innerWidth - slip.offsetWidth - edge),
      maxHeight: (up ? at.top : window.innerHeight - at.bottom) - gap - edge,
    })
  }, [open, end])

  useEffect(() => {
    if (!open) return
    items.current[0]?.focus()
    const away = (e: PointerEvent) => !root.current?.contains(e.target as Node) && setOpen(false)
    // floating, it would stay put while the chat under it moves
    const moved = (e: Event) => !menu.current?.contains(e.target as Node) && setOpen(false)
    const shut = () => setOpen(false)
    document.addEventListener('pointerdown', away)
    document.addEventListener('scroll', moved, true)
    window.addEventListener('resize', shut)
    return () => {
      document.removeEventListener('pointerdown', away)
      document.removeEventListener('scroll', moved, true)
      window.removeEventListener('resize', shut)
    }
  }, [open])

  const close = () => {
    setOpen(false)
    button.current?.focus()
  }
  const onKey = (e: KeyboardEvent) => {
    const at = items.current.indexOf(document.activeElement as HTMLButtonElement)
    const last = crew.length - 1
    const to = { ArrowDown: at === last ? 0 : at + 1, ArrowUp: at <= 0 ? last : at - 1, Home: 0, End: last }[e.key]
    if (to !== undefined) items.current[to]?.focus()
    else if (e.key === 'Escape') close()
    else if (e.key === 'Tab') setOpen(false)
    else return
    if (e.key !== 'Tab') e.preventDefault()
    e.stopPropagation()
  }
  const { up, ...spot } = place

  return (
    <span className="fx-handoff" ref={root} onKeyDown={open ? onKey : undefined}>
      <button ref={button} type="button" className={text ? 'fx-tool fx-tool-text fx-hit' : 'fx-chat-edit fx-hit'} aria-label={text ? undefined : label}
        title={text ? undefined : label} aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={() => { setPlace({}); setOpen(!open) }}>
        {text ? label : icon}
      </button>
      {open && (
        // a manual popover sits above the page, out of reach of the chat's scrolling and the sheet's tilt
        <div ref={menu} popover="manual" role="menu" aria-label={label} style={spot}
          className={['fx-slip fx-handoff-menu', up && 'fx-handoff-up', spot.top === undefined && 'fx-handoff-placing'].filter(Boolean).join(' ')}>
          {crew.map((r, i) => (
            <button key={r.id} ref={(el) => { items.current[i] = el }} type="button" role="menuitem" className="fx-slip-row" onClick={() => { setOpen(false); onPick(r.id) }}>
              <CrewRow r={r} chair={r.id === chairId} />
            </button>
          ))}
        </div>
      )}
    </span>
  )
}

/** A branch: the chat so far, going on along another line. */
export function HandOffIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path d="M4 5v1.5a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2V5M8 8.5V11" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="4" cy="3.3" r="1.7" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="12" cy="3.3" r="1.7" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="8" cy="12.7" r="1.7" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  )
}
