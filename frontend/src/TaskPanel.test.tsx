import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Detail } from './DrawerDetail'
import { activityText, Feed, HistoryState, joinNewest, QuestionCard, runWord, StepStrip, type Unsent } from './TaskPanel'
import { useStore } from './core/store'
import { isOwnerTask } from './core/domain/owner'
import { subsOf } from './core/domain/sim'
import type { SubTask, Task, TaskActivity, TaskOperation } from './core/domain/types'

const w = useStore.getState().world
const owned = Object.values(w.tasks).find(isOwnerTask)!
const legacy = Object.values(w.tasks).find((t) => !isOwnerTask(t) && t.stage === 'running')!
const noop = () => {}

const sheet = (task: Task) => renderToStaticMarkup(
  <Detail item={{ kind: 'task', id: task.id }} teamId={task.teamId} depth={0} covered={false} leaving={false}
    onGone={noop} onBack={noop} onDone={noop} onClear={noop} onPush={noop} onOpen={noop} />,
)

const line = (a: Partial<TaskActivity>): TaskActivity => ({ id: `a${a.seq}`, seq: 1, at: 0, kind: 'message', from: 'agent', text: '', planVersion: 1, ...a })

const feed = (items: TaskActivity[], extra: { unsent?: Unsent[]; expanded?: string[]; ops?: Record<string, TaskOperation> } = {}) => renderToStaticMarkup(
  <ol>
    <Feed task={owned} items={items} unsent={extra.unsent ?? []} open={null} onStep={noop} expanded={extra.expanded ?? []} onExpand={noop}
      ops={(id) => (id ? extra.ops?.[id] : undefined)} onResend={noop} onEdit={noop} />
  </ol>,
)

describe('the sheet of a task its owner runs', () => {
  it('shows its owner stamped as chair, its steps, a box that writes to the owner alone, and the question waiting on the user', () => {
    const html = sheet(owned)
    const owner = w.replicas[owned.ownerId!]
    expect(html).toContain('fx-ticket')
    expect(html).toContain(`${owner.name}</button><span class="fx-pill fx-chair">主持人</span>`)
    for (const s of subsOf(w, owned.id)) expect(html).toContain(`>${owned.workflow.nodes.find((n) => n.id === s.nodeId)!.name}</span>`)
    expect(html).toContain('>計畫')
    expect(html).toContain(`對 ${owner.name} 說，# 選檔案`)
    // nobody else is written to from here
    expect(html).not.toContain('@ 找員工')
    expect(html).toContain('aria-label="待你回答"')
    expect(html).toContain('>同意</button>')
    expect(html).toContain('>原訊息</button>')
  })

  it('keeps an older task on its own sheet, with no box to the owner', () => {
    const html = sheet(legacy)
    expect(html).toContain('舊制流程')
    expect(html).not.toContain('fx-ticket')
    expect(html).not.toContain('說，# 選檔案')
  })

  it('waits on the user to merge once the owner reports it done, but not while something is still open', () => {
    const was = owned.stage
    const questions = owned.coordination!.questions
    try {
      owned.stage = 'awaitMerge'
      expect(sheet(owned)).toMatch(/還有待處理的事，處理完才能合併<\/p><button type="button" class="fx-save fx-danger" disabled="">合併/)
      owned.coordination!.questions = []
      const subs = subsOf(w, owned.id)
      const kept = subs.map((s) => ({ s, review: s.ownerReview, state: s.executionState }))
      for (const s of subs) { s.ownerReview = 'accepted'; s.executionState = undefined }
      try {
        expect(sheet(owned)).toMatch(/負責人回報完成，等你合併<\/p><button type="button" class="fx-save fx-danger">合併/)
      } finally {
        for (const k of kept) { k.s.ownerReview = k.review; k.s.executionState = k.state }
      }
    } finally {
      owned.stage = was
      owned.coordination!.questions = questions
    }
  })

  it('offers no box once the task has ended, and asks for an owner when it has none', () => {
    const t = owned
    const was = { stage: t.stage, ownerId: t.ownerId }
    try {
      t.stage = 'done'
      expect(sheet(t)).toContain('任務已結束，可以複製成新任務')
      t.stage = was.stage
      t.ownerId = null
      const html = sheet(t)
      expect(html).toContain('先選任務負責人')
      expect(html).not.toContain('fx-room-say')
    } finally {
      Object.assign(t, was)
    }
  })
})

describe('its conversation', () => {
  it('signs each message by its writer and step, and shows what happened as short lines in the user\'s language', () => {
    const sub = subsOf(w, owned.id)[0]
    const html = feed([
      line({ seq: 1, kind: 'event', from: 'system', key: 'dispatched', args: { owner: 'Mira', name: 'Kai', step: '開發' }, text: 'raw', subId: sub.id, nodeId: sub.nodeId }),
      line({ seq: 2, kind: 'handoff', name: 'Kai', text: '做好了', subId: sub.id, nodeId: sub.nodeId }),
    ])
    expect(html).toContain('Mira 派 Kai 做「開發」')
    expect(html).not.toContain('raw')
    expect(html).toContain('Kai · 交付')
    expect(html).toContain('class="fx-ticket-tag fx-hit" aria-expanded="false"')
  })

  it('shows an event it does not know, or cannot fill in, as the backend wrote it', () => {
    expect(activityText(line({ kind: 'event', key: 'newKind', text: '新的事件' }))).toBe('新的事件')
    expect(activityText(line({ kind: 'event', key: 'dispatched', args: { node: 'x' }, text: '後端的句子' }))).toBe('後端的句子')
  })

  it('gathers a meeting\'s words into one line, read when opened', () => {
    const items = [
      line({ seq: 1, kind: 'meeting', name: 'Ada', text: '第一句', meetingId: 'm', nodeId: owned.workflow.nodes[0].id }),
      line({ seq: 2, kind: 'meeting', name: 'Leo', text: '第二句', meetingId: 'm', nodeId: owned.workflow.nodes[0].id }),
    ]
    const shut = feed(items)
    expect(shut).toContain('2 則發言')
    expect(shut).toContain('aria-expanded="false"')
    expect(shut).not.toContain('第一句')
    const open = feed(items, { expanded: ['m'] })
    expect(open).toContain('第一句')
    expect(open).toContain('第二句')
  })

  it('says where each thing the user sent stands, and keeps a failed one to send again or edit', () => {
    const op = (status: TaskOperation['status']): TaskOperation => ({ id: status, kind: 'message', status, at: 0, updatedAt: 0 })
    const html = feed([line({ seq: 1, from: 'user', text: '改方向', operationId: 'processing' })], {
      ops: { processing: op('processing') },
      unsent: [
        { requestId: 'r1', text: '還在送', attachments: [], state: 'sending' },
        { requestId: 'r2', text: '沒送到', attachments: [], state: 'failed', error: '連不上後端' },
        { requestId: 'r3', text: '已經在上面', attachments: [], state: 'sent', activityId: 'a1' },
      ],
    })
    expect(html).toContain('處理中')
    expect(html).toContain('傳送中…')
    expect(html).toContain('role="alert">傳送失敗：連不上後端')
    expect(html).toContain('>重試</button>')
    expect(html).toContain('>編輯</button>')
    // one already in the conversation is not shown twice
    expect(html).not.toContain('已經在上面')
  })
})

describe('reading it in pages', () => {
  const seqs = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => line({ seq: from + i }))
  it('keeps earlier pages that reach up to the newest, and drops them across a gap', () => {
    expect(joinNewest(seqs(1, 60), seqs(51, 62), 62).map((a) => a.seq)).toEqual(seqs(1, 62).map((a) => a.seq))
    expect(joinNewest(seqs(1, 10), seqs(13, 62), 62).map((a) => a.seq)).toEqual(seqs(13, 62).map((a) => a.seq))
    expect(joinNewest([], [], 0)).toEqual([])
  })

  it('says it is reading, and when reading failed offers to try again', () => {
    const show = (p: Partial<Parameters<typeof HistoryState>[0]>) => renderToStaticMarkup(<ol><HistoryState busy={false} ready error="" onRetry={noop} {...p} /></ol>)
    expect(show({ busy: true, ready: false })).toContain('role="status">載入中…')
    // an earlier page being read keeps what is shown
    expect(show({ busy: true, ready: true })).not.toContain('載入中')
    const failed = show({ error: '連不上後端' })
    expect(failed).toContain('role="alert"><p>讀取對話失敗：連不上後端</p>')
    expect(failed).toContain('>重試</button>')
  })
})

describe('its steps', () => {
  it('names where each run stands, a run sent back and one nobody can vouch for included', () => {
    const base = subsOf(w, owned.id)[0]
    const run = (p: Partial<SubTask>) => ({ ...base, ...p })
    expect(runWord(run({ validity: 'superseded' }))).toBe('已退回')
    expect(runWord(run({ executionState: 'uncertain' }))).toBe('無法確認')
    expect(runWord(run({ executionState: 'stopping' }))).toBe('停止中')
    expect(runWord(run({ validity: 'needsRevalidation', executionState: undefined }))).toBe('待重驗')
    expect(runWord(run({ ownerReview: 'pending', validity: 'current', executionState: undefined }))).toBe('等負責人確認')
    const html = renderToStaticMarkup(<StepStrip task={owned} subs={[run({ id: 'x', validity: 'superseded' })]} open="x" onOpen={noop} flowOpen={false} onFlow={noop} replicas={w.replicas} />)
    expect(html).toContain('fx-ticket-step-old')
    expect(html).toContain('aria-expanded="true"')
  })

  it('asks each question with its own choices and a way back to where it was asked', () => {
    const q = owned.coordination!.questions[0]
    const html = renderToStaticMarkup(<QuestionCard task={owned} q={q} onJump={noop} onAnswer={noop} state={{ sending: false, error: '任務在你看到之後有了變化' }} />)
    expect(html).toContain(q.prompt.slice(0, 10))
    expect(html).toContain('>拒絕</button>')
    // nothing picked yet: it cannot be sent
    expect(html).toMatch(/<button type="submit" class="fx-save" disabled="">確認<\/button>/)
    expect(html).toContain('role="alert">任務在你看到之後有了變化')
  })
})
