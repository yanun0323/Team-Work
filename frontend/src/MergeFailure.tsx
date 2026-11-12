// Why a merge failed, said the same way wherever it shows: above the box of a task its owner runs, in its
// conversation, and on the merge row of a task that runs itself. And the button that merges, which says so while it
// does and cannot be pressed twice.
import { useEffect, useState } from 'react'
import { colon, tr } from './core/i18n'
import { requestMerge } from './core/ops'
import { useStore } from './core/store'
import type { MergeFailure, MergeFailureKind, Task, TaskActivity } from './core/domain/types'

const KINDS: readonly MergeFailureKind[] = ['uncommitted', 'moved', 'unresolved', 'noTarget', 'worktreeDirty', 'resolveFailed', 'unknown']

/** What went wrong and what to do next, in one go; the files it names are listed after it. */
export function mergeFailureText(f: MergeFailure): string {
  const target = f.target
  switch (f.kind) {
    case 'uncommitted': return tr('專案資料夾裡下列檔案有未提交的修改，這次合併會覆蓋它們。請先自行提交或暫存，再按合併。')
    case 'moved': return tr('{target} 在合併期間有新的提交。請再按一次合併。', { target })
    case 'unresolved': return tr('{target} 在這段期間有新的提交，自動解決衝突沒有成功。請處理後再合併。', { target })
    case 'noTarget': return tr('找不到目標分支 {target}。請確認專案設定的分支名稱。', { target })
    case 'worktreeDirty': return tr('任務的工作資料夾裡下列檔案還沒提交，所以沒有合併。請負責人派一步提交或清掉它們，再按合併。')
    case 'resolveFailed': return tr('自動解決衝突時，模型呼叫失敗：{reason}。可以再按一次合併。', { reason: f.reason ?? '' })
    default: return tr('合併失敗，原因無法判斷。')
  }
}

/** The failure in a few words, after the task's name in a notification. */
export function mergeFailureShort(f: MergeFailure): string {
  switch (f.kind) {
    case 'uncommitted': return tr('專案資料夾有未提交的修改擋住合併')
    case 'moved': return tr('{target} 在合併期間有新的提交', { target: f.target })
    case 'unresolved': return tr('自動解決衝突沒有成功')
    case 'noTarget': return tr('找不到目標分支 {target}', { target: f.target })
    case 'worktreeDirty': return tr('任務的工作資料夾有未提交的檔案')
    case 'resolveFailed': return tr('解衝突的模型呼叫失敗')
    default: return tr('原因無法判斷')
  }
}

/** The failure a mergeFailed line of a task's conversation carries, or none from a backend that did not send it. */
export function failureOf(a: TaskActivity): MergeFailure | null {
  const x = a.args ?? {}
  if (a.key !== 'mergeFailed' || !KINDS.includes(x.kind as MergeFailureKind)) return null
  const text = (v: unknown) => (typeof v === 'string' ? v : '')
  return {
    kind: x.kind as MergeFailureKind,
    target: text(x.target),
    files: Array.isArray(x.files) ? x.files.filter((n): n is string => typeof n === 'string') : [],
    more: typeof x.more === 'number' ? x.more : 0,
    reason: text(x.reason),
    detail: text(x.detail),
  }
}

/** The failure as a line: for a conversation's preview. */
export const mergeFailureLine = (f: MergeFailure) => `${tr('合併失敗')}${colon()}${mergeFailureText(f)}`

/**
 * 合併失敗, why and what to do next, and the files in the way, the first five and a count of all. `git` adds git's
 * own words, folded unless they are all there is to go on.
 */
export function MergeFailureView({ failure: f, git }: { failure: MergeFailure; git?: boolean }) {
  const files = f.files ?? []
  return (
    <div className="fx-merge-fail">
      <p><b className="fx-merge-fail-head">{tr('合併失敗')}</b> {mergeFailureText(f)}</p>
      {files.length > 0 && (
        <ul className="fx-merge-fail-files">
          {files.map((name) => <li key={name}><code>{name}</code></li>)}
          {!!f.more && <li>{tr('等 {n} 個', { n: files.length + f.more })}</li>}
        </ul>
      )}
      {git && f.detail && (
        <details className="fx-merge-fail-git" open={f.kind === 'unknown'}>
          <summary>{tr('Git 訊息')}</summary>
          <pre>{f.detail}</pre>
        </details>
      )}
    </div>
  )
}

/** 合併, which once pressed says 合併中… until the merge is under way and while it is, and cannot be pressed again. */
export function MergeButton({ task, disabled }: { task: Task; disabled?: boolean }) {
  const act = useStore((s) => s.act)
  const [sent, setSent] = useState(false)
  // the merge took it on, or ended: the task says where it stands from then on
  useEffect(() => setSent(false), [task.stage, task.merge?.log.length])
  const busy = sent || task.stage === 'merging'
  const merge = () => {
    setSent(true)
    void requestMerge(act, task.id).then((taken) => { if (!taken) setSent(false) })
  }
  return (
    <button type="button" className="fx-save fx-danger" disabled={disabled || busy} aria-busy={busy || undefined} onClick={merge}>
      {busy ? tr('合併中…') : tr('合併')}
    </button>
  )
}
