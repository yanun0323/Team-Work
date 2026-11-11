import type { Workflow, WorkflowNode } from './types'

export const outEdges = (wf: Workflow, id: string) => wf.edges.filter((e) => e.from === id)
export const inEdges = (wf: Workflow, id: string) => wf.edges.filter((e) => e.to === id)
export const nodeOf = (wf: Workflow, id: string) => wf.nodes.find((n) => n.id === id)
/** The steps a flow starts with: those nothing hands on to. A task starts them all at once. */
export const startsOf = (wf: Workflow) => wf.nodes.filter((n) => inEdges(wf, n.id).length === 0)
/** The steps a flow ends with: those that hand on to nothing. */
export const endsOf = (wf: Workflow) => wf.nodes.filter((n) => outEdges(wf, n.id).length === 0)

/** True when `to` can be reached from `from` (a node reaches itself). */
export function canReach(wf: Workflow, from: string, to: string): boolean {
  const seen = new Set<string>()
  const stack = [from]
  while (stack.length) {
    const id = stack.pop() as string
    if (id === to) return true
    if (seen.has(id)) continue
    seen.add(id)
    for (const e of outEdges(wf, id)) stack.push(e.to)
  }
  return false
}

export const wouldCreateCycle = (wf: Workflow, from: string, to: string) => canReach(wf, to, from)

/** True when every path out of `id` passes through `target`, so the node only exists to feed it. */
export function feedsOnly(wf: Workflow, id: string, target: string): boolean {
  if (id === target) return false
  const seen = new Set<string>()
  const stack = [id]
  while (stack.length) {
    const cur = stack.pop() as string
    if (seen.has(cur)) continue
    seen.add(cur)
    const outs = outEdges(wf, cur)
    if (outs.length === 0) return false
    for (const e of outs) if (e.to !== target) stack.push(e.to)
  }
  return true
}

/**
 * Whether a step may send work back: a work step with one step before it, whose work goes only to this
 * one, so redoing it holds up nothing else.
 */
export function canSendBack(wf: Workflow, id: string): boolean {
  const ins = inEdges(wf, id)
  return nodeOf(wf, id)?.kind === 'work' && ins.length === 1 && feedsOnly(wf, ins[0].from, id)
}

/** Longest distance from any source node. Used to place nodes in columns. */
export function depths(wf: Workflow): Record<string, number> {
  const depth: Record<string, number> = {}
  const indeg: Record<string, number> = {}
  for (const n of wf.nodes) indeg[n.id] = 0
  for (const e of wf.edges) indeg[e.to] = (indeg[e.to] ?? 0) + 1
  const queue = wf.nodes.filter((n) => indeg[n.id] === 0).map((n) => n.id)
  for (const id of queue) depth[id] = 0
  while (queue.length) {
    const id = queue.shift() as string
    for (const e of outEdges(wf, id)) {
      depth[e.to] = Math.max(depth[e.to] ?? 0, depth[id] + 1)
      indeg[e.to] -= 1
      if (indeg[e.to] === 0) queue.push(e.to)
    }
  }
  return depth
}

export const LAYOUT_DX = 240
export const LAYOUT_DY = 200

/** Place nodes in rows by depth (the tree grows downward), keeping the left-to-right order in each row. */
export function autoLayout(wf: Workflow) {
  const d = depths(wf)
  const rows = new Map<number, WorkflowNode[]>()
  for (const n of wf.nodes) rows.set(d[n.id] ?? 0, [...(rows.get(d[n.id] ?? 0) ?? []), n])
  for (const [row, nodes] of rows) {
    nodes.sort((a, b) => a.pos.x - b.pos.x)
    nodes.forEach((n, i) => (n.pos = { x: (i - (nodes.length - 1) / 2) * LAYOUT_DX, y: row * LAYOUT_DY }))
  }
}

export type Issue =
  | { kind: 'noReplica'; nodeId: string }
  | { kind: 'noCondition'; edgeId: string }

export function validate(wf: Workflow): Issue[] {
  const issues: Issue[] = []
  for (const n of wf.nodes) {
    if (n.replicaIds.length === 0) issues.push({ kind: 'noReplica', nodeId: n.id })
    const outs = outEdges(wf, n.id)
    if (n.handoff === 'pickOne' && outs.length > 1) {
      for (const e of outs) if (!e.condition.trim()) issues.push({ kind: 'noCondition', edgeId: e.id })
    }
  }
  return issues
}

export interface PromptSection {
  key: 'system' | 'node' | 'handoff' | 'replica'
  body: string
}

/**
 * The system prompt for a Replica working on a node, highest priority first:
 * fixed system rules, this node's prompt, how to hand off downstream, the Replica's own prompt and memory.
 */
export function composePrompt(wf: Workflow, nodeId: string, replicaPrompt: string, memory: string[]): PromptSection[] {
  const node = nodeOf(wf, nodeId)
  if (!node) return []
  const outs = outEdges(wf, nodeId)
  const handoff = outs.length === 0
    ? '這一步之後沒有其他步驟。任務的每條支線都完成後，由使用者決定是否合併。'
    : [
        node.handoff === 'pickOne' && outs.length > 1
          ? '交接模式：多選一。依下方條件只選一個下游，並寫明理由。'
          : '交接模式：全交接。每個下游都會收到你的交接。',
        ...outs.map((e) => {
          const next = nodeOf(wf, e.to)
          const cond = node.handoff === 'pickOne' && outs.length > 1 ? `\n  條件：${e.condition || '（未填）'}` : ''
          return `- ${next?.name ?? e.to}：${next?.prompt ?? ''}${cond}`
        }),
      ].join('\n')
  return [
    { key: 'system', body: '交接時同時寫 Agent 交接與人類摘要。需要使用者決策時停下來提出審核，不要自行猜測。' },
    { key: 'node', body: node.prompt || '（未填）' },
    { key: 'handoff', body: handoff },
    { key: 'replica', body: [replicaPrompt, ...memory.map((m) => `- ${m}`)].join('\n') },
  ]
}
