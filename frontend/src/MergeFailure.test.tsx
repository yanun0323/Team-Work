import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Detail } from './DrawerDetail'
import { useStore } from './core/store'
import { isOwnerTask } from './core/domain/owner'
import { subsOf } from './core/domain/sim'
import type { Task } from './core/domain/types'

const w = useStore.getState().world
const owned = Object.values(w.tasks).find(isOwnerTask)!
const noop = () => {}

const sheet = (task: Task) => renderToStaticMarkup(
  <Detail item={{ kind: 'task', id: task.id }} teamId={task.teamId} depth={0} covered={false} leaving={false}
    onGone={noop} onBack={noop} onDone={noop} onClear={noop} onPush={noop} onOpen={noop} />,
)

// What the backend leaves on a task when git refuses to land it: the task waits to be merged again, with the
// failure as the last line of its merge's log.
const failed = '合併失敗：無法更新 main：error: Your local changes to the following files would be overwritten by merge: AGENTS.md'

describe('a merge that failed, on the sheet of a task its owner runs', () => {
  it('says the merge failed and why, beside the button to merge again', () => {
    const was = { stage: owned.stage, merge: owned.merge, questions: owned.coordination!.questions }
    const subs = subsOf(w, owned.id)
    const kept = subs.map((s) => ({ s, review: s.ownerReview, state: s.executionState, status: s.status }))
    try {
      owned.stage = 'awaitMerge'
      owned.coordination!.questions = []
      for (const s of subs) { s.ownerReview = 'accepted'; s.executionState = undefined; s.status = 'complete' }
      owned.merge = { replicaId: owned.ownerId ?? null, conflict: false, log: [
        { at: 1, kind: 'human', text: '合併' },
        { at: 2, kind: 'system', text: 'Ada 開始把 task/4 合併到 main' },
        { at: 3, kind: 'system', text: failed },
      ] }
      const html = sheet(owned)
      expect(html).toContain('>合併</button>')
      expect(html).toContain('合併失敗')
      expect(html).toContain('AGENTS.md')
    } finally {
      for (const k of kept) { k.s.ownerReview = k.review; k.s.executionState = k.state; k.s.status = k.status }
      Object.assign(owned, { stage: was.stage, merge: was.merge })
      owned.coordination!.questions = was.questions
    }
  })
})
