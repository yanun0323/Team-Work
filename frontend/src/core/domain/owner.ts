// Tasks their owner runs (`orchestration: 'owner'`): what the screens and the simulator both read off one. The
// owner dispatches every step and answers the user in the task's conversation; the flow is only the plan it starts from.

import type { Status, SubTask, Task, TaskOperation, TaskQuestion } from './types'

export const isOwnerTask = (t: Task | undefined): t is Task & { orchestration: 'owner' } => t?.orchestration === 'owner'

/** Questions waiting on the user, oldest first: the owner cannot answer these. */
export const userQuestions = (t: Task): TaskQuestion[] =>
  (t.coordination?.questions ?? []).filter((q) => q.audience === 'user').sort((a, b) => a.createdAt - b.createdAt)

export const operationOf = (t: Task, id: string | undefined): TaskOperation | undefined =>
  id ? t.coordination?.operations.find((o) => o.id === id) : undefined

/** A run still counts: not cancelled, nor replaced by a redo. */
export const currentRun = (s: SubTask) => !s.cancelled && s.validity !== 'superseded'

/** Runs being stopped, and runs nobody can say have stopped. */
export const stopping = (subs: SubTask[]) => subs.filter((s) => currentRun(s) && s.executionState === 'stopping')
export const uncertain = (subs: SubTask[]) => subs.filter((s) => !s.cancelled && s.executionState === 'uncertain')

/**
 * Why the user cannot resume (or start) the task now, or '' when they can: a stop not yet confirmed, a run nobody
 * can vouch for, a question about money or recovery, or no owner.
 */
export function resumeBlock(t: Task, subs: SubTask[]): '' | 'owner' | 'stopping' | 'uncertain' | 'question' {
  if (!t.ownerId) return 'owner'
  if (stopping(subs).length || t.coordination?.operations.some((o) => o.kind === 'pause' && o.status === 'processing')) return 'stopping'
  if (uncertain(subs).length || t.coordination?.operations.some((o) => o.status === 'uncertain')) return 'uncertain'
  if (userQuestions(t).some((q) => q.kind === 'budget' || q.kind === 'recovery')) return 'question'
  return ''
}

/**
 * What keeps the user from merging a task its owner reported done: anything still open. The owner reports again
 * once it is cleared.
 */
export function mergeBlocked(t: Task, subs: SubTask[]) {
  const c = t.coordination
  if (!c) return false
  return c.questions.length > 0 || c.ownerState === 'queued' || c.ownerState === 'responding'
    || c.operations.some((o) => o.status === 'received' || o.status === 'processing' || o.status === 'uncertain')
    || subs.some((s) => currentRun(s) && (s.executionState === 'stopping' || s.executionState === 'uncertain' || s.validity === 'needsRevalidation'
      || s.status !== 'complete' || s.ownerReview === 'pending' || s.ownerReview === 'rejected'))
}

/** Where an owner-run task stands on the board. Not started is 待辦; anything waiting on the user 待回覆. */
export function ownerStatus(t: Task, subs: SubTask[]): Status {
  switch (t.stage) {
    case 'done':
      return 'complete'
    case 'awaitMerge':
      return 'review'
    case 'merging':
      return 'progressing'
  }
  const c = t.coordination
  if (c?.startedAt === undefined) return userQuestions(t).length ? 'review' : 'todo'
  if (userQuestions(t).length || c.ownerState === 'blocked' || c.ownerState === 'failed' || uncertain(subs).length) return 'review'
  return 'progressing'
}
