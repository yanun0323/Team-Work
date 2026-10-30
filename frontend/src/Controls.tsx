// Form controls for the company file, drawn to match the newsprint: a pick-list that drops a paper slip,
// and a number field with paper − / + tabs. Both keep the keyboard behaviour of the native controls.

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'

const Chevron = () => (
  <svg className="fx-chevron" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const Check = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
    <path d="M2 6.5 4.8 9 10 3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

/**
 * A select-only combobox (WAI-ARIA pattern): a button showing the value, opening a listbox on a paper slip.
 * Arrows, Home/End and typing a letter move; Enter, Space or a click picks; Escape or Tab closes.
 */
export function Select({ label, value, options, labelOf = (o) => o, onChange }: {
  label: string
  value: string
  options: string[]
  /** What to show for an option, when the value itself is an id. */
  labelOf?: (o: string) => string
  onChange: (v: string) => void
}) {
  const id = useId()
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
    if (open) list.current?.children[active]?.scrollIntoView({ block: 'nearest' })
  }, [open, active])

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
        if (open) pick(active)
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

  return (
    <div className="fx-field">
      <span id={`${id}-label`}>{label}</span>
      <div className="fx-select" ref={root}>
        <button
          ref={button} type="button" role="combobox" className="fx-control"
          aria-labelledby={`${id}-label`} aria-haspopup="listbox" aria-expanded={open} aria-controls={`${id}-list`}
          aria-activedescendant={open ? `${id}-${active}` : undefined}
          onClick={() => (open ? setOpen(false) : show())} onKeyDown={onKey}
        >
          <span className="fx-select-value">{labelOf(value)}</span>
          <Chevron />
        </button>
        {open && (
          <ul ref={list} id={`${id}-list`} role="listbox" aria-labelledby={`${id}-label`} className="fx-slip">
            {options.map((o, i) => (
              <li
                key={o} id={`${id}-${i}`} role="option" aria-selected={o === value}
                className={i === active ? 'active' : undefined}
                // keep focus on the button so the keyboard keeps working
                onPointerDown={(e) => e.preventDefault()}
                onPointerEnter={() => setActive(i)} onClick={() => pick(i)}
              >
                <span className="fx-slip-check">{o === value && <Check />}</span>
                {labelOf(o)}
              </li>
            ))}
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
          <button type="button" tabIndex={-1} aria-label={`${label}減少`} disabled={value - step < min} onClick={() => by(-1)}>
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1.5 5h7" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>
          </button>
          <input
            id={id} type="number" inputMode="decimal" min={min} step={step} value={value}
            onChange={(e) => {
              const v = Number(e.target.value)
              if (e.target.value !== '' && Number.isFinite(v) && v >= min) onChange(v)
            }}
          />
          <button type="button" tabIndex={-1} aria-label={`${label}增加`} onClick={() => by(1)}>
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1.5 5h7M5 1.5v7" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>
          </button>
        </span>
        {unit}
      </span>
    </div>
  )
}

/** The round badge of something waiting on the user: red ! when they must answer, green merge mark when work only needs their nod. */
export function WaitBadge({ merge, inline }: { merge?: boolean; inline?: boolean }) {
  const label = merge ? '可以合併' : '需要回覆'
  return (
    <span className={`fx-badge${merge ? ' fx-badge-merge' : ''}${inline ? ' fx-badge-inline' : ''}`} title={label}>
      {merge
        ? <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3 1.5V3.5C3 5.8 6 6 6 8.2V10.5M9 1.5V3.5C9 5.8 6 6 6 8.2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
        : <span aria-hidden="true">!</span>}
      <span className="fx-sr">{label}</span>
    </span>
  )
}
