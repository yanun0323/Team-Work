// A handed file compared with how it was when its step began, one above the other or side by side, and the switch
// between that and reading it.

import { Fragment, useEffect, useMemo, useState, type RefObject } from 'react'
import { tr } from './core/i18n'
import { folded, numbered, paired, type DiffLine, type Numbered } from './diffView'

export type DocView = 'read' | 'stacked' | 'split'

const KEPT = 'fx-doc-view'
/** Two columns need about this much of the note's width to stay readable. */
const SPLIT_WIDTH = 600

function keptView(): DocView {
  try {
    const v = localStorage.getItem(KEPT)
    return v === 'stacked' || v === 'split' ? v : 'read'
  } catch { return 'read' } // private mode
}

/** The way handed files are looked at, the same for every one and kept for next time. */
export function useDocView() {
  const [view, setView] = useState<DocView>(keptView)
  const choose = (v: DocView) => {
    setView(v)
    try { localStorage.setItem(KEPT, v) } catch { /* private mode */ }
  }
  return [view, choose] as const
}

/** Whether el is wide enough for two columns, as the sheet is resized. */
export function useRoomForSplit(el: RefObject<HTMLElement | null>) {
  const [room, setRoom] = useState(true)
  useEffect(() => {
    const node = el.current
    if (!node || typeof ResizeObserver === 'undefined') return
    const watch = new ResizeObserver(([e]) => setRoom(e.contentRect.width >= SPLIT_WIDTH))
    watch.observe(node)
    return () => watch.disconnect()
  }, [el])
  return room
}

const LABELS: Record<DocView, () => string> = { read: () => tr('閱讀'), stacked: () => tr('上下'), split: () => tr('左右') }

/** The sheet's own buttons: read, one above the other, side by side (only with room for it). */
export function ViewSwitch({ view, onView, split }: { view: DocView; onView: (v: DocView) => void; split: boolean }) {
  const views: DocView[] = split ? ['read', 'stacked', 'split'] : ['read', 'stacked']
  return (
    <div className="fx-tools fx-doc-views" role="group" aria-label={tr('檢視方式')}>
      {views.map((v) => (
        <button key={v} type="button" className="fx-tool fx-tool-text fx-hit" aria-pressed={view === v} onClick={() => onView(v)}>
          {LABELS[v]()}
        </button>
      ))}
    </div>
  )
}

const SIGN = { same: ' ', add: '+', del: '−' } as const

/** The compared lines, long unchanged runs folded until clicked open. */
export function DiffNote({ lines, split }: { lines: DiffLine[]; split: boolean }) {
  const pieces = useMemo(() => folded(numbered(lines)), [lines])
  const [opened, setOpened] = useState<ReadonlySet<number>>(new Set())
  return (
    <div className={split ? 'fx-diff fx-diff-split' : 'fx-diff'}>
      {pieces.map((p, i) => p.fold && !opened.has(i)
        ? <button key={i} type="button" className="fx-diff-fold" onClick={() => setOpened(new Set(opened).add(i))}>
            ⋯ {tr('{count} 行未變更', { count: p.lines.length })}
          </button>
        : split
          ? paired(p.lines).map((r, k) => (
            <div key={`${i}:${k}`} className="fx-diff-row">
              <Side line={r.left} number={r.left?.old} />
              <Side line={r.right} number={r.right?.new} />
            </div>
          ))
          : p.lines.map((l, k) => (
            <div key={`${i}:${k}`} className={`fx-diff-row fx-diff-${l.op}`}>
              <span className="fx-diff-no">{l.old}</span>
              <span className="fx-diff-no">{l.new}</span>
              <span className="fx-diff-sign">{SIGN[l.op]}</span>
              <span className="fx-diff-text">{l.text}</span>
            </div>
          )))}
    </div>
  )
}

/** One side of a side-by-side row; nothing there when the other side's line has no counterpart. */
function Side({ line, number }: { line?: Numbered; number?: number }) {
  const look = line ? `fx-diff-${line.op}` : 'fx-diff-none'
  return (
    <Fragment>
      <span className={`fx-diff-no ${look}`}>{number}</span>
      <span className={`fx-diff-sign ${look}`}>{line ? SIGN[line.op] : ''}</span>
      <span className={`fx-diff-text ${look}`}>{line?.text}</span>
    </Fragment>
  )
}
