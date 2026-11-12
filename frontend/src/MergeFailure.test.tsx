import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Detail } from './DrawerDetail'
import { eventLines, Feed } from './TaskPanel'
import { failureOf, MergeButton, mergeFailureShort, MergeFailureView } from './MergeFailure'
import { useStore } from './core/store'
import { isOwnerTask } from './core/domain/owner'
import { subsOf } from './core/domain/sim'
import type { MergeFailure, Task, TaskActivity } from './core/domain/types'

const w = useStore.getState().world
const owned = Object.values(w.tasks).find(isOwnerTask)!
const noop = () => {}

const sheet = (task: Task) => renderToStaticMarkup(
  <Detail item={{ kind: 'task', id: task.id }} teamId={task.teamId} depth={0} covered={false} leaving={false}
    onGone={noop} onBack={noop} onDone={noop} onClear={noop} onPush={noop} onOpen={noop} />,
)

// What the backend leaves on a task when git refuses to land it: the task waits to be merged again, with the
// failure as the last line of its merge's log and, told apart, as the merge's failure.
const failed = '合併失敗：專案資料夾裡的 AGENTS.md 有未提交的修改，這次合併會覆蓋它們。請先自行提交或暫存，再按合併。'
const refused: MergeFailure = {
  kind: 'uncommitted', target: 'main', files: ['AGENTS.md'],
  detail: 'git merge: exit status 1: error: Your local changes to the following files would be overwritten by merge:\n\tAGENTS.md\nAborting',
}

/** The owner's task as it stands at a stage, every step done and accepted, with a merge; put back after. */
function asIf<T>(stage: Task['stage'], merge: Task['merge'], fn: () => T): T {
  const was = { stage: owned.stage, merge: owned.merge, questions: owned.coordination!.questions }
  const subs = subsOf(w, owned.id)
  const kept = subs.map((s) => ({ s, review: s.ownerReview, state: s.executionState, status: s.status }))
  try {
    owned.stage = stage
    owned.coordination!.questions = []
    for (const s of subs) { s.ownerReview = 'accepted'; s.executionState = undefined; s.status = 'complete' }
    owned.merge = merge
    return fn()
  } finally {
    for (const k of kept) { k.s.ownerReview = k.review; k.s.executionState = k.state; k.s.status = k.status }
    Object.assign(owned, { stage: was.stage, merge: was.merge })
    owned.coordination!.questions = was.questions
  }
}

const log = (...more: string[]) => [
  { at: 1, kind: 'human' as const, text: '合併' },
  { at: 2, kind: 'system' as const, text: 'Ada 開始把 task/4 合併到 main' },
  ...more.map((text, i) => ({ at: 3 + i, kind: 'system' as const, text })),
]

describe('a merge that failed, on the sheet of a task its owner runs', () => {
  it('says the merge failed and why, beside the button to merge again', () => {
    const html = asIf('awaitMerge', { replicaId: owned.ownerId ?? null, conflict: false, log: log(failed), failure: refused }, () => sheet(owned))
    expect(html).toContain('>合併</button>')
    expect(html).toContain('合併失敗')
    expect(html).toContain('AGENTS.md')
    expect(html).toContain('請先自行提交或暫存，再按合併')
    expect(html).not.toContain('負責人回報完成，等你合併')
  })

  it('says it is merging while it does, the button not to be pressed again', () => {
    const html = asIf('merging', { replicaId: owned.ownerId ?? null, conflict: false, log: log(), startedAt: 2 }, () => sheet(owned))
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-busy="true"[^>]*>合併中…<\/button>/)
    expect(html).toContain('正在合併到')
    expect(html).not.toContain('負責人回報完成，等你合併')
    expect(html).not.toContain('>合併</button>')
  })

  it('waits to be merged as before once nothing failed', () => {
    const html = asIf('awaitMerge', { replicaId: owned.ownerId ?? null, conflict: false, log: log() }, () => sheet(owned))
    expect(html).toContain('負責人回報完成，等你合併')
    expect(html).toContain('>合併</button>')
    expect(html).not.toContain('合併失敗')
  })
})

describe('what a failed merge shows', () => {
  it('names the first five files and counts them all', () => {
    const html = renderToStaticMarkup(<MergeFailureView failure={{ ...refused, files: ['a', 'b', 'c', 'd', 'e'], more: 2 }} />)
    expect(html.match(/<code>/g)).toHaveLength(5)
    expect(html).toContain('等 7 個')
  })

  it('keeps git’s words folded when it told why, open when it could not', () => {
    const known = renderToStaticMarkup(<MergeFailureView failure={refused} git />)
    expect(known).toContain('Git 訊息')
    expect(known).not.toMatch(/<details[^>]*open/)
    const unknown = renderToStaticMarkup(<MergeFailureView failure={{ kind: 'unknown', target: 'main', detail: 'fatal: something else' }} git />)
    expect(unknown).toContain('合併失敗，原因無法判斷。')
    expect(unknown).toMatch(/<details[^>]*open=""/)
    expect(unknown).toContain('fatal: something else')
    // on the bar above the box, without git's words
    expect(renderToStaticMarkup(<MergeFailureView failure={refused} />)).not.toContain('Git 訊息')
  })

  it('has words of its own for every kind', () => {
    const kinds = ['uncommitted', 'moved', 'unresolved', 'noTarget', 'worktreeDirty', 'resolveFailed', 'unknown'] as const
    const said = kinds.map((kind) => renderToStaticMarkup(<MergeFailureView failure={{ kind, target: 'main', reason: '逾時' }} />))
    expect(new Set(said).size).toBe(kinds.length)
    expect(said[1]).toContain('main 在合併期間有新的提交')
    expect(said[5]).toContain('模型呼叫失敗：逾時')
    expect(new Set(kinds.map((kind) => mergeFailureShort({ kind, target: 'main' }))).size).toBe(kinds.length)
  })

  it('stays in the conversation as a line with git’s words and no button', () => {
    const a: TaskActivity = {
      id: 'x-a9', seq: 9, at: 5, kind: 'event', from: 'system', text: failed, key: 'mergeFailed', planVersion: 1,
      args: { kind: 'uncommitted', target: 'main', files: ['AGENTS.md'], more: 0, reason: '', detail: refused.detail },
    } as TaskActivity
    expect(failureOf(a)).toEqual({ ...refused, more: 0, reason: '' })
    expect(eventLines(a)).toEqual(['合併失敗：專案資料夾裡下列檔案有未提交的修改，這次合併會覆蓋它們。請先自行提交或暫存，再按合併。'])
    const html = renderToStaticMarkup(<Feed task={owned} items={[a]} unsent={[]} open={null} onStep={noop} expanded={[]} onExpand={noop}
      ops={() => undefined} onResend={noop} onEdit={noop} />)
    expect(html).toContain('AGENTS.md')
    expect(html).toContain('Git 訊息')
    expect(html).not.toContain('<button')
    // one from a backend that did not tell it apart reads as it was written
    expect(eventLines({ ...a, args: undefined })).toEqual([failed])
  })

  it('on the merge row of a task that runs itself, with the same words', () => {
    const legacy = Object.values(w.tasks).find((t) => !isOwnerTask(t) && t.stage !== 'done')!
    const was = { stage: legacy.stage, merge: legacy.merge }
    try {
      legacy.stage = 'awaitMerge'
      legacy.merge = { replicaId: null, conflict: false, log: log(failed), failure: refused }
      const html = sheet(legacy)
      expect(html).toContain('專案資料夾裡下列檔案有未提交的修改')
      expect(html).toContain('<code>AGENTS.md</code>')
      expect(html).toContain('>合併</button>')
    } finally {
      Object.assign(legacy, was)
    }
  })

  it('cannot be pressed while the merge is under way', () => {
    const html = renderToStaticMarkup(<MergeButton task={{ ...owned, stage: 'merging' }} />)
    expect(html).toContain('disabled')
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('合併中…')
  })
})
