// The task being written on the new-task sheet. It is shared with the sheet taped over it to pick a step's
// employees, and dropped when the new-task sheet goes.

import { create } from 'zustand'
import { isFixed } from './core/domain/graph'
import type { Attachment, Task, World } from './core/domain/types'
import { flowList, teamReplicas, teamTasks } from './core/model'

export interface TaskDraft {
  title: string
  description: string
  workflowId: string
  /** Who works each step, by node id; the two fixed ends go to the owner instead. */
  staff: Record<string, string[]>
  /** The task's owner, who works 整理需求 and 驗收. */
  ownerId: string | null
  /** The task whose staff this started from, if any. */
  from: number | null
  /** Pictures to go with the description; only a new task takes them. */
  images?: Attachment[]
  files?: Attachment[]
  /** Set when editing a task that exists: its own copy of the flow is the one staffed. */
  taskId?: string
}

export const useDraft = create<{ draft: TaskDraft | null }>(() => ({ draft: null }))

export const editDraft = (f: (d: TaskDraft) => Partial<TaskDraft>) =>
  useDraft.setState(({ draft }) => ({ draft: draft && { ...draft, ...f(draft) } }))

/** The flow a new task starts on: the one the company last chose, if it is still there, or else the first. */
export function lastFlowId(w: World, teamId: string): string {
  const chosen = teamTasks(w, teamId).find((t) => w.workflows[t.workflowId])?.workflowId
  return chosen ?? flowList(w)[0]?.id ?? ''
}

/**
 * Who to start with for a flow: the staff of the company's last task on it, so a new task only changes who
 * is different this time. Employees who have left are dropped. With no earlier task, the flow's own list.
 */
export function lastStaff(w: World, teamId: string, workflowId: string): Pick<TaskDraft, 'staff' | 'from' | 'ownerId'> {
  const wf = w.workflows[workflowId]
  if (!wf) return { staff: {}, from: null, ownerId: null }
  const here = new Set(teamReplicas(w, teamId).map((r) => r.id))
  const last = teamTasks(w, teamId).find((t) => t.workflowId === workflowId && t.stage !== 'cancelled')
  const staff: Record<string, string[]> = {}
  for (const n of wf.nodes) {
    const was = last?.workflow.nodes.find((x) => x.id === n.id)?.replicaIds ?? n.replicaIds
    staff[n.id] = was.filter((r) => here.has(r))
  }
  const ownerId = last?.ownerId && here.has(last.ownerId) ? last.ownerId : null
  return { staff, from: last?.number ?? null, ownerId }
}

/**
 * A new task filled in from an existing one, to run the same work again. Its staff comes along where the steps are
 * still in the flow, without anyone who has left. If the flow is gone, it starts on the company's last or first flow.
 */
export function copyDraft(w: World, teamId: string, t: Task): TaskDraft {
  const here = new Set(teamReplicas(w, teamId).map((r) => r.id))
  const content = { title: t.title, description: t.description, images: [...t.images], files: [...(t.files ?? [])], ownerId: t.ownerId && here.has(t.ownerId) ? t.ownerId : null }
  if (!w.workflows[t.workflowId]) {
    const workflowId = lastFlowId(w, teamId)
    return { ...lastStaff(w, teamId, workflowId), ...content, workflowId }
  }
  const staff: Record<string, string[]> = {}
  for (const n of w.workflows[t.workflowId].nodes) {
    const was = t.workflow.nodes.find((x) => x.id === n.id)?.replicaIds ?? n.replicaIds
    staff[n.id] = was.filter((r) => here.has(r))
  }
  return { ...content, workflowId: t.workflowId, staff, from: t.number }
}

/** The flow the draft is staffing. */
export const draftFlow = (w: World, d: TaskDraft) => (d.taskId ? w.tasks[d.taskId]?.workflow : w.workflows[d.workflowId])

/** Who works a step of the draft: the owner on the two fixed ends, else the step's own pick. */
export const draftStaff = (w: World, d: TaskDraft, nodeId: string): string[] => {
  const wf = draftFlow(w, d)
  if (wf && isFixed(wf, nodeId)) return d.ownerId ? [d.ownerId] : []
  return d.staff[nodeId] ?? []
}

/** The owner alone on every step of the draft's flow. No longer the staff of an earlier task, so `from` goes too. */
export const ownerOnEveryStep = (w: World, d: TaskDraft): Partial<TaskDraft> =>
  d.ownerId ? { staff: Object.fromEntries((draftFlow(w, d)?.nodes ?? []).map((n) => [n.id, [d.ownerId!]])), from: null } : {}

/** The steps nobody works yet, ends included while there is no owner. A task can start only when there are none. */
export const unstaffed = (w: World, d: TaskDraft) =>
  (draftFlow(w, d)?.nodes ?? []).filter((n) => !draftStaff(w, d, n.id).length)
