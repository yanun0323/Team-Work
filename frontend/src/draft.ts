// The task being written on the new-task sheet. It is shared with the sheet taped over it to pick a step's
// employees, and dropped when the new-task sheet goes.

import { create } from 'zustand'
import { isFixed } from './core/domain/graph'
import type { Attachment, World } from './core/domain/types'
import { teamReplicas, teamTasks } from './core/model'

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
  /** Set when editing a task that exists: its own copy of the flow is the one staffed. */
  taskId?: string
}

export const useDraft = create<{ draft: TaskDraft | null }>(() => ({ draft: null }))

export const editDraft = (f: (d: TaskDraft) => Partial<TaskDraft>) =>
  useDraft.setState(({ draft }) => ({ draft: draft && { ...draft, ...f(draft) } }))

/** The pictures among some files (picked, or pasted from the clipboard), read as data URLs. */
export const readImages = (files: Iterable<File>): Promise<Attachment[]> =>
  Promise.all([...files].filter((f) => f.type.startsWith('image/')).map((f) => new Promise<Attachment>((done, fail) => {
    const r = new FileReader()
    r.onload = () => done({ name: f.name || 'image.png', url: String(r.result) })
    r.onerror = () => fail(r.error)
    r.readAsDataURL(f)
  })))

/** Adds pictures to the draft, after any it has. */
export const addImages = async (files: Iterable<File>) => {
  const more = await readImages(files)
  if (more.length) editDraft((d) => ({ images: [...(d.images ?? []), ...more] }))
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

/** The flow the draft is staffing. */
export const draftFlow = (w: World, d: TaskDraft) => (d.taskId ? w.tasks[d.taskId]?.workflow : w.workflows[d.workflowId])

/** Who works a step of the draft: the owner on the two fixed ends, else the step's own pick. */
export const draftStaff = (w: World, d: TaskDraft, nodeId: string): string[] => {
  const wf = draftFlow(w, d)
  if (wf && isFixed(wf, nodeId)) return d.ownerId ? [d.ownerId] : []
  return d.staff[nodeId] ?? []
}

/** The steps nobody works yet, ends included while there is no owner. A task can start only when there are none. */
export const unstaffed = (w: World, d: TaskDraft) =>
  (draftFlow(w, d)?.nodes ?? []).filter((n) => !draftStaff(w, d, n.id).length)
