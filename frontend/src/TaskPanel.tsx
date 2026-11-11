// A task its owner runs, as one ticket: what it is and who owns it, its steps, then the conversation with the owner,
// with what waits on the user pinned above the box to write in. The user talks to the owner alone; the employees'
// handoffs, questions and meetings show under their own names, and what the owner does shows as short lines. Every
// action is followed from received to taken effect or failed.

import { useContext, useEffect, useRef, useState } from 'react'
import { colon, listOf, tr, trRecorded } from './core/i18n'
import { ApiError } from './core/backend'
import { shownUrl } from './core/island'
import { nodeOf } from './core/domain/graph'
import { currentRun, isOwnerTask, mergeBlocked, operationOf, resumeBlock, uncertain, userQuestions } from './core/domain/owner'
import { notStarted, statusOf, subsOf, taskCost, taskTokens } from './core/domain/sim'
import type { Attachment, Meeting, SubTask, Task, TaskActivity, TaskOperation, TaskQuestion, World } from './core/domain/types'
import { controlMeeting, controlTask, deleteTask, mergeTask, newRequestId, readMeetingActivity, readTaskActivity, readTaskActivityItem, readTaskOperation, sayToOwner, seenVersions, type OwnerControl } from './core/ops'
import { fmtClock, fmtTokens, useStickToBottom } from './core/model'
import { useLiveText } from './core/live'
import { useNow, useStore } from './core/store'
import { PixelFace } from './core/voxel/PixelFace'
import { Markdown, MarkdownLine } from './Markdown'
import { MentionBox } from './MentionBox'
import { attachable, FileAttachment, isImage, MAX_ATTACHMENTS, readAttachments, splitAttachments } from './attachments'
import { BranchIcon, CopyIcon, DeleteTool, EditTool, Gone, Heading, type Head } from './DrawerDetail'
import { ChangeLines } from './ChangeCard'
import { CopyButton } from './CopyButton'
import { idsAsNames, SaidChip, SaidContext } from './Said'
import { ALL, type IdLookup } from './mentions'
import { SentTo } from './ChatSheet'
import { ChatFaces } from './ChatFaces'
import { CrewRow } from './Pickers'
import { activeMeeting, answerers, draftStillGoes, feedRows, meetingActions, meetingMentions, meetingPeople, meetingTakesWords, meetingWord } from './meetingFeed'

const STATUS = { todo: '待辦', progressing: '進行中', review: '待回覆', complete: '完成' } as const

/** How long a step that just took effect keeps saying so. */
const SAID_FOR = 6

const stepName = (t: Task, nodeId: string | undefined) => (nodeId ? nodeOf(t.workflow, nodeId)?.name ?? nodeId : '')

/** What of a change of the plan an event lists after its first line: the owner's, and the user's on the edit sheet. */
const PLAN_PARTS: Record<string, readonly string[]> = {
  planChanged: ['added', 'skipped', 'restaffed', 'linked', 'unlinked'],
  editedByUser: ['added', 'removed', 'changed', 'restaffed', 'linked', 'unlinked'],
}

/**
 * An event in the user's language, a line each: by its key when this version knows it, else as the backend wrote it.
 * A change of the plan lists what it added, skipped or removed, changed, gave to someone else and linked or unlinked.
 */
export function eventLines(a: TaskActivity): string[] {
  const recorded = a.text.split('\n').filter(Boolean)
  if (!a.key) return recorded
  const key = `task.${a.key}`
  const template = trRecorded(key)
  if (template === key) return recorded
  // a line whose words this version would leave holes in reads as the backend wrote it
  const args = Object.fromEntries(Object.entries(a.args ?? {}).map(([k, v]) => [k, String(v)]))
  const holes = [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1])
  if (!holes.every((h) => h in args)) return recorded
  const parts = (PLAN_PARTS[a.key] ?? []).filter((p) => args[p]).map((p) => trRecorded(`task.plan.${p}`, { value: args[p] }))
  return [trRecorded(key, args), ...parts]
}

export const activityText = (a: TaskActivity) => eventLines(a)[0] ?? ''

/**
 * What the ids the owner writes name in a task: a run, by who works it, and an employee, here or gone; and a record, of
 * this task or another. A run or record of another task says which; one written as the backend writes ids that no task
 * has is gone. A word that only looks like an id is not one.
 */
export function crewIds(w: World, task: Task): IdLookup {
  const taskOf = (id: string) => (id === task.id || !w.tasks[id] ? undefined : `#${w.tasks[id].number} ${w.tasks[id].title}`)
  return (word) => {
    const s = w.subTasks[word]
    if (s) return { kind: 'crew', id: s.replicaId ?? undefined, step: w.tasks[s.taskId] ? stepName(w.tasks[s.taskId], s.nodeId) : undefined, task: taskOf(s.taskId) }
    if (/^sub-\d+$/.test(word)) return { kind: 'crew' }
    if (w.replicas[word] || /^rep-\d+$/.test(word)) return { kind: 'crew', id: word }
    for (const t of [task, ...Object.values(w.tasks)]) {
      const f = t.coordination?.facts.find((x) => x.id === word)
      if (f) return { kind: 'fact', fact: { kind: f.kind, text: f.text }, task: taskOf(t.id) }
    }
    return /^fact-\d+$/.test(word) ? { kind: 'fact' } : null
  }
}

/** The ids of a task, read again as its runs and employees change. */
function useCrewIds(task: Task): IdLookup {
  const w = useStore((s) => s.world)
  return crewIds(w, task)
}


/** What a step's run is doing, in a word, or '' when its bar or handoff says it. */
export function runWord(s: SubTask): string {
  if (s.cancelled) return tr('已停止')
  if (s.validity === 'superseded') return tr('已退回')
  if (s.executionState === 'uncertain') return tr('無法確認')
  if (s.executionState === 'stopping') return tr('停止中')
  if (s.validity === 'needsRevalidation') return tr('待重驗')
  if (s.ownerReview === 'pending') return tr('等負責人確認')
  if (s.status === 'complete') return s.skipped ? tr('略過') : tr('完成')
  // a meeting held in the conversation has no progress to count
  if (s.meeting && s.status === 'progressing') return s.meeting.state === 'paused' ? tr('已暫停') : tr('開會中')
  if (s.executionState === 'stopped') return tr('已停止')
  if (s.status === 'progressing') return `${Math.round(s.progress * 100)}%`
  return s.replicaId ? tr('準備開始') : tr('等人接手')
}

/** An action's state as the user reads it. */
export const OP_WORDS = (): Record<TaskOperation['status'] | 'sending', string> => ({
  sending: tr('傳送中…'), received: tr('已收到'), processing: tr('處理中'), applied: tr('已生效'), failed: tr('失敗'), uncertain: tr('無法確認'),
})

const errorOf = (e: unknown) => ({ message: (e as Error).message, code: (e as ApiError).code ?? '' })

/**
 * One action at a time from one control, with its requestId kept while it is the same action, so sending it again
 * after a lost answer is not done twice. A refusal for being out of date needs a fresh look, and a fresh id.
 */
function useTracked() {
  const [sent, setSent] = useState<{ key: string; requestId: string; state: 'sending' | 'sent' | 'failed'; error?: string; stale?: boolean; operationId?: string } | null>(null)
  const send = async (key: string, call: (requestId: string) => Promise<{ operation: TaskOperation }>) => {
    const requestId = sent && sent.key === key && sent.state === 'failed' && !sent.stale ? sent.requestId : newRequestId()
    setSent({ key, requestId, state: 'sending' })
    try {
      const { operation } = await call(requestId)
      setSent({ key, requestId, state: 'sent', operationId: operation.id })
      return true
    } catch (e) {
      const { message, code } = errorOf(e)
      setSent({ key, requestId, state: 'failed', error: message, stale: code === 'conflict' })
      return false
    }
  }
  return { sent, send, clear: () => setSent(null) }
}

/**
 * An action's state: from the task while it lists it; once it no longer does (it closed while the connection was
 * down), asked for once.
 */
function useOperation(task: Task | undefined, id: string | undefined): TaskOperation | undefined {
  const listed = task && operationOf(task, id)
  const snapshot = useStore((s) => s.snapshot)
  const [asked, setAsked] = useState<TaskOperation | undefined>()
  const taskId = task?.id
  useEffect(() => {
    if (!id || listed || !taskId) return
    const abort = new AbortController()
    readTaskOperation(useStore.getState().world, taskId, id, abort.signal).then(setAsked).catch(() => {})
    return () => abort.abort()
  }, [id, !!listed, snapshot, taskId])
  return listed ?? (asked?.id === id ? asked : undefined)
}

// ---------- the conversation, read in pages ----------

interface Loaded { taskId: string; snapshot: number; version: string; items: TaskActivity[] }

/**
 * The newest page joined to what was read before: older lines stay while they reach up to the page, and are dropped
 * when a gap opened between them (the conversation grew by more than a page while the sheet was away).
 */
export function joinNewest(before: TaskActivity[], page: TaskActivity[], total: number): TaskActivity[] {
  const first = page[0]?.seq ?? total + 1
  const older = (before.at(-1)?.seq ?? 0) >= first - 1 ? before.filter((a) => a.seq < first) : []
  return [...older, ...page]
}

/** The newest page of a task's conversation, read again when it changes; earlier pages on request. */
export function useTaskActivity(task: Task | undefined) {
  const snapshot = useStore((s) => s.snapshot)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [again, setAgain] = useState(0)
  const kept = useRef(loaded)
  kept.current = loaded
  const version = task?.coordination?.history.version ?? ''
  const taskId = task?.coordination ? task.id : ''
  useEffect(() => {
    if (!taskId) return
    const abort = new AbortController()
    setBusy(true)
    setError('')
    readTaskActivity(useStore.getState().world, taskId, { limit: 50 }, abort.signal).then((page) => {
      if (abort.signal.aborted) return
      const prev = kept.current?.taskId === taskId && kept.current.snapshot === snapshot ? kept.current : null
      setLoaded({ taskId, snapshot, version: page.version, items: joinNewest(prev?.items ?? [], page.items, page.total) })
    }).catch((e: Error) => { if (!abort.signal.aborted) setError(e.message) })
      .finally(() => { if (!abort.signal.aborted) setBusy(false) })
    return () => abort.abort()
  }, [taskId, version, snapshot, again])
  const mine = taskId && loaded?.taskId === taskId && loaded.snapshot === snapshot ? loaded : null
  /** Reads earlier pages until `seq` is in; false if it could not. */
  const back = async (seq = 0) => {
    let now = mine
    if (!now || busy) return false
    setBusy(true)
    setError('')
    try {
      while ((now.items[0]?.seq ?? 1) > Math.max(1, seq)) {
        const before: number = now.items[0].seq
        const page = await readTaskActivity(useStore.getState().world, taskId, { before, limit: seq ? Math.min(100, Math.max(1, before - seq)) : 50, version: now.version })
        now = { ...now, items: [...page.items, ...now.items] }
        setLoaded(now)
        if (!seq || !page.items.length) break
      }
      return true
    } catch (e) {
      // the conversation moved on while reading: start again from its newest page
      if ((e as ApiError).code === 'conflict') setAgain((n) => n + 1)
      else setError((e as Error).message)
      return false
    } finally { setBusy(false) }
  }
  return {
    items: mine?.items ?? [],
    ready: !!mine,
    busy,
    error,
    earlier: (mine?.items[0]?.seq ?? 1) > 1,
    back,
    retry: () => setAgain((n) => n + 1),
  }
}

/** Where reading the conversation stands, at its top: reading, or failed with a way to try again. */
export function HistoryState({ busy, ready, error, onRetry }: { busy: boolean; ready: boolean; error: string; onRetry: () => void }) {
  return (
    <>
      {busy && !ready && <li className="fx-d-muted" role="status">{tr('載入中…')}</li>}
      {error && (
        <li className="fx-ticket-notice" role="alert"><p>{tr('讀取對話失敗')}{colon()}{error}</p><button type="button" className="fx-chat-act fx-hit" onClick={onRetry}>{tr('重試')}</button></li>
      )}
    </>
  )
}

// ---------- pieces ----------

/** A face with the name it had then, for those who have left. */
function Face({ a, size = 22 }: { a: Pick<TaskActivity, 'name' | 'look' | 'by'>; size?: number }) {
  // the look kept with the line, else theirs now, while they are still here
  const now = useStore((s) => (a.by ? s.world.replicas[a.by]?.look : undefined))
  const look = a.look ?? now
  return look ? <PixelFace look={look} name={a.name ?? ''} size={size} /> : <span className="fx-d-noface" />
}

/** The step a line came from, opening its run. */
function StepTag({ task, a, open, onStep }: { task: Task; a: TaskActivity; open: string | null; onStep: (subId: string) => void }) {
  if (!a.nodeId) return null
  const name = stepName(task, a.nodeId)
  return a.subId
    ? <button type="button" className="fx-ticket-tag fx-hit" aria-expanded={open === a.subId} onClick={() => onStep(a.subId!)}>{name}</button>
    : <span className="fx-ticket-tag">{name}</span>
}

function Attachments({ a, onImage }: { a: Pick<TaskActivity, 'images' | 'files' | 'id'>; onImage?: (key: string, im: Attachment) => void }) {
  if (!a.images?.length && !a.files?.length) return null
  return (
    <div className="fx-chat-images">
      {a.images?.map((im, j) => (
        <button key={j} type="button" className="fx-chat-image fx-hit" onClick={() => onImage?.(`activity:${a.id}:${j}`, im)}>
          <img src={shownUrl(im.url)} alt={im.name} />
        </button>
      ))}
      {a.files?.map((f, j) => <FileAttachment key={j} file={f} />)}
    </div>
  )
}

/** Where something the user sent stands, under it. */
function OpWord({ op }: { op: TaskOperation | undefined }) {
  if (!op) return null
  return <span className={`fx-ticket-op fx-ticket-op-${op.status}`}>{op.status === 'failed' && op.error ? `${OP_WORDS().failed}${colon()}${op.error.message}` : OP_WORDS()[op.status]}</span>
}

/** A message, a handoff, a question, a short line, or a meeting's words gathered. */
export function ActivityRow({ task, a, open, onStep, onImage, flash, op, meeting }: {
  task: Task
  a: TaskActivity
  open: string | null
  onStep: (subId: string) => void
  onImage?: (key: string, im: Attachment) => void
  flash?: boolean
  op?: TaskOperation
  /** The meeting held in the conversation the line is words of. */
  meeting?: Meeting
}) {
  const said = a.meetingVersion === 2
  const cls = `${flash ? ' fx-d-flash' : ''}${said ? ' fx-ticket-meet' : ''}`
  // the meeting the words were said in, in place of the step
  const tag = said ? <span className="fx-ticket-tag fx-ticket-meet-tag">{tr('會議')}</span> : null
  const asked = said && a.mentions?.length && meeting
    ? a.mentions.flatMap((id) => meeting.participants.filter((p) => p.replicaId === id).map((p) => ({ id, name: p.name, look: p.look })))
    : []
  const ids = useCrewIds(task)
  const opens = useContext(SaidContext)
  // a task the owner made opens from the line that says so, while it is there
  const made = a.key === 'taskCreated' && typeof a.args?.taskId === 'string' ? a.args.taskId : ''
  const madeThere = useStore((s) => !!made && !!s.world.tasks[made])
  if (a.kind === 'event') {
    const [head, ...more] = eventLines(a)
    const line = <MarkdownLine text={head ?? ''} noLinks ids={ids} />
    return (
      <li className={`fx-ticket-event${cls}`} data-activity={a.id}>
        <span>
          {madeThere && opens.task ? <button type="button" className="fx-ticket-event-open fx-hit" onClick={() => opens.task!(made)}>{line}</button> : line}
          {more.map((m, i) => <span key={i} className="fx-ticket-event-more"><MarkdownLine text={m} noLinks ids={ids} /></span>)}
        </span>
        {a.subId && <StepTag task={task} a={a} open={open} onStep={onStep} />}
        <time>{fmtClock(a.at)}</time>
      </li>
    )
  }
  if (a.from === 'user') {
    return (
      <li className={`fx-chat-msg fx-chat-user${cls}`} data-activity={a.id}>
        <div className="fx-chat-said">
          <Attachments a={a} onImage={onImage} />
          {a.text && <div className="fx-chat-bubble"><span className="fx-sr">{tr('你：')}</span><Markdown text={a.text} signs="#" /></div>}
          {asked.length > 0 && <SentTo people={asked} className="fx-chat-to" />}
          <div className="fx-chat-foot"><time>{fmtClock(a.at)}</time>{a.text && <CopyButton text={a.text} />}{tag}<OpWord op={op} /></div>
        </div>
      </li>
    )
  }
  const waiting = a.kind === 'question' && !!a.questionId && task.coordination?.questions.some((q) => q.id === a.questionId && q.audience === 'user')
  return (
    <li className={`fx-chat-msg fx-chat-agent fx-ticket-${a.kind}${cls}`} data-activity={a.id}>
      <Face a={a} />
      <div className="fx-chat-said fx-chat-said-agent">
        <div className="fx-chat-bubble">
          <span className="fx-chat-name">
            {a.name ?? tr('員工')}
            {said && meeting && a.by === meeting.chairId && <span className="fx-pill fx-chair">{tr('主持人')}</span>}
            {a.kind === 'handoff' && <> · {tr('交付')}</>}
            {a.meetingPart === 'summary' && <> · {tr('結論')}</>}
            {waiting && <> · <b className="fx-ticket-waiting">{tr('待你回答')}</b></>}
          </span>
          <span className="fx-sr">{colon()}</span>
          <Markdown text={a.text} ids={ids} />
        </div>
        <Attachments a={a} onImage={onImage} />
        <div className="fx-chat-foot">
          <time>{fmtClock(a.at)}</time>
          {a.text && <CopyButton text={a.text} />}
          {tag ?? <StepTag task={task} a={a} open={open} onStep={onStep} />}
        </div>
      </div>
    </li>
  )
}

/** A meeting's words as one line in the conversation, opened to read them. */
function MeetingRow({ task, lines, open, onStep, expanded, onExpand, flash }: {
  task: Task; lines: TaskActivity[]; open: string | null; onStep: (subId: string) => void; expanded: boolean; onExpand: () => void; flash?: string
}) {
  const head = lines[0]
  const people = [...new Map(lines.map((l) => [l.by ?? l.name ?? '', l])).values()]
  return (
    <li className="fx-ticket-meeting" data-activity={head.id} data-meeting={head.meetingId}>
      <button type="button" className="fx-ticket-fold fx-hit" aria-expanded={expanded} onClick={onExpand}>
        <span className="fx-ticket-faces" aria-hidden="true">{people.slice(0, 4).map((p, i) => <Face key={i} a={p} size={18} />)}</span>
        <span className="fx-ticket-fold-text">{tr('會議：{step}', { step: stepName(task, head.nodeId) })}</span>
        <span className="fx-d-muted">{tr('{n} 則發言', { n: lines.length })}</span>
        <svg className="fx-room-fold-mark" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>
      </button>
      {expanded && (
        <ol className="fx-ticket-meeting-lines">
          {lines.map((l) => <ActivityRow key={l.id} task={task} a={l} open={open} onStep={onStep} flash={flash === l.id} />)}
        </ol>
      )}
    </li>
  )
}

/** A meeting's words read in pages of their own, newest first loaded; what is asked for is read again from the top on a change. */
export function useMeetingActivity(taskId: string, meetingId: string, on: boolean) {
  const [state, setState] = useState<{ items: TaskActivity[]; version: string; more: boolean; total: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [again, setAgain] = useState(0)
  useEffect(() => {
    if (!on) return
    const abort = new AbortController()
    setBusy(true)
    setError('')
    readMeetingActivity(useStore.getState().world, taskId, meetingId, { limit: 50 }, abort.signal)
      .then((p) => { if (!abort.signal.aborted) setState({ items: p.items, version: p.version, more: p.hasMore, total: p.total }) })
      .catch((e: Error) => { if (!abort.signal.aborted) setError(e.message) })
      .finally(() => { if (!abort.signal.aborted) setBusy(false) })
    return () => abort.abort()
  }, [taskId, meetingId, on, again])
  const back = async () => {
    if (!state || busy) return
    setBusy(true)
    setError('')
    try {
      const p = await readMeetingActivity(useStore.getState().world, taskId, meetingId, { before: state.items[0]?.seq, limit: 50, version: state.version })
      setState({ ...state, items: [...p.items, ...state.items], more: p.hasMore, total: p.total })
    } catch (e) {
      if ((e as ApiError).code === 'conflict') setAgain((n) => n + 1)
      else setError((e as Error).message)
    } finally { setBusy(false) }
  }
  return { items: state?.items ?? [], total: state?.total ?? 0, ready: !!state, more: !!state?.more, busy, error, back, retry: () => setAgain((n) => n + 1) }
}

/** The chair's conclusion of a meeting, as a line, when only the meeting says it. */
export function summaryLine(m: Meeting): TaskActivity | undefined {
  if (!m.summary) return undefined
  const chair = m.participants.find((p) => p.replicaId === m.chairId)
  return {
    id: m.summaryActivityId ?? `${m.id}:summary`, seq: 0, at: m.endedAt ?? m.startedAt, kind: 'meeting', from: 'agent', text: m.summary,
    by: m.chairId, name: chair?.name, look: chair?.look, meetingId: m.id, subId: m.id, meetingVersion: 2, meetingPart: 'summary', planVersion: 0,
  }
}

/** A meeting that is over, as one card: its conclusion in view, all it said read on opening it. */
export function MeetingCard({ task, meeting: m, summary, anchor, open, onStep, onImage, expanded, onExpand, flash }: {
  task: Task; meeting: Meeting; summary?: TaskActivity; anchor: TaskActivity; open: string | null; onStep: (subId: string) => void
  onImage?: (key: string, im: Attachment) => void; expanded: boolean; onExpand: () => void; flash?: string
}) {
  const words = useMeetingActivity(task.id, m.id, expanded)
  const conclusion = summary ?? summaryLine(m)
  const id = `fx-meeting-${m.id}`
  const said = words.items.filter((a) => a.meetingPart !== 'summary' && a.id !== m.summaryActivityId)
  return (
    <li className="fx-ticket-meeting" data-activity={anchor.id} data-meeting={m.id}>
      <button type="button" className="fx-ticket-fold fx-hit" aria-expanded={expanded} aria-controls={id} onClick={onExpand}>
        <span className="fx-ticket-faces" aria-hidden="true">{m.participants.slice(0, 4).map((p) => <PixelFace key={p.replicaId} look={p.look} name={p.name} size={18} />)}</span>
        <span className="fx-ticket-fold-text">{tr('會議：{step}', { step: m.topic })}</span>
        {words.ready && <span className="fx-d-muted">{tr('{n} 則發言', { n: Math.max(0, words.total - (m.summaryActivityId || m.summary ? 1 : 0)) })}</span>}
        <svg className="fx-room-fold-mark" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>
      </button>
      {expanded && (
        <ol id={id} className="fx-ticket-meeting-lines">
          {words.more && <li className="fx-room-earlier"><button type="button" className="fx-hit" disabled={words.busy} onClick={() => void words.back()}>{tr('顯示更早發言')}</button></li>}
          {words.busy && !words.ready && <li className="fx-d-muted" role="status">{tr('載入中…')}</li>}
          {words.error && <li className="fx-ticket-notice" role="alert"><p>{tr('讀取對話失敗')}{colon()}{words.error}</p><button type="button" className="fx-chat-act fx-hit" onClick={words.retry}>{tr('重試')}</button></li>}
          {words.ready && !said.length && <li className="fx-d-muted">{tr('沒有發言')}</li>}
          {said.map((l) => <ActivityRow key={l.id} task={task} a={l} meeting={m} open={open} onStep={onStep} onImage={onImage} flash={flash === l.id} />)}
        </ol>
      )}
      {conclusion
        ? <ol className="fx-ticket-meeting-end"><ActivityRow task={task} a={conclusion} meeting={m} open={open} onStep={onStep} onImage={onImage} flash={flash === conclusion.id} /></ol>
        : m.state === 'cancelled' && <p className="fx-d-muted fx-ticket-meeting-none">{tr('會議已取消，沒有結論')}</p>}
    </li>
  )
}

/** Something the user wrote that the backend has not confirmed, or refused. */
export interface Unsent {
  requestId: string
  text: string
  attachments: Attachment[]
  state: 'sending' | 'sent' | 'failed'
  error?: string
  activityId?: string
  /** The meeting it was written into, and who it asked to answer; kept when sent again. */
  meetingId?: string
  mentions?: string[]
}

/** The conversation, oldest first: a meeting's words gathered into one line. */
export function Feed({ task, items, unsent, open, onStep, onImage, expanded, onExpand, flash, ops, onResend, onEdit }: {
  task: Task
  items: TaskActivity[]
  unsent: Unsent[]
  open: string | null
  onStep: (subId: string) => void
  onImage?: (key: string, im: Attachment) => void
  expanded: string[]
  onExpand: (meetingId: string) => void
  flash?: string
  /** Operations looked up by id, for what the user sent. */
  ops: (id: string | undefined) => TaskOperation | undefined
  onResend: (u: Unsent) => void
  onEdit: (u: Unsent) => void
}) {
  const subs = useStore((s) => s.world.subTasks)
  const rows: React.ReactNode[] = []
  for (const row of feedRows(items, (id) => (subs[id]?.taskId === task.id ? subs[id].meeting : undefined))) {
    if (row.kind === 'legacy') {
      const head = row.lines[0]
      rows.push(<MeetingRow key={head.id} task={task} lines={row.lines} open={open} onStep={onStep} flash={flash}
        expanded={expanded.includes(head.meetingId!)} onExpand={() => onExpand(head.meetingId!)} />)
    } else if (row.kind === 'card') {
      rows.push(<MeetingCard key={`meeting:${row.meeting.id}`} task={task} meeting={row.meeting} summary={row.summary} anchor={row.anchor} open={open} onStep={onStep}
        onImage={onImage} flash={flash} expanded={expanded.includes(row.meeting.id)} onExpand={() => onExpand(row.meeting.id)} />)
    } else {
      const a = row.a
      rows.push(<ActivityRow key={a.id} task={task} a={a} meeting={row.meeting} open={open} onStep={onStep} onImage={onImage} flash={flash === a.id} op={ops(a.operationId)} />)
    }
  }
  const shown = new Set(items.map((a) => a.id))
  for (const u of unsent) {
    if (u.activityId && shown.has(u.activityId)) continue
    rows.push(
      <li key={u.requestId} className={`fx-chat-msg fx-chat-user fx-ticket-unsent${u.meetingId ? ' fx-ticket-meet' : ''}`}>
        <div className="fx-chat-said">
          {u.attachments.length > 0 && <div className="fx-chat-images">{u.attachments.map((f, j) => <FileAttachment key={j} file={f} />)}</div>}
          {u.text && <div className="fx-chat-bubble"><span className="fx-sr">{tr('你：')}</span><Markdown text={u.text} signs="#" /></div>}
          <div className="fx-chat-foot">
            {u.state === 'failed'
              ? <>
                  <span className="fx-ticket-op fx-ticket-op-failed" role="alert">{tr('傳送失敗')}{u.error && `${colon()}${u.error}`}</span>
                  <button type="button" className="fx-chat-act fx-hit" onClick={() => onResend(u)}>{tr('重試')}</button>
                  <button type="button" className="fx-chat-act fx-hit" onClick={() => onEdit(u)}>{tr('編輯')}</button>
                </>
              : <span className="fx-ticket-op">{OP_WORDS()[u.state === 'sending' ? 'sending' : 'received']}</span>}
            {u.meetingId && <span className="fx-ticket-tag fx-ticket-meet-tag">{tr('會議')}</span>}
          </div>
        </div>
      </li>,
    )
  }
  return <>{rows}</>
}

/** The steps' runs as a line of tags, each opening its run; the plan at the end. */
export function StepStrip({ task, subs, open, onOpen, flowOpen, onFlow, replicas }: {
  task: Task
  subs: SubTask[]
  open: string | null
  onOpen: (subId: string) => void
  flowOpen: boolean
  onFlow: () => void
  replicas: World['replicas']
}) {
  const runs = subs.filter((s) => !s.cancelled || s.status === 'complete').sort((a, b) => a.createdAt - b.createdAt)
  return (
    <nav className="fx-ticket-steps" aria-label={tr('步驟')}>
      <ol>
        {runs.map((s) => {
          const r = s.replicaId ? replicas[s.replicaId] : undefined
          const old = s.validity === 'superseded'
          return (
            <li key={s.id}>
              <button type="button" className={`fx-ticket-step fx-hit${old ? ' fx-ticket-step-old' : ''}${s.executionState === 'uncertain' ? ' fx-ticket-step-alert' : ''}`}
                aria-expanded={open === s.id} onClick={() => onOpen(s.id)} title={r ? `${r.name} · ${r.model}` : undefined}>
                {r ? <PixelFace look={r.look} name={r.name} size={18} /> : <span className="fx-d-noface" />}
                <span className="fx-ticket-step-name">{stepName(task, s.nodeId)}</span>
                <span className="fx-ticket-step-state">{runWord(s)}</span>
              </button>
            </li>
          )
        })}
        <li>
          <button type="button" className="fx-ticket-step fx-ticket-plan fx-hit" aria-expanded={flowOpen} onClick={onFlow}>
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2 4h4v3H2zM10 9h4v3h-4zM6 5.5h2v5h2" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>
            {tr('計畫')}
            {(task.coordination?.planVersion ?? 1) > 1 && <span className="fx-ticket-step-state">v{task.coordination!.planVersion}</span>}
          </button>
        </li>
      </ol>
    </nav>
  )
}

/** What the task asks, folded to a few lines when long, and what came with it. */
function TicketBody({ task, image, onImage }: { task: Task; image: string | null; onImage: (key: string, im: Attachment) => void }) {
  const [whole, setWhole] = useState(false)
  const long = task.description.length > 240 || task.description.split('\n').length > 5
  const id = `fx-ticket-body-${task.id}`
  if (!task.description && !task.images.length && !task.files?.length) return null
  return (
    <li className="fx-ticket-body">
      {task.description && (
        <div id={id} className={`fx-doc-note${long && !whole ? ' fx-ticket-folded' : ''}`}><Markdown text={task.description} /></div>
      )}
      {long && (
        <button type="button" className="fx-chat-act fx-hit" aria-expanded={whole} aria-controls={id} onClick={() => setWhole(!whole)}>
          {whole ? tr('收起') : tr('顯示全部')}
        </button>
      )}
      {(task.images.length > 0 || !!task.files?.length) && (
        <div className="fx-thumbs">
          {task.images.map((im, i) => (
            <button key={i} type="button" className="fx-thumb fx-hit" aria-expanded={image === `task:${task.id}:${i}`} onClick={() => onImage(`task:${task.id}:${i}`, im)}>
              <img src={shownUrl(im.url)} alt={im.name} />
            </button>
          ))}
          {task.files?.map((file, i) => <FileAttachment key={i} file={file} />)}
        </div>
      )}
    </li>
  )
}

/** One question waiting on the user: its choices, an optional note, and back to where it was asked. */
export function QuestionCard({ task, q, onJump, onAnswer, state }: {
  task: Task
  q: TaskQuestion
  onJump: (activityId: string) => void
  onAnswer: (optionId: string, note: string) => void
  state?: { sending: boolean; error?: string }
}) {
  const [choice, setChoice] = useState('')
  const [note, setNote] = useState('')
  const owner = useStore((s) => (task.ownerId ? s.world.replicas[task.ownerId] : undefined))
  const replicas = useStore((s) => s.world.replicas)
  const ids = useCrewIds(task)
  return (
    <form className="fx-ticket-ask" aria-label={idsAsNames(q.prompt, ids, replicas)} onSubmit={(e) => { e.preventDefault(); if (choice) onAnswer(choice, note) }}>
      <div className="fx-ticket-ask-head">
        {owner && <PixelFace look={owner.look} name={owner.name} size={18} />}
        <div className="fx-d-text-md"><Markdown text={q.prompt} ids={ids} /></div>
        <button type="button" className="fx-chat-act fx-hit" onClick={() => onJump(q.activityId)}>{tr('原訊息')}</button>
      </div>
      {q.change && <ChangeLines change={q.change} />}
      {!!q.replicaIds?.length && (
        <ul className="fx-ticket-ask-crew" aria-label={tr('員工')}>
          {q.replicaIds.map((id) => <li key={id}><SaidChip part={{ text: id, kind: 'crew', id }} /></li>)}
        </ul>
      )}
      {q.options.length > 0 && (
        <div className="fx-d-choices" role="group" aria-label={tr('選項')}>
          {q.options.map((o) => (
            <button key={o.id} type="button" className="fx-choice" aria-pressed={choice === o.id} title={o.detail || undefined}
              onClick={() => setChoice(choice === o.id ? '' : o.id)}>
              {o.label ?? trRecorded(`option.${o.id}`)}
            </button>
          ))}
        </div>
      )}
      <div className="fx-ticket-ask-say">
        <input className="fx-control" value={note} autoComplete="off" aria-label={tr('補充說明')} placeholder={tr('補充說明')} onChange={(e) => setNote(e.target.value)} />
        <button type="submit" className="fx-save" disabled={!choice || state?.sending}>{state?.sending ? tr('傳送中…') : tr('確認')}</button>
      </div>
      {state?.error && <p className="fx-room-warn" role="alert">{state.error}</p>}
    </form>
  )
}

/** Every question waiting on the user, kept in view above the box; each answered on its own. */
function Questions({ task, onJump }: { task: Task; onJump: (activityId: string) => void }) {
  const act = useStore((s) => s.act)
  const qs = userQuestions(task)
  const [folded, setFolded] = useState(false)
  const [states, setStates] = useState<Record<string, { key: string; requestId: string; sending: boolean; error?: string; stale?: boolean }>>({})
  if (!qs.length) return null
  const answer = async (q: TaskQuestion, optionId: string, note: string) => {
    const body = { action: 'answer' as const, questionId: q.id, optionId, ...(note.trim() ? { note: note.trim() } : {}), ...seenVersions(task) }
    const key = JSON.stringify(body)
    const was = states[q.id]
    const requestId = was && was.key === key && was.error && !was.stale ? was.requestId : newRequestId()
    setStates((s) => ({ ...s, [q.id]: { key, requestId, sending: true } }))
    try {
      await controlTask(act, task.id, { requestId, ...body })
      setStates((s) => ({ ...s, [q.id]: { key, requestId, sending: false } }))
    } catch (e) {
      const { message, code } = errorOf(e)
      setStates((s) => ({ ...s, [q.id]: { key, requestId, sending: false, error: message, stale: code === 'conflict' } }))
    }
  }
  return (
    <section className="fx-ticket-asks" aria-label={tr('待你回答')}>
      <button type="button" className="fx-room-to fx-room-fold" aria-expanded={!folded} onClick={() => setFolded(!folded)}>
        <b className="fx-ticket-waiting">{tr('待你回答')}</b>
        <span className="fx-ticket-count">{qs.length}</span>
        <svg className="fx-room-fold-mark" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>
      </button>
      {!folded && (
        <div className="fx-ticket-ask-list">
          {qs.map((q) => <QuestionCard key={q.id} task={task} q={q} onJump={onJump} state={states[q.id]} onAnswer={(o, n) => void answer(q, o, n)} />)}
        </div>
      )}
    </section>
  )
}

/** The meeting under way, kept in view above the box: its topic, who is in it, where it stands and what the user can do. */
export function MeetingBar({ task, meeting: m }: { task: Task; meeting: Meeting }) {
  const act = useStore((s) => s.act)
  const tracked = useTracked()
  const op = useOperation(task, tracked.sent?.operationId)
  const word = meetingWord(m)
  const actions = meetingActions(m)
  const LABELS = { continue: m.pauseReason === 'limit' ? tr('繼續下一輪') : tr('繼續'), end: tr('結束開會'), retrySummary: tr('重試結論') }
  const sending = tracked.sent?.state === 'sending'
  const go = (action: 'continue' | 'end' | 'retrySummary') => {
    const body = { action, revision: m.revision }
    void tracked.send(`${m.id} ${JSON.stringify(body)}`, (requestId) => controlMeeting(act, task.id, m.id, { requestId, ...body }))
  }
  const failed = tracked.sent?.state === 'failed' ? tracked.sent.error : op?.status === 'failed' ? op.error?.message : undefined
  const problem = failed ?? (m.state !== 'open' ? m.error?.message : undefined)
  return (
    <section className="fx-ticket-meet-bar" aria-label={tr('會議')}>
      <span className="fx-ticket-meet-tag">{tr('會議')}</span>
      <b className="fx-ticket-meet-topic">{m.topic}</b>
      <span className="fx-ticket-faces" role="img" aria-label={listOf(m.participants.map((p) => p.name))}>
        {m.participants.map((p) => <span key={p.replicaId} title={p.replicaId === m.chairId ? `${p.name} · ${tr('主持人')}` : p.name}><PixelFace look={p.look} name={p.name} size={20} /></span>)}
      </span>
      {word && <span className={m.state === 'summaryFailed' || m.closingRequested && m.state === 'paused' ? 'fx-ticket-meet-state fx-room-warn' : 'fx-ticket-meet-state'} role="status">{tr(word)}</span>}
      <span className="fx-ticket-meet-acts">
        {actions.map((a) => (
          <button key={a} type="button" className={a === 'end' ? 'fx-chat-act fx-hit' : 'fx-save'} disabled={sending} onClick={() => go(a)}>
            {sending && tracked.sent?.key.includes(`"${a}"`) ? tr('傳送中…') : LABELS[a]}
          </button>
        ))}
      </span>
      {problem && <p className="fx-room-warn fx-ticket-meet-error" role="alert">{problem}</p>}
    </section>
  )
}

/** A notice above the box: the owner stopped, a run nobody can vouch for, or the task waiting to be merged. */
function Notices({ task, subs, onStep }: { task: Task; subs: SubTask[]; onStep: (subId: string) => void }) {
  const act = useStore((s) => s.act)
  const retry = useTracked()
  const c = task.coordination!
  const failed = c.operations.filter((o) => o.status === 'failed' && o.kind !== 'message').at(-1)
  const lost = uncertain(subs)
  const replicas = useStore((s) => s.world.replicas)
  const ids = useCrewIds(task)
  const out: React.ReactNode[] = []
  if (c.ownerState === 'blocked' || c.ownerState === 'failed') {
    out.push(
      <div key="owner" className="fx-ticket-notice" role="alert">
        <p>{tr('負責人停下來了')}{c.blockedReason && <>{colon()}{idsAsNames(c.blockedReason, ids, replicas)}</>}</p>
        {c.ownerState === 'failed' && failed && (
          <button type="button" className="fx-chat-act fx-hit" disabled={retry.sent?.state === 'sending'}
            onClick={() => { const body = { action: 'retry' as const, operationId: failed.id, ...seenVersions(task) }; void retry.send(JSON.stringify(body), (requestId) => controlTask(act, task.id, { requestId, ...body })) }}>
            {tr('重試')}
          </button>
        )}
        {retry.sent?.state === 'failed' && <p className="fx-room-warn">{retry.sent.error}</p>}
      </div>,
    )
  }
  for (const s of lost) {
    out.push(
      <div key={s.id} className="fx-ticket-notice" role="alert">
        <p>{tr('無法確認「{step}」是否已停止，請先確認', { step: stepName(task, s.nodeId) })}</p>
        <button type="button" className="fx-chat-act fx-hit" onClick={() => onStep(s.id)}>{tr('查看')}</button>
      </div>,
    )
  }
  if (task.stage === 'awaitMerge') {
    const blocked = mergeBlocked(task, subs)
    out.push(
      <div key="merge" className="fx-ticket-notice fx-ticket-merge">
        <p>{blocked ? tr('還有待處理的事，處理完才能合併') : tr('負責人回報完成，等你合併')}</p>
        <button type="button" className="fx-save fx-danger" disabled={blocked} onClick={() => act((x) => mergeTask(x, task.id))}>{tr('合併')}</button>
      </div>,
    )
  }
  return out.length ? <div className="fx-ticket-notices">{out}</div> : null
}

/** Someone "@" offers in a meeting, as every pick of employees shows them; All, everyone in it. */
function MeetingPersonRow({ meeting: m, id }: { meeting: Meeting; id: string }) {
  const r = useStore((s) => s.world.replicas[id])
  if (id === ALL.id) {
    const people = m.participants.map((p) => ({ id: p.replicaId, name: p.name, look: p.look }))
    return (
      <>
        <ChatFaces people={people} size={26} />
        <span className="fx-row-main">
          <b className="fx-crew-head"><span className="fx-crew-name">{ALL.name}</span></b>
          <span>{listOf(people.map((x) => x.name))}</span>
        </span>
      </>
    )
  }
  const p = m.participants.find((x) => x.replicaId === id)
  if (r) return <CrewRow r={r} on chair={id === m.chairId} mind={p ? [p.model, p.effort].filter(Boolean).join(' · ') : undefined} />
  // one who has left since, as they were when it opened
  return p ? <><span className="fx-pick-picture" aria-hidden="true"><PixelFace look={p.look} name={p.name} size={26} /></span><span className="fx-row-main"><b className="fx-crew-head"><span className="fx-crew-name">{p.name}</span>{id === m.chairId && <span className="fx-pill fx-chair">{tr('主持人')}</span>}</b><span>{p.model}</span></span></> : null
}

/** A task its owner runs, on its sheet. */
export function OwnerTaskDetail({ id, open, onOpen, flowOpen, onFlow, editing, onEdit, copying, onCopy, onGoneTask, crew, onCrew, onFact, onTask, image, onImage, ...h }: Head & {
  id: string
  image: string | null
  onImage: (key: string, image: Attachment) => void
  crew: string | null
  onCrew: (id: string) => void
  /** Opens a record the owner names by id. */
  onFact: (id: string) => void
  /** Opens a task the owner made. */
  onTask: (id: string) => void
  open: string | null
  onOpen: (subId: string) => void
  flowOpen: boolean
  onFlow: () => void
  editing: boolean
  onEdit: () => void
  copying: boolean
  onCopy: () => void
  onGoneTask: () => void
}) {
  const w = useStore((s) => s.world)
  const act = useStore((s) => s.act)
  const now = useNow()
  const task = w.tasks[id]
  const history = useTaskActivity(task)
  const control = useTracked()
  const controlOp = useOperation(task, control.sent?.operationId)
  const [unsent, setUnsent] = useState<Unsent[]>([])
  const [text, setText] = useState('')
  const [files, setFiles] = useState<Attachment[]>([])
  const [reading, setReading] = useState(false)
  const [refused, setRefused] = useState('')
  const [expanded, setExpanded] = useState<string[]>([])
  const [flash, setFlash] = useState('')
  const [lost, setLost] = useState('')
  // where the draft in the box was written to: a meeting's id, '' for the owner, null with nothing written
  const [draftFor, setDraftFor] = useState<string | null>(null)
  const box = useRef<HTMLTextAreaElement>(null)
  const ownerId = task?.ownerId ?? null
  const live = useLiveText(`owner:${id}`)
  const meeting = activeMeeting(task?.coordination?.activeMeetingId, (x) => (w.subTasks[x]?.taskId === id ? w.subTasks[x] : undefined))
  const speaking = meeting && (meeting.state === 'open' || meeting.state === 'closing') ? meeting.participants.find((p) => p.replicaId === meeting.speakerId) : undefined
  const meetingLive = useLiveText(meeting?.id)
  const responding = task?.coordination?.ownerState === 'responding' || task?.coordination?.ownerState === 'queued'
  const [list, pin] = useStickToBottom<HTMLOListElement>(`${history.items.length}:${unsent.length}:${responding}:${live.length}:${speaking?.replicaId}:${meetingLive.length}`)
  // a message the backend took in goes once its line is in the conversation
  const shown = history.items.map((a) => a.id).join(' ')
  useEffect(() => {
    setUnsent((u) => u.filter((x) => !(x.activityId && shown.includes(x.activityId))))
  }, [shown])
  // a line asked for comes into view once it is in, and is marked a moment
  useEffect(() => {
    if (!flash) return
    const el = list.current?.querySelector<HTMLElement>(`[data-activity="${CSS.escape(flash)}"]`)
    if (!el) return
    el.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
    const t = window.setTimeout(() => setFlash(''), 1600)
    return () => window.clearTimeout(t)
  }, [flash, history.items, expanded])
  if (!task) return <Gone {...h} />
  const subs = subsOf(w, task.id)
  const owner = ownerId ? w.replicas[ownerId] : undefined
  const status = statusOf(w, task)
  const ended = task.stage === 'done' || task.stage === 'cancelled' || task.stage === 'merging'
  const canSay = !ended && !!owner
  const started = !notStarted(task)
  const block = resumeBlock(task, subs)
  const BLOCKS = { owner: tr('先選任務負責人'), stopping: tr('正在停止執行中的步驟…'), uncertain: tr('有步驟無法確認是否已停止'), question: tr('先回答待決的問題') }

  const deliver = async (u: Unsent) => {
    setUnsent((all) => all.map((x) => (x.requestId === u.requestId ? { ...x, state: 'sending', error: undefined } : x)))
    try {
      const r = await sayToOwner(act, task.id, {
        requestId: u.requestId, text: u.text, ...splitAttachments(u.attachments),
        ...(u.meetingId ? { meetingId: u.meetingId, ...(u.mentions?.length ? { mentions: u.mentions } : {}) } : {}),
      })
      setUnsent((all) => all.map((x) => (x.requestId === u.requestId ? { ...x, state: 'sent', activityId: r.activity.id } : x)))
    } catch (e) {
      setUnsent((all) => all.map((x) => (x.requestId === u.requestId ? { ...x, state: 'failed', error: (e as Error).message } : x)))
    }
  }
  const to = meeting?.id ?? ''
  // a meeting that is ending takes no more words; what is in the box stays
  const closed = !!meeting && !meetingTakesWords(meeting)
  const write = (next: string) => {
    if (!text && !files.length && next) setDraftFor(to)
    setText(next)
  }
  const send = () => {
    const words = text.trim()
    if ((!words && !files.length) || !canSay || reading || closed) return
    // written for a meeting that has ended, or for the owner before one opened: said, and sent only when asked again
    if (!draftStillGoes(draftFor ?? to, to)) {
      setDraftFor(to)
      setRefused(to ? tr('現在正在開會，訊息沒有送出') : tr('這場會議已結束，訊息沒有送出'))
      return
    }
    const mentions = meeting ? meetingMentions(words, meeting) : []
    const u: Unsent = { requestId: newRequestId(), text: words, attachments: files, state: 'sending', ...(meeting ? { meetingId: meeting.id, mentions } : {}) }
    setUnsent((all) => [...all, u])
    setText('')
    setFiles([])
    setDraftFor(null)
    setRefused('')
    pin()
    void deliver(u)
  }
  // back to the box as it was; sent again, it is a new message
  const edit = (u: Unsent) => {
    setUnsent((all) => all.filter((x) => x.requestId !== u.requestId))
    setText((now) => [now.trim(), u.text].filter(Boolean).join('\n'))
    setFiles((now) => [...now, ...u.attachments].slice(0, MAX_ATTACHMENTS))
    // it goes where the box now sends, as the box shows
    setDraftFor(to)
    box.current?.focus()
  }
  const attach = async (picked: File[]) => {
    if (reading) return
    const { fit, refused: over } = attachable(picked, MAX_ATTACHMENTS - files.length)
    setRefused(over ? tr('附件每個最大 25MB，最多 6 個') : '')
    setReading(true)
    try {
      const { added, refused: tooLarge } = await readAttachments(fit)
      if (tooLarge) setRefused(tr('附件每個最大 25MB，最多 6 個'))
      if (!text && !files.length && added.length) setDraftFor(to)
      setFiles((now) => [...now, ...added].slice(0, MAX_ATTACHMENTS))
    } catch { setRefused(tr('讀取附件失敗，請重試')) }
    finally { setReading(false) }
  }
  const pauseOrGo = () => {
    if (!task.paused) return void control.send('pause', (requestId) => controlTask(act, task.id, { requestId, action: 'pause' }))
    const body: Omit<Extract<OwnerControl, { action: 'resume' }>, 'requestId'> = { action: 'resume', ...seenVersions(task) }
    void control.send(JSON.stringify(body), (requestId) => controlTask(act, task.id, { requestId, ...body }))
  }
  // back to where a question was asked: earlier pages are read until it is in, and a meeting it is in is opened
  const jump = async (activityId: string) => {
    setLost('')
    let a = history.items.find((x) => x.id === activityId)
    if (!a) {
      try {
        a = await readTaskActivityItem(useStore.getState().world, task.id, activityId)
      } catch (e) { setLost((e as Error).message); return }
      if (!(await history.back(a.seq))) { setLost(tr('讀取對話失敗')); return }
    }
    if (a.meetingId) setExpanded((x) => (x.includes(a.meetingId!) ? x : [...x, a.meetingId!]))
    setFlash(activityId)
  }
  const going = !task.paused && task.stage === 'running'
  const toolLabel = !started ? tr('開始') : going ? tr('暫停') : tr('繼續')
  const toolOff = control.sent?.state === 'sending' || ended || task.stage !== 'running' || (!going && !!block)
  // what the last pause, start or resume came to; one that took effect says so a moment
  const said = control.sent && (control.sent.state === 'failed'
    ? { alert: true, text: control.sent.error ?? tr('失敗') }
    : control.sent.state === 'sending' ? { text: tr('傳送中…') }
    : controlOp && (controlOp.status !== 'applied' || now - controlOp.updatedAt < SAID_FOR)
      ? { alert: controlOp.status === 'failed' || controlOp.status === 'uncertain', text: controlOp.status === 'applied'
        ? (controlOp.kind === 'pause' ? tr('已暫停') : tr('已繼續'))
        : controlOp.status === 'processing' && controlOp.kind === 'pause' ? tr('正在停止執行中的步驟…')
        : controlOp.error?.message ?? OP_WORDS()[controlOp.status] }
      : null)
  return (
    <SaidContext.Provider value={{ person: onCrew, canPerson: (x) => !!w.replicas[x], fact: onFact, task: onTask }}>
    <div className="fx-room fx-ticket">
      <div className="fx-tools">
        <EditTool onClick={onEdit} open={editing} />
        <button type="button" className="fx-tool fx-hit" onClick={onCopy} aria-expanded={copying} aria-label={tr('複製')} title={tr('複製')}>
          <CopyIcon />
        </button>
        <button type="button" className="fx-tool fx-hit" disabled={toolOff} aria-pressed={!going && started}
          onClick={pauseOrGo} aria-label={toolLabel} title={!going && block ? BLOCKS[block] : toolLabel}>
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            {going ? <path d="M5 3v10M11 3v10" stroke="currentColor" strokeWidth="2" /> : <path d="M5 3l8 5-8 5z" fill="currentColor" />}
          </svg>
        </button>
        <DeleteTool what={tr('任務')} onConfirm={() => { onGoneTask(); act((x) => deleteTask(x, id)) }} />
      </div>
      <header className="fx-d-head fx-ticket-head">
        <Heading {...h}><span className="fx-task-no">#{task.number}</span>{task.title}</Heading>
        <p className="fx-d-meta">
          <span className="fx-pill">{task.stage === 'cancelled' ? tr('已停止') : task.paused && started ? tr('已暫停') : task.stage === 'merging' ? tr('合併中') : tr(STATUS[status])}</span>
          {owner ? (
            <span className="fx-d-owner">{tr('負責人')}
              <button type="button" className="fx-hit" aria-expanded={crew === owner.id} onClick={() => onCrew(owner.id)}>
                <PixelFace look={owner.look} name={owner.name} size={18} />{owner.name}
              </button>
              <span className="fx-pill fx-chair">{tr('主持人')}</span>
            </span>
          ) : <button type="button" className="fx-chat-act fx-hit fx-ticket-noowner" onClick={onEdit}>{tr('先選任務負責人')}</button>}
          {taskTokens(w, task) > 0 && <span className="fx-ticket-cost">{fmtTokens(taskTokens(w, task))} Token · ${taskCost(w, task).toFixed(2)}</span>}
          <span className="fx-branch" title={tr('任務分支')}><BranchIcon /><span className="fx-sr">{tr('任務分支 ')}</span><code>{task.branch}</code></span>
        </p>
      </header>
      <StepStrip task={task} subs={subs} open={open} onOpen={onOpen} flowOpen={flowOpen} onFlow={onFlow} replicas={w.replicas} />
      <div className="fx-room-scroll">
        <ol ref={list} className="fx-room-log fx-ticket-log" aria-live="polite" aria-label={tr('和 {name} 的對話', { name: owner?.name ?? tr('負責人') })}>
          <TicketBody task={task} image={image} onImage={onImage} />
          {history.earlier && history.ready && (
            <li className="fx-room-earlier"><button type="button" className="fx-hit" disabled={history.busy} onClick={() => void history.back()}>{tr('顯示更早訊息')}</button></li>
          )}
          <HistoryState busy={history.busy} ready={history.ready} error={history.error} onRetry={history.retry} />
          {history.ready && !history.items.length && !unsent.length && (
            <li className="fx-ticket-empty">
              {started ? <p className="fx-d-muted">{tr('還沒有對話')}</p> : (
                <button type="button" className="fx-save" disabled={toolOff} title={block ? BLOCKS[block] : undefined} onClick={pauseOrGo}>{tr('開始')}</button>
              )}
            </li>
          )}
          <Feed task={task} items={history.items} unsent={unsent} open={open} onStep={onOpen} onImage={(key, im) => onImage(key, im)}
            expanded={expanded} onExpand={(m) => setExpanded((x) => (x.includes(m) ? x.filter((y) => y !== m) : [...x, m]))}
            flash={flash} ops={(opId) => operationOf(task, opId)} onResend={(u) => void deliver(u)} onEdit={edit} />
          {responding && owner && (
            <li className="fx-chat-msg fx-chat-agent fx-chat-writing">
              <PixelFace look={owner.look} name={owner.name} size={22} />
              <span className="fx-sr">{tr('{name} 正在處理…', { name: owner.name })}</span>
              {live
                ? <div className="fx-chat-bubble" aria-hidden="true"><Markdown text={live} ids={crewIds(w, task)} /></div>
                : <p className="fx-chat-bubble"><span className="fx-chat-dots" aria-hidden="true"><span /><span /><span /></span></p>}
            </li>
          )}
          {speaking && (
            <li className="fx-chat-msg fx-chat-agent fx-chat-writing fx-ticket-meet">
              <PixelFace look={speaking.look} name={speaking.name} size={22} />
              <span className="fx-sr">{tr('{name} 正在處理…', { name: speaking.name })}</span>
              {meetingLive
                ? <div className="fx-chat-bubble" aria-hidden="true"><Markdown text={meetingLive} ids={crewIds(w, task)} /></div>
                : <p className="fx-chat-bubble"><span className="fx-chat-dots" aria-hidden="true"><span /><span /><span /></span></p>}
            </li>
          )}
        </ol>
      </div>
      {lost && <p className="fx-room-warn" role="alert">{lost}</p>}
      <Notices task={task} subs={subs} onStep={onOpen} />
      {meeting && <MeetingBar task={task} meeting={meeting} />}
      <Questions task={task} onJump={(a) => void jump(a)} />
      {said && <p className={said.alert ? 'fx-ticket-said fx-room-warn' : 'fx-ticket-said'} role={said.alert ? 'alert' : 'status'}>{said.text}</p>}
      {canSay ? (
        <form className="fx-room-say" onSubmit={(e) => { e.preventDefault(); send() }}
          onPaste={(e) => {
            const pasted = [...e.clipboardData.files]
            if (!pasted.length) return
            e.preventDefault()
            void attach(pasted)
          }}>
          {refused && <p className="fx-room-warn fx-room-say-wide" role="alert">{refused}</p>}
          {meeting && (
            <div className="fx-room-say-wide fx-ticket-to">
              <span className="fx-ticket-meet-tag">{tr('會議')}</span>
              <SentTo people={answerers(text, meeting).map((p) => ({ id: p.replicaId, name: p.name, look: p.look }))} live />
            </div>
          )}
          {files.length > 0 && (
            <div className="fx-thumbs fx-room-say-wide">
              {files.map((im, i) => (
                <figure key={i} className={isImage(im) ? 'fx-thumb' : 'fx-file-wrap'}>
                  {isImage(im) ? <img src={shownUrl(im.url)} alt={im.name} /> : <FileAttachment file={im} />}
                  <button type="button" className="fx-thumb-x" aria-label={tr('移除 {name}', { name: im.name })} onClick={() => setFiles((now) => now.filter((_, j) => j !== i))}>×</button>
                </figure>
              ))}
            </div>
          )}
          <label className="fx-room-attach fx-hit" title={tr('加入附件')}>
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
              <path d="M13 7.5 8 12.5a3 3 0 0 1-4.3-4.2l5.4-5.4a2 2 0 0 1 2.9 2.8l-5.4 5.4a1 1 0 0 1-1.4-1.4L10 5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <input type="file" disabled={reading} multiple className="fx-sr" aria-label={tr('加入附件')}
              onChange={(e) => { void attach([...(e.target.files ?? [])]); e.target.value = '' }} />
          </label>
          <MentionBox box={box} grow value={text} teamId={task.teamId} label={meeting ? tr('會議發言') : tr('訊息')}
            people={meeting ? meetingPeople(meeting) : []} personRow={meeting ? (pid) => <MeetingPersonRow meeting={meeting} id={pid} /> : undefined}
            placeholder={meeting ? tr('在會議中發言，@ 指定誰回答，# 選檔案') : tr('對 {name} 說，# 選檔案，可直接貼上截圖', { name: owner!.name })} onChange={write} onSend={send} />
          <button type="submit" className="fx-room-send" disabled={(!text.trim() && !files.length) || reading || closed} aria-label={tr('發送')} title={tr('發送')}>
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </button>
        </form>
      ) : <p className="fx-d-muted fx-ticket-closed">{owner ? tr('任務已結束，可以複製成新任務') : tr('先選任務負責人')}</p>}
    </div>
    </SaidContext.Provider>
  )
}

// ---------- on a step's own sheet ----------

/** What the owner told a run, and where the run stands with the owner. */
export function OwnerRunFacts({ task, sub }: { task: Task; sub: SubTask }) {
  const ids = useCrewIds(task)
  if (!isOwnerTask(task)) return null
  const word = runWord(sub)
  return (
    <>
      {sub.instruction && <div className="fx-d-text-md fx-d-quote"><span className="fx-sr">{tr('指示')}{colon()}</span><Markdown text={sub.instruction} ids={ids} /></div>}
      {(sub.validity === 'superseded' || sub.validity === 'needsRevalidation' || sub.executionState === 'uncertain' || sub.executionState === 'stopping' || sub.ownerReview === 'pending') && (
        <p className={sub.executionState === 'uncertain' ? 'fx-room-warn' : 'fx-d-muted'} role={sub.executionState === 'uncertain' ? 'alert' : undefined}>{word}</p>
      )}
    </>
  )
}

/** Sending one run of a task its owner runs back to be redone, with why. It stops the task until the user resumes. */
export function ReturnStep({ task, sub }: { task: Task; sub: SubTask }) {
  const act = useStore((s) => s.act)
  const [asking, setAsking] = useState(false)
  const [reason, setReason] = useState('')
  const tracked = useTracked()
  const op = useOperation(task, tracked.sent?.operationId)
  if (!isOwnerTask(task)) return null
  const can = currentRun(sub) && (task.stage === 'running' || task.stage === 'awaitMerge') && (sub.status !== 'todo' || sub.executionState === 'stopped')
  const go = async () => {
    const body = { action: 'return' as const, subId: sub.id, reason: reason.trim(), ...seenVersions(task) }
    if (await tracked.send(JSON.stringify(body), (requestId) => controlTask(act, task.id, { requestId, ...body }))) {
      setAsking(false)
      setReason('')
    }
  }
  const state = tracked.sent?.state === 'failed' ? null : op?.status === 'applied' ? tr('已退回，按繼續後重做') : op ? OP_WORDS()[op.status] : null
  if (!can && !state && tracked.sent?.state !== 'failed') return null
  return (
    <div className="fx-ticket-return">
      {state && <p className="fx-d-muted" role="status">{state}</p>}
      {tracked.sent?.state === 'failed' && <p className="fx-room-warn" role="alert">{tracked.sent.error}</p>}
      {can && !asking && <div className="fx-d-merge-acts"><button type="button" className="fx-save fx-plain" onClick={() => setAsking(true)}>{tr('退回這一步')}</button></div>}
      {can && asking && (
        <form className="fx-d-merge-back" onSubmit={(e) => { e.preventDefault(); if (reason.trim()) void go() }}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setAsking(false) } }}>
          <textarea className="fx-control" rows={3} autoFocus value={reason} aria-label={tr('退回原因')} placeholder={tr('要改什麼')} onChange={(e) => setReason(e.target.value)} />
          <div className="fx-d-merge-acts">
            <button type="submit" className="fx-save fx-plain" disabled={!reason.trim() || tracked.sent?.state === 'sending'}>{tracked.sent?.state === 'sending' ? tr('傳送中…') : tr('退回')}</button>
            <button type="button" className="fx-add" onClick={() => setAsking(false)}>{tr('取消')}</button>
          </div>
        </form>
      )}
    </div>
  )
}
