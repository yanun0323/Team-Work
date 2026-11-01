// The flow being edited on the flow-edit sheet, shared with the step sheets taped over it. Changes stay here
// until the flow sheet's 儲存, and the draft is dropped when that sheet goes. The edits below keep the flow's
// two ends: it always starts with 整理需求 (the task node) and ends with 驗收. Which step is the end is fixed
// when the draft is made (`end`), since cutting a step's last arrow would otherwise make it look like one.

import { tr } from './core/i18n'
import { create } from 'zustand'
import { canReach, endNodeOf, inEdges, outEdges, taskNodeOf } from './core/domain/graph'
import { flowEnds } from './core/domain/sim'
import type { Workflow, WorkflowNode, Locale } from './core/domain/types'

export interface FlowDraft {
  flow: Workflow
  /** The step the flow ends with. */
  end: string
}

export const useFlowDraft = create<{ draft: FlowDraft | null }>(() => ({ draft: null }))

export const editFlowDraft = (f: (d: FlowDraft) => Partial<FlowDraft>) =>
  useFlowDraft.setState(({ draft }) => ({ draft: draft && { ...draft, ...f(draft) } }))

// ids for nodes and edges made while editing; unique within any flow, saved as they are
let seq = 0
const tmp = (prefix: string) => `${prefix}-${Date.now().toString(36)}${++seq}`

export const blankFlow = (language: Locale = 'zh'): Workflow => ({ id: '', name: '', ...flowEnds(tmp, language) })

/** The end of a flow as saved: the last step after which nothing follows. Only for making a draft. */
export const endOf = endNodeOf

/** Steps that may be renamed and removed: all but the two ends. */
export const isMiddle = (wf: Workflow, end: string, id: string) => id !== taskNodeOf(wf)?.id && id !== end

/** 新步驟 with the first number no step of the flow has yet: 新步驟1, 新步驟2… */
function newName(wf: Workflow) {
  const taken = new Set(wf.nodes.map((n) => n.name.trim()))
  let i = 1
  while (taken.has(tr('新步驟{i}', { i }))) i++
  return tr('新步驟{i}', { i })
}

const blankStep = (wf: Workflow): WorkflowNode => ({
  id: tmp('n'), kind: 'work', name: newName(wf), prompt: '', replicaIds: [], assignment: 'firstAvailable', handoff: 'all', join: 'all',
  pos: { x: Math.max(0, ...wf.nodes.map((n) => n.pos.x)) + 1, y: 0 },
})
const arrow = (from: string, to: string) => ({ id: tmp('e'), from, to, condition: '' })

/** A new step, placed just before the end. Returns the new flow and the step's id. */
export function addStep(wf: Workflow, end: string): [Workflow, string] {
  const node = blankStep(wf)
  const edges = wf.edges.map((e) => (e.to === end ? { ...e, to: node.id } : e))
  return [{ ...wf, nodes: [...wf.nodes, node], edges: [...edges, arrow(node.id, end)] }, node.id]
}

/** A new step that `from` also hands on to, leading on to the end so the flow stays whole. */
export function branchStep(wf: Workflow, end: string, from: string): [Workflow, string] {
  const node = blankStep(wf)
  return [{ ...wf, nodes: [...wf.nodes, node], edges: [...wf.edges, arrow(from, node.id), arrow(node.id, end)] }, node.id]
}

/** A new step put into an arrow: what went straight along it now passes through the step. */
export function insertStep(wf: Workflow, edgeId: string): [Workflow, string] {
  const cut = wf.edges.find((e) => e.id === edgeId)
  if (!cut) return [wf, '']
  const node = blankStep(wf)
  const edges = wf.edges.flatMap((e) => (e.id === edgeId ? [arrow(e.from, node.id), arrow(node.id, e.to)] : [e]))
  return [{ ...wf, nodes: [...wf.nodes, node], edges }, node.id]
}

/** Remove a step, joining each step before it to each step after it so the flow stays whole. */
export function removeStep(wf: Workflow, id: string): Workflow {
  const before = inEdges(wf, id).map((e) => e.from)
  const after = outEdges(wf, id).map((e) => e.to)
  const edges = wf.edges.filter((e) => e.from !== id && e.to !== id)
  for (const a of before) for (const b of after) {
    if (!edges.some((e) => e.from === a && e.to === b)) edges.push({ id: tmp('e'), from: a, to: b, condition: '' })
  }
  return { ...wf, nodes: wf.nodes.filter((n) => n.id !== id), edges }
}

/**
 * Whether `from` may hand on to `to`: never out of the end, never into the start, never to itself, never
 * twice, and never round in a loop.
 */
export function canLink(wf: Workflow, end: string, from: string, to: string) {
  const target = wf.nodes.find((n) => n.id === to)
  return from !== end && from !== to && !!target && target.kind !== 'task'
    && !wf.edges.some((e) => e.from === from && e.to === to) && !canReach(wf, to, from)
}

/** Draw an arrow from one step to another, if it may be drawn. */
export const link = (wf: Workflow, end: string, from: string, to: string): Workflow =>
  canLink(wf, end, from, to) ? { ...wf, edges: [...wf.edges, arrow(from, to)] } : wf

/** Take an arrow away. */
export const unlink = (wf: Workflow, edgeId: string): Workflow => ({ ...wf, edges: wf.edges.filter((e) => e.id !== edgeId) })

/** Steps this one may hand on to, counting the ones it already does. */
export const nextChoices = (wf: Workflow, end: string, id: string) =>
  wf.nodes.filter((n) => outEdges(wf, id).some((e) => e.to === n.id) || canLink(wf, end, id, n.id))

/** Replace a step: its fields, and (when given) the steps it hands on to. */
export function putStep(wf: Workflow, node: WorkflowNode, next?: string[]): Workflow {
  const nodes = wf.nodes.map((n) => (n.id === node.id ? node : n))
  if (!next) return { ...wf, nodes }
  const kept = wf.edges.filter((e) => e.from !== node.id || next.includes(e.to))
  const added = next.filter((to) => !kept.some((e) => e.from === node.id && e.to === to))
    .map((to) => ({ id: tmp('e'), from: node.id, to, condition: '' }))
  return { ...wf, nodes, edges: [...kept, ...added] }
}

/** Steps cut off: ones the start cannot reach, or ones that never lead to the end. */
export function loose(wf: Workflow, end: string): WorkflowNode[] {
  const start = taskNodeOf(wf)
  return wf.nodes.filter((n) => !start || !canReach(wf, start.id, n.id) || !canReach(wf, n.id, end))
}
