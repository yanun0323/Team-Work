// The button under a message that copies the chat up to there for an employee to go on with: the one it had first,
// then the rest of the company. The menu floats over the page, as the chat it sits in scrolls and would cut it off:
// it opens down, or up where the window has no room below, and closes when what is under it scrolls away. A company
// of more than `FILTER_FROM` opens it with a filter on top, finding people by name or blueprint, which then takes the keys.

import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import { FILTER_FROM, filterOptions } from './Controls'
import { tr } from './core/i18n'
import { composing } from './ime'
import type { Replica } from './core/domain/types'
import { CrewRow } from './Pickers'
import { useStore } from './core/store'
import { blueprintLabel } from './crew'

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
  const id = useId()
  const [open, setOpen] = useState(false)
  const [place, setPlace] = useState<CSSProperties & { up?: boolean }>({})
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const root = useRef<HTMLSpanElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const filterBox = useRef<HTMLInputElement>(null)
  const items = useRef<Array<HTMLButtonElement | null>>([])
  const filtering = crew.length > FILTER_FROM
  const w = useStore((s) => s.world)
  // found by name or by blueprint, as the row shows both
  const textOf = (rid: string) => { const r = crew.find((x) => x.id === rid); return r ? `${r.name} ${blueprintLabel(w, r)}` : '' }
  // who the menu shows; `active` counts in it
  const shown = filtering
    ? filterOptions(crew.map((r) => r.id), textOf, query).map((rid) => crew.find((r) => r.id === rid) as Replica)
    : crew

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
      // held from its foot when it opens up, so a list the filter cuts short stays by the button
      ...(up ? { bottom: window.innerHeight - at.top + gap } : { top: at.bottom + gap }),
      left: Math.min(Math.max(edge, left), window.innerWidth - slip.offsetWidth - edge),
      // as wide as it opened, not jumping with each name the filter takes away
      width: filtering ? slip.offsetWidth : undefined,
      maxHeight: (up ? at.top : window.innerHeight - at.bottom) - gap - edge,
    })
  }, [open, end, filtering])

  useEffect(() => {
    if (!open) return
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
  }, [open, filtering])
  // the focus moves in once the menu is placed: hidden while it is being measured, it could not take it
  const placed = place.top !== undefined || place.bottom !== undefined
  useEffect(() => {
    if (!open || !placed) return
    if (filtering) filterBox.current?.focus({ preventScroll: true })
    else items.current[0]?.focus({ preventScroll: true })
  }, [open, placed, filtering])
  // keep the active one in view; only the menu scrolls, as moving the chat under it would close it
  useEffect(() => {
    const slip = menu.current
    const row = items.current[active]
    if (!open || !filtering || !slip || !row) return
    const pad = 5
    const top = pad + (filterBox.current?.parentElement?.offsetHeight ?? 0)
    if (row.offsetTop - top < slip.scrollTop) slip.scrollTop = row.offsetTop - top
    else if (row.offsetTop + row.offsetHeight + pad > slip.scrollTop + slip.clientHeight) {
      slip.scrollTop = row.offsetTop + row.offsetHeight + pad - slip.clientHeight
    }
  }, [open, filtering, active, query])

  const pick = (rid: string) => {
    setOpen(false)
    onPick(rid)
  }
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
  // keys typed in the filter; a key the input method takes is its own
  const onFilterKey = (e: KeyboardEvent) => {
    if (composing(e.nativeEvent as globalThis.KeyboardEvent)) return
    const last = shown.length - 1
    switch (e.key) {
      case 'ArrowDown': setActive(active >= last ? 0 : active + 1); break
      case 'ArrowUp': setActive(active <= 0 ? last : active - 1); break
      case 'Enter': if (shown[active]) pick(shown[active].id); break
      case 'Escape':
        if (query) { setQuery(''); setActive(0) }
        else close()
        break
      case 'Tab':
        // the focus goes back to the button first, so Tab moves on from there
        close()
        e.stopPropagation()
        return
      default: return
    }
    e.preventDefault()
    e.stopPropagation()
  }
  const { up, ...spot } = place

  return (
    <span className="fx-handoff" ref={root} onKeyDown={open && !filtering ? onKey : undefined}>
      <button ref={button} type="button" className={text ? 'fx-tool fx-tool-text fx-hit' : 'fx-chat-edit fx-hit'} aria-label={text ? undefined : label}
        title={text ? undefined : label} aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={() => { setPlace({}); setQuery(''); setActive(0); setOpen(!open) }}>
        {text ? label : icon}
      </button>
      {open && (
        // a manual popover sits above the page, out of reach of the chat's scrolling and the sheet's tilt
        <div ref={menu} id={`${id}-menu`} popover="manual" role="menu" aria-label={label} style={spot}
          className={['fx-slip fx-handoff-menu', up && 'fx-handoff-up', !placed && 'fx-handoff-placing', filtering && 'fx-slip-filtered'].filter(Boolean).join(' ')}>
          {filtering && (
            <div className="fx-slip-filter">
              <input
                ref={filterBox} type="text" role="combobox" className="fx-control" value={query} placeholder={tr('搜尋')}
                autoComplete="off" spellCheck={false} aria-label={label} aria-autocomplete="list" aria-expanded="true"
                aria-controls={`${id}-menu`} aria-activedescendant={shown.length ? `${id}-${active}` : undefined}
                onChange={(e) => { setQuery(e.target.value); setActive(0) }} onKeyDown={onFilterKey}
              />
            </div>
          )}
          {shown.map((r, i) => (
            <button
              key={r.id} id={`${id}-${i}`} ref={(el) => { items.current[i] = el }} type="button" role="menuitem"
              className={['fx-slip-row', filtering && i === active && 'active'].filter(Boolean).join(' ')}
              // with a filter, the focus stays in it and the pointer only marks who Enter would pick
              tabIndex={filtering ? -1 : undefined}
              onPointerDown={filtering ? (e) => e.preventDefault() : undefined}
              onPointerEnter={filtering ? () => setActive(i) : undefined}
              onClick={() => pick(r.id)}
            >
              <CrewRow r={r} chair={r.id === chairId} />
            </button>
          ))}
          {!shown.length && <p className="fx-slip-none" role="status">{tr('沒有符合的項目')}</p>}
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
