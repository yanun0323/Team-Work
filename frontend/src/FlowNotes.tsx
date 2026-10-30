// A flow drawn left to right, each step a sticky note with its name. A flow only says how the work is done;
// who does it belongs to each task, so faces hang under the notes only when a task's staff is given, and a
// step nobody has yet says so. The arrows stretch so the flow fills its block from side to side; when the
// block is too narrow for the shortest arrows, it scrolls. An arrow is solid when work always goes along it,
// and dashed when it may not: its step hands on to only one of several next steps, or the step it reaches
// starts once any one of several steps before it is done.
//
// While a flow is being written (`edit`), its arrows are drawn by hand: press a note and drag onto another
// note to hand work on to it, or let go on empty space to branch a new step off it. Notes the dragged arrow
// may not reach fade while it is drawn. The dragged arrow and the would-be note are drawn on a layer over
// the whole block, not in the drawing, so they reach its empty edges. The dot in the middle of an arrow
// opens, under the pointer or focus, into ＋ (put a new step into the arrow) and × (take the arrow away);
// a note's top right corner shows a bin to remove it, all but the two ends. The step list under the drawing
// offers the same by keyboard.

import { useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import type { Workflow, WorkflowEdge } from './core/domain/types'
import { FlowView } from './core/FlowView'
import { endOf } from './flowDraft'
import { layers } from './core/model'
import { useStore } from './core/store'
import { PixelFace } from './core/voxel/PixelFace'

const NOTE = 84
const PAD = 8
const MIN_ARROW = 30

export interface FlowEdits {
  /** The step the flow ends with: nothing leaves it. */
  end: string
  canLink: (from: string, to: string) => boolean
  link: (from: string, to: string) => void
  unlink: (edgeId: string) => void
  /** A new step that `from` hands on to, made by letting an arrow go on empty space. */
  branch: (from: string) => void
  /** A new step put into an arrow. */
  insert: (edgeId: string) => void
  /** Remove a step (never the start or the end). */
  remove: (nodeId: string) => void
}

/**
 * An arrow being drawn: where it leaves from and where the pointer is, in the block's coordinates (`w`×`h`,
 * all of its scrolled content); the note under the pointer, or `empty` when it is over the block but on no
 * note (letting go there branches), with the would-be note at `ghost`.
 */
type Drag = {
  from: string; x0: number; y0: number; x: number; y: number; w: number; h: number
  over: string | null; empty: boolean; ghost: { x: number; y: number }
}

/** How far the pointer moves on a pressed note before it draws an arrow rather than clicks. */
const SLOP = 5

const stepAt = (e: PointerEvent) =>
  (document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-step]') as HTMLElement | null)?.dataset.step ?? null

/**
 * For a flow that opens as a whole (`.fx-flow-card`): its drawing sits above the card's click layer so a wide
 * flow can be scrolled sideways, and a click on the drawing opens the flow as the title does. Not a click on
 * a button of its own, nor on the scroll bar.
 */
export function openCard(e: ReactMouseEvent<HTMLElement>) {
  const hit = e.target as HTMLElement
  if (hit.closest('button, a')) return
  if (hit.classList.contains('fx-flow-scroll') && e.nativeEvent.offsetY > hit.clientHeight) return
  e.currentTarget.querySelector<HTMLButtonElement>('.fx-flow-open')?.click()
}

export function FlowNotes({ wf, staff, done, open, onOpen, canOpen, edit }: {
  wf: Workflow
  /** Who works each step, by node id. */
  staff?: (nodeId: string) => string[]
  /** Steps a task has already finished, greyed out. */
  done?: (nodeId: string) => boolean
  /** The step whose sheet lies on top, kept shaded. */
  open?: string | null
  /** Makes each note a button that opens its step. */
  onOpen?: (nodeId: string) => void
  /** Which notes `onOpen` applies to; the rest stay plain notes. All, when left out. */
  canOpen?: (nodeId: string) => boolean
  /** Lets the arrows be drawn and taken away by hand. */
  edit?: FlowEdits
}) {
  const [drag, setDrag] = useState<Drag | null>(null)
  // the note whose bin was pressed once: it now asks 確定刪除, and a second press removes the step
  const [asking, setAsking] = useState<string | null>(null)
  // a drag ends in a click on the note it started from; this swallows that click
  const dragged = useRef(false)
  const replicas = useStore((s) => s.world.replicas)
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])
  const { count } = layers(wf)
  const room = count > 1 ? (width - count * NOTE - PAD * 2) / (count - 1) : 0
  const arrow = Math.max(MIN_ARROW, Math.floor(room))
  const nameOf = (id: string) => wf.nodes.find((n) => n.id === id)?.name ?? ''
  // the review every flow ends with: a draft says which it is, since cutting arrows can leave others last
  const end = edit?.end ?? endOf(wf)?.id

  // press on a note; once the pointer has moved a little, an arrow follows it from the note's right edge
  // until it is let go: on a note it may reach, on empty space in the drawing, or anywhere else (nothing)
  const draw = (from: string) => (e: ReactPointerEvent) => {
    if (!edit || e.button !== 0 || from === edit.end) return
    const note = e.currentTarget.getBoundingClientRect()
    if (!box.current) return
    const area = box.current
    const at = (x: number, y: number) => {
      const o = area.getBoundingClientRect()
      return { x: x - o.left + area.scrollLeft, y: y - o.top + area.scrollTop }
    }
    const inside = (ev: PointerEvent) => {
      const r = area.getBoundingClientRect()
      return ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom
    }
    const p0 = at(note.right, note.top + note.height / 2)
    const sx = e.clientX
    const sy = e.clientY
    let drawing = false
    const move = (ev: PointerEvent) => {
      if (!drawing && Math.hypot(ev.clientX - sx, ev.clientY - sy) < SLOP) return
      drawing = true
      ev.preventDefault()
      const over = stepAt(ev)
      const p = at(ev.clientX, ev.clientY)
      // the would-be note, beside the pointer but kept within the block
      const w = area.scrollWidth
      const h = area.scrollHeight
      const ghost = { x: Math.max(0, Math.min(p.x, w - NOTE)), y: Math.max(0, Math.min(p.y - 22, h - 44)) }
      setDrag({ from, x0: p0.x, y0: p0.y, ...p, w, h, over, empty: !over && inside(ev), ghost })
    }
    const stop = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      setDrag(null)
      if (!drawing || ev.type !== 'pointerup') return
      dragged.current = true
      setTimeout(() => { dragged.current = false })
      const to = stepAt(ev)
      if (to) { if (edit.canLink(from, to)) edit.link(from, to) } else if (inside(ev)) edit.branch(from)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    window.addEventListener('pointercancel', stop)
  }
  return (
    <div ref={box} className={`fx-flow-scroll${edit ? ' fx-flow-edit' : ''}${drag ? ' fx-drawing' : ''}`}>
      {/* the gap between rows leaves room for the faces, which hang below the note's box */}
      <FlowView
        wf={wf} dir="right" node={{ w: NOTE, h: 44 }} gap={{ layer: arrow, rank: 32 }} pad={PAD}
        edgeClass={(e) => (maybe(wf, e) ? 'fx-edge-maybe' : '')}
        renderEdgeLabel={edit && ((e) => (
          <span className="fx-mid">
            <button type="button" className="fx-mid-btn" onClick={() => edit.insert(e.id)}
              aria-label={`在 ${nameOf(e.from)} 和 ${nameOf(e.to)} 之間插入步驟`} title="插入步驟">
              <svg viewBox="0 0 10 10" width="13" height="13" aria-hidden="true"><path d="M5 1.5v7M1.5 5h7" stroke="currentColor" strokeWidth="1.4" /></svg>
            </button>
            <button type="button" className="fx-mid-btn fx-mid-cut" onClick={() => edit.unlink(e.id)}
              aria-label={`拿掉 ${nameOf(e.from)} 到 ${nameOf(e.to)} 的箭頭`} title="拿掉這條箭頭">
              <svg viewBox="0 0 10 10" width="13" height="13" aria-hidden="true"><path d="M2.5 2.5l5 5M7.5 2.5l-5 5" stroke="currentColor" strokeWidth="1.4" /></svg>
            </button>
          </span>
        ))}
        renderNode={(n) => {
          const crew = staff?.(n.id).map((id) => replicas[id]).filter(Boolean)
          const body = (
            <>
              <b>{n.name}</b>
              {crew && crew.length > 0 && (
                <span className="fx-node-crew">
                  {crew.map((r) => <span key={r.id} title={r.name}><PixelFace look={r.look} name={r.name} size={18} /></span>)}
                </span>
              )}
              {/* nobody works it yet: a round ! pinned to the note's corner */}
              {crew?.length === 0 && <span className="fx-node-warn" role="img" aria-label="沒有分配人員" title="沒有分配人員">!</span>}
            </>
          )
          // while an arrow is drawn: the notes it may reach, the one under the pointer, the rest faded
          const reach = drag && n.id !== drag.from ? (edit?.canLink(drag.from, n.id) ? (drag.over === n.id ? ' fx-node-over' : ' fx-node-can') : ' fx-node-cant') : ''
          const fixed = n.kind === 'task' || n.id === end
          const cls = `fx-node fx-node-${n.kind}${fixed ? ' fx-node-fixed' : ''}${crew?.length === 0 ? ' fx-node-empty' : ''}${done?.(n.id) ? ' fx-node-done' : ''}${reach}`
          const press = edit ? { onPointerDown: draw(n.id) } : {}
          const note = onOpen && (canOpen?.(n.id) ?? true)
            ? (
              <button type="button" data-step={n.id} className={`${cls} fx-hit`} aria-expanded={open === undefined ? undefined : open === n.id}
                {...press} onClick={() => { if (!dragged.current) onOpen(n.id) }}>{body}</button>
            )
            : <div data-step={n.id} className={cls} {...press}>{body}</div>
          // beside the note, not in it: a button may not hold another
          // looking away (focus or pointer leaving it) takes the question back
          const ask = asking === n.id
          const bin = edit && n.kind !== 'task' && n.id !== edit.end && (
            <button type="button" className={ask ? 'fx-node-del fx-node-del-ask' : 'fx-node-del'}
              onClick={() => { if (ask) { setAsking(null); edit.remove(n.id) } else setAsking(n.id) }}
              onBlur={() => setAsking(null)} onPointerLeave={() => setAsking(null)}
              aria-label={ask ? `確定刪除 ${n.name || '這一步'}` : `刪除 ${n.name || '這一步'}`} title={ask ? undefined : '刪除這一步'}>
              {ask ? '確定刪除' : (
                <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                  <path d="M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.8 9h6.4l.8-9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
                </svg>
              )}
            </button>
          )
          return <>{note}{bin}</>
        }}
      />
      {drag && (
        <svg className="fx-drag-layer" width={drag.w} height={drag.h} aria-hidden="true">
          <path className="fx-drag-edge" d={`M${drag.x0},${drag.y0} C${(drag.x0 + drag.x) / 2},${drag.y0} ${(drag.x0 + drag.x) / 2},${drag.y} ${drag.x},${drag.y}`} />
          {/* on empty space: the new step letting go would make */}
          {drag.empty && <rect className="fx-drag-ghost" x={drag.ghost.x} y={drag.ghost.y} width={NOTE} height={44} />}
        </svg>
      )}
    </div>
  )
}

/** Whether work may not go along an arrow: one of several next steps is picked, or any one of several before will do. */
function maybe(wf: Workflow, e: WorkflowEdge) {
  const from = wf.nodes.find((n) => n.id === e.from)
  const to = wf.nodes.find((n) => n.id === e.to)
  const outs = wf.edges.filter((x) => x.from === e.from).length
  const ins = wf.edges.filter((x) => x.to === e.to).length
  return (outs > 1 && from?.handoff === 'pickOne') || (ins > 1 && to?.join === 'any')
}
