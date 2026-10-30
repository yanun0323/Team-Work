import type { ReactNode } from 'react'
import type { Workflow, WorkflowEdge, WorkflowNode } from './domain/types'
import { layers } from './model'

export interface Rect { x: number; y: number; w: number; h: number }

interface Props {
  wf: Workflow
  /** 'down' grows like the hand-drawn sketch; 'right' reads like a CI pipeline. */
  dir: 'down' | 'right'
  node: { w: number; h: number }
  gap: { layer: number; rank: number }
  pad?: number
  renderNode: (n: WorkflowNode, r: Rect) => ReactNode
  edgeClass?: (e: WorkflowEdge) => string
  renderEdgeLabel?: (e: WorkflowEdge, at: { x: number; y: number }) => ReactNode
  /** Extra SVG drawn above the edges, e.g. boxes moving along them. */
  overlay?: (pathOf: (from: string, to: string) => ((t: number) => { x: number; y: number }) | null) => ReactNode
  className?: string
  /** Where along each connection its label sits, 0..1. */
  labelAt?: number
}

/** Lays a workflow out in layers and draws its connections. Nodes are HTML, edges are SVG. */
export function FlowView({ wf, dir, node, gap, pad = 24, renderNode, edgeClass, renderEdgeLabel, overlay, className = '', labelAt = 0.5 }: Props) {
  const { at, count, widest } = layers(wf)
  const down = dir === 'down'
  const along = down ? node.h + gap.layer : node.w + gap.layer
  const across = down ? node.w + gap.rank : node.h + gap.rank
  // a connection that skips a layer would run straight through the nodes between, so it bows out to the side
  // (above when the flow runs right, left when it runs down); make room for the bow on that side
  const skips = (from: string, to: string) => !!at[from] && !!at[to] && at[to].layer - at[from].layer > 1
  const size = down ? node.w : node.h
  const bow = Math.round(size * 0.67 + 14)
  const extra = wf.edges.some((e) => skips(e.from, e.to)) ? Math.max(0, Math.ceil(0.75 * bow - size / 2 + 6 - pad)) : 0
  const width = down ? widest * across - gap.rank + pad * 2 + extra : count * along - gap.layer + pad * 2
  const height = down ? count * along - gap.layer + pad * 2 : widest * across - gap.rank + pad * 2 + extra
  const rect = (id: string): Rect | null => {
    const p = at[id]
    if (!p) return null
    const offset = ((widest - p.size) / 2 + p.rank) * across + pad + extra
    const main = p.layer * along + pad
    return down ? { x: offset, y: main, w: node.w, h: node.h } : { x: main, y: offset, w: node.w, h: node.h }
  }
  const curve = (a: Rect, b: Rect, skip = false) => {
    if (skip && down) {
      const x1 = a.x + a.w / 2, y1 = a.y + a.h, x2 = b.x + b.w / 2, y2 = b.y, cx = Math.min(x1, x2) - bow
      const p = [x1, y1, cx, y1 + along * 0.6, cx, y2 - along * 0.6, x2, y2]
      return { d: `M${x1},${y1} C${p[2]},${p[3]} ${p[4]},${p[5]} ${x2},${y2}`, p }
    }
    if (skip) {
      const x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = b.x, y2 = b.y + b.h / 2, cy = Math.min(y1, y2) - bow
      const p = [x1, y1, x1 + along * 0.6, cy, x2 - along * 0.6, cy, x2, y2]
      return { d: `M${x1},${y1} C${p[2]},${p[3]} ${p[4]},${p[5]} ${x2},${y2}`, p }
    }
    if (down) {
      const x1 = a.x + a.w / 2, y1 = a.y + a.h, x2 = b.x + b.w / 2, y2 = b.y, m = (y1 + y2) / 2
      return { d: `M${x1},${y1} C${x1},${m} ${x2},${m} ${x2},${y2}`, p: [x1, y1, x1, m, x2, m, x2, y2] }
    }
    const x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = b.x, y2 = b.y + b.h / 2, m = (x1 + x2) / 2
    return { d: `M${x1},${y1} C${m},${y1} ${m},${y2} ${x2},${y2}`, p: [x1, y1, m, y1, m, y2, x2, y2] }
  }
  const bez = (p: number[], t: number) => {
    const u = 1 - t
    const k = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t]
    return { x: k[0] * p[0] + k[1] * p[2] + k[2] * p[4] + k[3] * p[6], y: k[0] * p[1] + k[1] * p[3] + k[2] * p[5] + k[3] * p[7] }
  }
  const pathOf = (from: string, to: string) => {
    const a = rect(from)
    const b = rect(to)
    if (!a || !b) return null
    const c = curve(a, b, skips(from, to))
    return (t: number) => bez(c.p, t)
  }
  return (
    <div className={`flow ${className}`} style={{ width, height }}>
      <svg className="flow-edges" width={width} height={height} aria-hidden="true">
        <defs>
          <marker id={`arrow-${wf.id}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,1 L9,5 L0,9 z" className="flow-arrow" />
          </marker>
        </defs>
        {wf.edges.map((e) => {
          const a = rect(e.from)
          const b = rect(e.to)
          if (!a || !b) return null
          return <path key={e.id} d={curve(a, b, skips(e.from, e.to)).d} className={`flow-edge ${edgeClass?.(e) ?? ''}`} markerEnd={`url(#arrow-${wf.id})`} />
        })}
        {overlay?.(pathOf)}
      </svg>
      {renderEdgeLabel && wf.edges.map((e) => {
        const a = rect(e.from)
        const b = rect(e.to)
        if (!a || !b) return null
        const p = bez(curve(a, b, skips(e.from, e.to)).p, labelAt)
        return <div key={e.id} className="flow-label" style={{ left: p.x, top: p.y }}>{renderEdgeLabel(e, p)}</div>
      })}
      {wf.nodes.map((n) => {
        const r = rect(n.id)
        return r && <div key={n.id} className="flow-node" style={{ left: r.x, top: r.y, width: r.w, height: r.h }}>{renderNode(n, r)}</div>
      })}
    </div>
  )
}
