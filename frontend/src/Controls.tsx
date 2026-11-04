// Form controls for the company file, drawn to match the newsprint: a pick-list that drops a paper slip,
// and a number field with paper − / + tabs. Both keep the keyboard behaviour of the native controls.

import { tr } from './core/i18n'
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from 'react'

/** A text box as tall as its text: never under its `rows`, and no taller than the CSS `max-height`. */
export function useAutoGrow(box: RefObject<HTMLTextAreaElement | null>, value: string, on = true) {
  useLayoutEffect(() => {
    const el = box.current
    if (!on || !el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [box, value, on])
}

const Chevron = () => (
  <svg className="fx-chevron" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

export const Check = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M2 6.5 4.8 9 10 3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

/**
 * A select-only combobox (WAI-ARIA pattern): a button showing the value, opening a listbox on a paper slip.
 * Arrows, Home/End and typing a letter move; Enter, Space or a click picks; Escape or Tab closes.
 */
export function Select({ label, value, options, labelOf = (o) => o, onChange, shownAs, rowOf, groups, groupOf, disabled, picked: isPicked }: {
  label: string
  disabled?: boolean
  value: string
  options: string[]
  /** What to show for an option, when the value itself is an id. */
  labelOf?: (o: string) => string
  onChange: (v: string) => void
  /** The closed list's value, when it is more than the label. */
  shownAs?: (o: string) => ReactNode
  /** An option's whole row, when it is more than the label; it marks being picked itself. */
  rowOf?: (o: string, picked: boolean) => ReactNode
  /** Headings to list the options under; each group's options must follow each other in `options`. */
  groups?: { label: string; count: number }[]
  groupOf?: (o: string) => number
  /** Makes it a list to pick several from: which are picked; picking one turns it on or off and leaves the list open. */
  picked?: (o: string) => boolean
}) {
  const id = useId()
  const several = !!isPicked
  const on = (o: string) => (isPicked ? isPicked(o) : o === value)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLUListElement>(null)

  const show = (at = Math.max(0, options.indexOf(value))) => {
    setActive(at)
    setOpen(true)
  }
  const pick = (i: number) => {
    if (several) {
      if (options[i] !== undefined) onChange(options[i])
      return
    }
    if (options[i] !== undefined && options[i] !== value) onChange(options[i])
    setOpen(false)
    button.current?.focus()
  }

  // a click anywhere else closes it
  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => !root.current?.contains(e.target as Node) && setOpen(false)
    document.addEventListener('pointerdown', away)
    return () => document.removeEventListener('pointerdown', away)
  }, [open])
  // keep the active option in view when the list is longer than the slip
  useEffect(() => {
    const slip = list.current
    const row = slip?.querySelector<HTMLElement>('.active')
    if (!open || !slip || !row) return
    // only the slip moves; scrollIntoView would drag the panel behind it along too
    // offsets, as the slip is still tilted while it drops in
    const pad = 5
    if (row.offsetTop - pad < slip.scrollTop) slip.scrollTop = row.offsetTop - pad
    else if (row.offsetTop + row.offsetHeight + pad > slip.scrollTop + slip.clientHeight) {
      slip.scrollTop = row.offsetTop + row.offsetHeight + pad - slip.clientHeight
    }
  }, [open, active])
  const hasRows = !!rowOf
  // a tall slip stops short of the panel's edge, as long as that leaves it room to be used
  useLayoutEffect(() => {
    const slip = list.current
    if (!open || !hasRows || !slip) return
    let up = slip.parentElement
    while (up && !/auto|scroll|hidden/.test(getComputedStyle(up).overflowY)) up = up.parentElement
    if (!up) return
    // the slip is still 6px high here, dropping in
    const room = up.getBoundingClientRect().bottom - slip.getBoundingClientRect().top - 14
    if (room >= 160) slip.style.maxHeight = `${Math.min(room, slip.offsetHeight)}px`
  }, [open, hasRows])

  const onKey = (e: KeyboardEvent) => {
    const last = options.length - 1
    const move = (i: number) => (open ? setActive(i) : show(i))
    switch (e.key) {
      case 'ArrowDown': move(open ? Math.min(last, active + 1) : Math.max(0, options.indexOf(value))); break
      case 'ArrowUp': move(open ? Math.max(0, active - 1) : Math.max(0, options.indexOf(value))); break
      case 'Home': move(0); break
      case 'End': move(last); break
      case 'Enter':
      case ' ':
        if (open) pick(active)
        else show()
        break
      case 'Escape':
        if (!open) return
        // close the list only, not the whole drawer
        e.stopPropagation()
        setOpen(false)
        break
      case 'Tab':
        // a list of several closes as it is; a pick of one takes the active option
        if (open && several) setOpen(false)
        else if (open) pick(active)
        return
      default: {
        if (e.key.length !== 1) return
        const from = open ? active : options.indexOf(value)
        const hit = [...options.slice(from + 1), ...options.slice(0, from + 1)]
          .find((o) => labelOf(o).toLowerCase().startsWith(e.key.toLowerCase()))
        if (hit) move(options.indexOf(hit))
        return
      }
    }
    e.preventDefault()
  }

  const option = (o: string) => {
    const i = options.indexOf(o)
    return (
      <li
        key={o} id={`${id}-${i}`} role="option" aria-selected={on(o)}
        className={[i === active && 'active', rowOf && 'fx-slip-row'].filter(Boolean).join(' ') || undefined}
        // keep focus on the button so the keyboard keeps working
        onPointerDown={(e) => e.preventDefault()}
        onPointerEnter={() => setActive(i)} onClick={() => pick(i)}
      >
        {rowOf ? rowOf(o, on(o)) : (
          <>
            <span className="fx-slip-check">{on(o) && <Check />}</span>
            {labelOf(o)}
          </>
        )}
      </li>
    )
  }

  return (
    <div className="fx-field">
      <span id={`${id}-label`}>{label}</span>
      <div className="fx-select" ref={root}>
        <button
          ref={button} type="button" role="combobox" className="fx-control" disabled={disabled}
          aria-labelledby={`${id}-label`} aria-haspopup="listbox" aria-expanded={open} aria-controls={`${id}-list`}
          aria-activedescendant={open ? `${id}-${active}` : undefined}
          onClick={() => (open ? setOpen(false) : show())} onKeyDown={onKey}
        >
          <span className="fx-select-value">{shownAs ? shownAs(value) : labelOf(value)}</span>
          <Chevron />
        </button>
        {open && (
          <ul ref={list} id={`${id}-list`} role="listbox" aria-labelledby={`${id}-label`} aria-multiselectable={several || undefined} className={`fx-slip${rowOf ? ' fx-slip-rows' : ''}`}>
            {groups && groupOf
              ? groups.map((g, at) => (
                <li key={at} role="group" aria-label={g.label} className="fx-slip-group">
                  <span className="fx-slip-head" aria-hidden="true">{g.label}<span className="fx-count">{g.count}</span></span>
                  <ul role="presentation">{options.filter((o) => groupOf(o) === at).map(option)}</ul>
                </li>
              ))
              : options.map(option)}
          </ul>
        )}
      </div>
    </div>
  )
}

/** Rounds away float drift, so 0.5 steps stay 1.5 instead of 1.4999999. */
const tidy = (v: number) => Math.round(v * 1000) / 1000

/** A field that is on or off: its label, then a tick box. */
export function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  const id = useId()
  return (
    <div className="fx-field">
      <label htmlFor={id}>{label}</label>
      <input id={id} type="checkbox" className="fx-tick" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </div>
  )
}

/** A field with a few short choices side by side, all in view. Native radios, so the arrow keys move between them. */
export function Switcher<T extends string>({ label, value, options, labelOf, onChange }: {
  label: string
  value: T
  options: readonly T[]
  labelOf: (option: T) => string
  onChange: (option: T) => void
}) {
  const id = useId()
  return (
    <div className="fx-field">
      <span id={id}>{label}</span>
      <div className="fx-switcher" role="radiogroup" aria-labelledby={id}
        style={{ '--count': options.length, '--at': options.indexOf(value) } as CSSProperties}>
        <span className="fx-switcher-thumb" aria-hidden="true" />
        {options.map((o) => (
          <label key={o} className="fx-switcher-option">
            <input type="radio" name={id} checked={o === value} onChange={() => onChange(o)} />
            <span>{labelOf(o)}</span>
          </label>
        ))}
      </div>
    </div>
  )
}

/** A number field with − and + tabs either side; typing and the arrow keys still work as usual. */
export function Stepper({ label, unit, value, min, step, onChange }: {
  label: string
  unit: string
  value: number
  min: number
  step: number
  onChange: (v: number) => void
}) {
  const id = useId()
  const by = (d: number) => onChange(tidy(Math.max(min, value + d * step)))
  return (
    <div className="fx-field">
      <label htmlFor={id}>{label}</label>
      <span className="fx-unit">
        <span className="fx-stepper">
          <button type="button" tabIndex={-1} aria-label={tr('{label}減少', { label })} disabled={value - step < min} onClick={() => by(-1)}>
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1.5 5h7" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>
          </button>
          <input
            id={id} type="number" inputMode="decimal" min={min} step={step} value={value}
            onChange={(e) => {
              const v = Number(e.target.value)
              if (e.target.value !== '' && Number.isFinite(v) && v >= min) onChange(v)
            }}
          />
          <button type="button" tabIndex={-1} aria-label={tr('{label}增加', { label })} onClick={() => by(1)}>
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1.5 5h7M5 1.5v7" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>
          </button>
        </span>
        {unit}
      </span>
    </div>
  )
}

/** The round badge of something waiting on the user: red ! when they must answer, green merge mark when work only needs their nod. */
export function WaitBadge({ merge, inline, label = merge ? tr('可以合併') : tr('需要回覆') }: { merge?: boolean; inline?: boolean; label?: string }) {
  return (
    <span className={`fx-badge${merge ? ' fx-badge-merge' : ''}${inline ? ' fx-badge-inline' : ''}`} title={label}>
      {merge
        ? <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3 1.5V3.5C3 5.8 6 6 6 8.2V10.5M9 1.5V3.5C9 5.8 6 6 6 8.2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
        : <span aria-hidden="true">!</span>}
      <span className="fx-sr">{label}</span>
    </span>
  )
}
