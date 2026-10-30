import type { Status, SubTask, Task } from './types'

/** Combine child statuses. Rules are listed in BRAINSTORMING.md. */
export function combine(statuses: Status[]): Status {
  if (statuses.length === 0) return 'todo'
  if (statuses.includes('review')) return 'review'
  if (statuses.includes('progressing')) return 'progressing'
  if (statuses.every((s) => s === 'complete')) return 'complete'
  if (statuses.every((s) => s === 'todo')) return 'todo'
  return 'progressing'
}

export function childrenIndex(subs: SubTask[]): Map<string | null, SubTask[]> {
  const map = new Map<string | null, SubTask[]>()
  for (const s of subs) {
    if (s.cancelled) continue
    const list = map.get(s.parentId) ?? []
    list.push(s)
    map.set(s.parentId, list)
  }
  return map
}

export function subTaskStatus(sub: SubTask, index: Map<string | null, SubTask[]>): Status {
  const kids = index.get(sub.id) ?? []
  return combine([sub.status, ...kids.map((k) => subTaskStatus(k, index))])
}

/** Status of a task as shown on the board. */
export function taskStatus(task: Task, subs: SubTask[]): Status {
  if (task.paused && task.pausedStatus) return task.pausedStatus
  switch (task.stage) {
    case 'done':
      return 'complete'
    case 'awaitMerge':
      return 'review'
    // once the user has said merge, the owner is at work on it again
    case 'merging':
      return 'progressing'
  }
  const index = childrenIndex(subs)
  const roots = index.get(null) ?? []
  const status = combine(roots.map((r) => subTaskStatus(r, index)))
  // Every node finished: the task waits to be merged before it is complete.
  return status === 'complete' ? 'review' : status
}
