// The flow being edited on the flow-edit sheet, shared with the step sheets taped over it. Changes stay here
// until the flow sheet's 儲存, and the draft is dropped when that sheet goes. A flow may start and end with any
// steps: the ones nothing hands on to start it, the ones that hand on to nothing end it.

import { tr } from './core/i18n'
import { create } from 'zustand'
import { canReach, canSendBack, inEdges, outEdges } from './core/domain/graph'
import { blankSteps } from './core/domain/sim'
import type { Workflow, WorkflowNode } from './core/domain/types'

export interface FlowDraft {
  flow: Workflow
}

export const useFlowDraft = create<{ draft: FlowDraft | null }>(() => ({ draft: null }))

export const editFlowDraft = (f: (d: FlowDraft) => Partial<FlowDraft>) =>
  useFlowDraft.setState(({ draft }) => ({ draft: draft && { ...draft, ...f(draft) } }))

// ids for nodes and edges made while editing; unique within any flow, saved as they are
let seq = 0
const tmp = (prefix: string) => `${prefix}-${Date.now().toString(36)}${++seq}`

export const blankFlow = (): Workflow => ({ id: '', name: '', ...blankSteps(tmp, tr('新步驟{i}', { i: 1 })) })

/** 新步驟 with the first number no step of the flow has yet: 新步驟1, 新步驟2… */
function newName(wf: Workflow) {
  const taken = new Set(wf.nodes.map((n) => n.name.trim()))
  let i = 1
  while (taken.has(tr('新步驟{i}', { i }))) i++
  return tr('新步驟{i}', { i })
}

const blankStep = (wf: Workflow): WorkflowNode => ({
  id: tmp('n'), kind: 'work', name: newName(wf), prompt: '', replicaIds: [], handoff: 'all', join: 'all',
  pos: { x: Math.max(0, ...wf.nodes.map((n) => n.pos.x)) + 1, y: 0 },
})
const arrow = (from: string, to: string) => ({ id: tmp('e'), from, to, condition: '' })

/**
 * A new step's send-back switch, once its arrows are in: on for a last step that may send back, off for any other
 * step something hands on to, and none for a step that starts the flow.
 */
function settle(wf: Workflow, id: string): Workflow {
  if (!inEdges(wf, id).length) return wf
  const on = !outEdges(wf, id).length && canSendBack(wf, id)
  return { ...wf, nodes: wf.nodes.map((n) => (n.id === id ? { ...n, sendBack: on } : n)) }
}

/** A new step after the flow's last step, when it has just one; otherwise on its own. Returns the new flow and the step's id. */
export function addStep(wf: Workflow): [Workflow, string] {
  const node = blankStep(wf)
  const ends = wf.nodes.filter((n) => !outEdges(wf, n.id).length)
  const edges = ends.length === 1 ? [...wf.edges, arrow(ends[0].id, node.id)] : wf.edges
  return [settle({ ...wf, nodes: [...wf.nodes, node], edges }, node.id), node.id]
}

/** A new step that `from` also hands on to. */
export function branchStep(wf: Workflow, from: string): [Workflow, string] {
  const node = blankStep(wf)
  return [settle({ ...wf, nodes: [...wf.nodes, node], edges: [...wf.edges, arrow(from, node.id)] }, node.id), node.id]
}

/** A new step put into an arrow: what went straight along it now passes through the step. */
export function insertStep(wf: Workflow, edgeId: string): [Workflow, string] {
  const cut = wf.edges.find((e) => e.id === edgeId)
  if (!cut) return [wf, '']
  const node = blankStep(wf)
  const edges = wf.edges.flatMap((e) => (e.id === edgeId ? [arrow(e.from, node.id), arrow(node.id, e.to)] : [e]))
  return [settle({ ...wf, nodes: [...wf.nodes, node], edges }, node.id), node.id]
}

/** Remove a step, joining each step before it to each step after it. A flow keeps at least one step. */
export function removeStep(wf: Workflow, id: string): Workflow {
  if (wf.nodes.length <= 1) return wf
  const before = inEdges(wf, id).map((e) => e.from)
  const after = outEdges(wf, id).map((e) => e.to)
  const edges = wf.edges.filter((e) => e.from !== id && e.to !== id)
  for (const a of before) for (const b of after) {
    if (!edges.some((e) => e.from === a && e.to === b)) edges.push({ id: tmp('e'), from: a, to: b, condition: '' })
  }
  return { ...wf, nodes: wf.nodes.filter((n) => n.id !== id), edges }
}

/** Whether `from` may hand on to `to`: never to itself, never twice, and never round in a loop. */
export function canLink(wf: Workflow, from: string, to: string) {
  return from !== to && wf.nodes.some((n) => n.id === to)
    && !wf.edges.some((e) => e.from === from && e.to === to) && !canReach(wf, to, from)
}

/** Draw an arrow from one step to another, if it may be drawn. */
export const link = (wf: Workflow, from: string, to: string): Workflow =>
  canLink(wf, from, to) ? { ...wf, edges: [...wf.edges, arrow(from, to)] } : wf

/** Take an arrow away. */
export const unlink = (wf: Workflow, edgeId: string): Workflow => ({ ...wf, edges: wf.edges.filter((e) => e.id !== edgeId) })

/** Steps this one may hand on to, counting the ones it already does. */
export const nextChoices = (wf: Workflow, id: string) =>
  wf.nodes.filter((n) => outEdges(wf, id).some((e) => e.to === n.id) || canLink(wf, id, n.id))

/** Replace a step: its fields, and (when given) the steps it hands on to. */
export function putStep(wf: Workflow, node: WorkflowNode, next?: string[]): Workflow {
  const nodes = wf.nodes.map((n) => (n.id === node.id ? node : n))
  if (!next) return { ...wf, nodes }
  const kept = wf.edges.filter((e) => e.from !== node.id || next.includes(e.to))
  const added = next.filter((to) => !kept.some((e) => e.from === node.id && e.to === to))
    .map((to) => ({ id: tmp('e'), from: node.id, to, condition: '' }))
  return { ...wf, nodes, edges: [...kept, ...added] }
}
