// The task being written on the new-task sheet. It is shared with the sheet taped over it to pick a step's
// employees, and dropped when the new-task sheet goes.

import { create } from 'zustand'
import { tr } from './core/i18n'
import type { Attachment, Task, Workflow, World } from './core/domain/types'
import { crewOf, flowList, teamTasks, unhidden } from './core/model'
import { usePrefs } from './prefs'
import { blankFlow } from './flowDraft'

export interface TaskDraft {
  title: string
  description: string
  /** The blueprint the task runs on; with `custom`, the one its flow was imported from, or '' for none. */
  workflowId: string
  /** A flow written for this task alone, which it runs on instead of the blueprint. */
  custom?: Workflow
  /** Who works each step, by node id. */
  staff: Record<string, string[]>
  /** The task's owner, who answers for it. */
  ownerId: string | null
  /** The task whose staff this started from, if any. */
  from: number | null
  /** Pictures to go with the description; only a new task takes them. */
  images?: Attachment[]
  files?: Attachment[]
  /**
   * Set when editing a task that exists: its own copy of the flow is the one staffed, and while the flow can still
   * change, `custom` is that copy being written.
   */
  taskId?: string
}

export const useDraft = create<{ draft: TaskDraft | null }>(() => ({ draft: null }))

export const editDraft = (f: (d: TaskDraft) => Partial<TaskDraft>) =>
  useDraft.setState(({ draft }) => ({ draft: draft && { ...draft, ...f(draft) } }))

/** The flow a new task starts on: the one the company last chose, if it is still there and shown, or else the first. */
export function lastFlowId(w: World, teamId: string): string {
  const hidden = usePrefs.getState().hiddenWorkflows
  const chosen = teamTasks(w, teamId).find((t) => w.workflows[t.workflowId] && !hidden.includes(t.workflowId))?.workflowId
  return chosen ?? unhidden(flowList(w), hidden)[0]?.id ?? ''
}

/** A work step has one employee: staff from before that keeps the first. A discussion keeps them all. */
const oneOnWork = (n: { kind: string }, ids: string[]) => (n.kind === 'talk' ? ids : ids.slice(0, 1))

/**
 * Who to start with for a flow: the staff of the company's last task on it, so a new task only changes who
 * is different this time. Employees who have left are dropped. With no earlier task, the flow's own list.
 */
export function lastStaff(w: World, teamId: string, workflowId: string): Pick<TaskDraft, 'staff' | 'from' | 'ownerId'> {
  const wf = w.workflows[workflowId]
  if (!wf) return { staff: {}, from: null, ownerId: null }
  const here = new Set(crewOf(w, teamId).map((r) => r.id))
  const last = teamTasks(w, teamId).find((t) => t.workflowId === workflowId && t.stage !== 'cancelled')
  const staff: Record<string, string[]> = {}
  for (const n of wf.nodes) {
    const was = last?.workflow.nodes.find((x) => x.id === n.id)?.replicaIds ?? n.replicaIds
    staff[n.id] = oneOnWork(n, was.filter((r) => here.has(r)))
  }
  const ownerId = last?.ownerId && here.has(last.ownerId) ? last.ownerId : null
  return { staff, from: last?.number ?? null, ownerId }
}

/**
 * A new task filled in from an existing one, to run the same work again. Its staff comes along where the steps are
 * still in the flow, without anyone who has left. If the flow is gone, it starts on the company's last or first flow.
 */
export function copyDraft(w: World, teamId: string, t: Task): TaskDraft {
  const here = new Set(crewOf(w, teamId).map((r) => r.id))
  const content = { title: t.title, description: t.description, images: [...t.images], files: [...(t.files ?? [])], ownerId: t.ownerId && here.has(t.ownerId) ? t.ownerId : null }
  if (!t.workflowId) {
    // a flow of its own: the copy gets the same flow, as its own again
    const custom = { ...structuredClone(t.workflow), id: '' }
    const staff = Object.fromEntries(custom.nodes.map((n) => [n.id, oneOnWork(n, n.replicaIds.filter((r) => here.has(r)))]))
    return { ...content, workflowId: '', custom, staff, from: t.number }
  }
  if (!w.workflows[t.workflowId]) {
    const workflowId = lastFlowId(w, teamId)
    return { ...lastStaff(w, teamId, workflowId), ...content, workflowId }
  }
  const staff: Record<string, string[]> = {}
  for (const n of w.workflows[t.workflowId].nodes) {
    const was = t.workflow.nodes.find((x) => x.id === n.id)?.replicaIds ?? n.replicaIds
    staff[n.id] = oneOnWork(n, was.filter((r) => here.has(r)))
  }
  return { ...content, workflowId: t.workflowId, staff, from: t.number }
}

/** The flow the draft is staffing. */
export const draftFlow = (w: World, d: TaskDraft): Workflow | undefined =>
  d.custom ?? (d.taskId ? w.tasks[d.taskId]?.workflow : w.workflows[d.workflowId])

/**
 * A flow of the task's own to write, copied from a blueprint (its steps keep their ids, so who works them carries
 * over) or blank. Named apart from the blueprint, so the task shows it is not the blueprint's.
 */
export function customFlow(w: World, workflowId: string): Workflow {
  const from = w.workflows[workflowId]
  if (!from) return { ...blankFlow(), name: tr('自訂流程') }
  return { ...structuredClone(from), id: '', name: tr('{name}（自訂）', { name: from.name }) }
}

/** A change to the draft's own flow; a step turned back into work keeps only its first employee. */
export const editCustom = (f: (wf: Workflow) => Workflow) => editDraft((d) => {
  if (!d.custom) return {}
  const custom = f(d.custom)
  const staff = Object.fromEntries(Object.entries(d.staff).map(([id, ids]) => {
    const n = custom.nodes.find((x) => x.id === id)
    return [id, n ? oneOnWork(n, ids) : ids]
  }))
  return { custom, staff }
})

/** Who works a step of the draft. */
export const draftStaff = (_w: World, d: TaskDraft, nodeId: string): string[] => d.staff[nodeId] ?? []

/** The owner alone on every step of the draft's flow. No longer the staff of an earlier task, so `from` goes too. */
export const ownerOnEveryStep = (w: World, d: TaskDraft): Partial<TaskDraft> =>
  d.ownerId ? { staff: Object.fromEntries((draftFlow(w, d)?.nodes ?? []).map((n) => [n.id, [d.ownerId!]])), from: null } : {}

/** The steps nobody works yet. A task can start only when there are none. */
export const unstaffed = (w: World, d: TaskDraft) =>
  (draftFlow(w, d)?.nodes ?? []).filter((n) => !draftStaff(w, d, n.id).length)
