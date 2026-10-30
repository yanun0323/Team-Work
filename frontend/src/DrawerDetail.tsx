// The detail sheets: anything in the company file or the settings that can be opened (a task and its sub-tasks,
// a flow and its steps, an employee, a blueprint, importing a blueprint) is shown on a sheet taped over the upper left of the map. Sheets stack: editing an employee
// tapes an edit sheet over theirs, a little lower and to the right, and clicking the strip of the sheet
// below that still shows puts the top one away unsaved. They read the live world.

import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { isFixed, nodeOf, taskNodeOf } from './core/domain/graph'
import { blueprintUsers, gitSources, statusOf, subsOf } from './core/domain/sim'
import { TOOLS, type Effort, type Blueprint, type BlueprintSource, type GitSource, type LocalSkills, type Look, type ProviderKind, type Replica, type Status, type SubTask, type Workflow, type World } from './core/domain/types'
import { sourceState, sourceText, TOOL_NAMES } from './source'
import { useT } from './core/i18n'
import { activity, fmtClock, layers, inEdges, lastSub, logText, outEdges, taskLines, teamReplicas } from './core/model'
import { useStore } from './core/store'
import { PixelFace } from './core/voxel/PixelFace'
import { BlueprintIcon, pinLook } from './BlueprintIcon'
import { seedOf } from './People'
import { Standee } from './Standee'
import { ordered, usePrefs, type LogOrder } from './prefs'
import { Select } from './Controls'
import { FlowNotes, openCard } from './FlowNotes'
import { addImages, draftFlow, draftStaff, editDraft, lastStaff, unstaffed, useDraft, type TaskDraft } from './draft'
import { byBlueprint, EFFORTS, effortName, mindOf, modelsOf, randomLook } from './crew'
import { docOf } from './doc'
import { parseGithub } from './github'
import { parseBlueprintYaml, YAML_TEMPLATE } from './blueprintYaml'
import { authLabel, PROVIDER_KINDS, providerUrl, SUBSCRIPTIONS } from './providers'
import { endTalk, sayInTalk, talking, TALK_PROMPT } from './core/domain/sim'
import type { TalkEnd } from './core/domain/types'
import { addProvider, deleteProvider, providerUsers, updateProvider, type ProviderLogin, createTask, DEFAULT_MODEL, deleteBlueprint, deleteTask, deleteTeam, fire, hire, deleteWorkflow, duplicateWorkflow, newWorkflow, pauseTask, resumeTask, setOwner, mergeTask, returnTask, RESOLVE_TIME, resolveReview, costLimit } from './core/domain/sim'
import { addStep, blankFlow, branchStep, canLink, insertStep, editFlowDraft, endOf, isMiddle, link, loose, nextChoices, putStep, removeStep, unlink, useFlowDraft } from './flowDraft'

export type Item =
  | { kind: 'task'; id: string }
  | { kind: 'sub'; id: string }
  | { kind: 'flow'; id: string }
  | { kind: 'taskFlow'; id: string }
  | { kind: 'crew'; id: string }
  | { kind: 'blueprint'; id: string }
  | { kind: 'crewEdit'; id: string }
  | { kind: 'newCrew' }
  | { kind: 'fire'; id: string }
  | { kind: 'newTask' }
  | { kind: 'staff'; node: string }
  | { kind: 'taskEdit'; id: string }
  | { kind: 'doc'; sub: string; path: string }
  | { kind: 'image'; task: string; index: number }
  | { kind: 'flowEdit'; id: string }
  | { kind: 'newFlow' }
  | { kind: 'newBlueprint' }
  | { kind: 'provider'; id: string }
  | { kind: 'providerEdit'; id: string }
  | { kind: 'newProvider' }
  | { kind: 'blueprintEdit'; id: string }
  | { kind: 'disband' }

export const itemKey = (x: Item) =>
  x.kind === 'newTask' || x.kind === 'newFlow' || x.kind === 'newCrew' || x.kind === 'newBlueprint' || x.kind === 'newProvider' || x.kind === 'disband' ? x.kind : x.kind === 'staff' ? `${x.kind}:${x.node}` : x.kind === 'doc' ? `doc:${x.sub}:${x.path}` : x.kind === 'image' ? `image:${x.task}:${x.index}` : `${x.kind}::${x.id}`

const STATUS: Record<Status, string> = { todo: '待辦', progressing: '進行中', review: '待回覆', complete: '完成' }
const ASSIGN = { firstAvailable: '誰有空誰做', everyone: '每個人都做' } as const
const HANDOFF = { pickOne: '交給其中一個下一步', all: '交給所有下一步' } as const
const JOIN = { any: '任一個前一步完成就開始', all: '所有前一步都完成才開始' } as const
/** What a step in the middle of a flow can be. */
const KINDS = { work: '交給員工執行工作', talk: '和員工討論' } as const
/** The last lines of a log worth showing on a sheet this size. */
const LOG_LINES = 40

export function Detail({ item, teamId, depth, covered, above, leaving, onGone, onBack, onDone, onClear, onPush }: {
  item: Item
  /** The open company; empty when opened from the settings, which belong to no company. */
  teamId: string
  /** How many sheets lie under this one. */
  depth: number
  /** Another sheet lies on top: this one only shows a strip, and a click on it puts the others away. */
  covered: boolean
  /** The sheet lying directly on this one, if any. */
  above?: Item
  leaving: boolean
  onGone: () => void
  /** Put away every sheet above this one. */
  onBack: () => void
  /** Put away this sheet too (an edit, once saved). */
  onDone: () => void
  /** Put away this sheet and the one under it (a hand-over, once the employee is gone). */
  onClear: () => void
  /** Tape another sheet on top. */
  onPush: (x: Item) => void
}) {
  const title = useRef<HTMLHeadingElement>(null)
  // a fresh sheet (it is keyed by item): move focus to its title
  useEffect(() => title.current?.focus({ preventScroll: true }), [])
  const id = `fx-detail-title-${depth}`
  return (
    <aside id={depth === 0 ? 'fx-detail' : undefined} className={`fx-detail${leaving ? ' leaving' : ''}`}
      style={{ '--depth': depth } as CSSProperties} aria-labelledby={id}
      aria-hidden={leaving || undefined} inert={leaving || undefined}
      onAnimationEnd={(e) => { if (leaving && e.target === e.currentTarget) onGone() }}>
      <span className="fx-tape fx-tape-l" aria-hidden="true" />
      <div className="fx-sheet" inert={covered || undefined}>
        <div className="fx-detail-body">
          {item.kind === 'task' && (
            <TaskDetail id={item.id} title={title} tid={id} open={above?.kind === 'sub' ? above.id : null}
              onOpen={(x) => onPush({ kind: 'sub', id: x })} editing={above?.kind === 'taskEdit'}
              flowOpen={above?.kind === 'taskFlow'} onFlow={() => onPush({ kind: 'taskFlow', id: item.id })}
              onEdit={() => onPush({ kind: 'taskEdit', id: item.id })} onGoneTask={onDone}
              crew={above?.kind === 'crew' ? above.id : null} onCrew={(x) => onPush({ kind: 'crew', id: x })}
              image={above?.kind === 'image' ? above.index : null} onImage={(x) => onPush({ kind: 'image', task: item.id, index: x })} />
          )}
          {item.kind === 'image' && <ImageDetail task={item.task} index={item.index} title={title} tid={id} />}
          {item.kind === 'taskFlow' && (
            <TaskFlow taskId={item.id} title={title} tid={id}
              crew={above?.kind === 'crew' ? above.id : null} onCrew={(x) => onPush({ kind: 'crew', id: x })} />
          )}
          {item.kind === 'sub' && (
            <SubDetail id={item.id} title={title} tid={id} open={above?.kind === 'doc' ? above.path : null}
              onOpen={(path) => onPush({ kind: 'doc', sub: item.id, path })}
              crew={above?.kind === 'crew' ? above.id : null} onCrew={(x) => onPush({ kind: 'crew', id: x })} />
          )}
          {item.kind === 'doc' && <DocDetail sub={item.sub} path={item.path} title={title} tid={id} />}
          {item.kind === 'taskEdit' && (
            <TaskEdit id={item.id} teamId={teamId} title={title} tid={id} open={above?.kind === 'staff' ? above.node : null}
              onOpen={(node) => onPush({ kind: 'staff', node })} onDone={onDone} />
          )}
          {item.kind === 'flow' && (
            <FlowDetail id={item.id} teamId={teamId} title={title} tid={id} editing={above?.kind === 'flowEdit'}
              onEdit={() => onPush({ kind: 'flowEdit', id: item.id })} onGoneFlow={onDone} />
          )}
          {(item.kind === 'flowEdit' || item.kind === 'newFlow') && (
            <FlowEdit id={item.kind === 'flowEdit' ? item.id : null} teamId={teamId} title={title} tid={id} onDone={onDone} />
          )}
          {item.kind === 'crew' && (
            <CrewDetail id={item.id} title={title} tid={id} editing={above?.kind === 'crewEdit'} firing={above?.kind === 'fire'}
              onEdit={() => onPush({ kind: 'crewEdit', id: item.id })} onFire={() => onPush({ kind: 'fire', id: item.id })} />
          )}
          {item.kind === 'provider' && (
            <ProviderDetail id={item.id} title={title} tid={id} editing={above?.kind === 'providerEdit'}
              onEdit={() => onPush({ kind: 'providerEdit', id: item.id })} onGoneProvider={onDone} />
          )}
          {(item.kind === 'providerEdit' || item.kind === 'newProvider') && (
            <ProviderEdit id={item.kind === 'providerEdit' ? item.id : null} title={title} tid={id} onDone={onDone} />
          )}
          {item.kind === 'blueprint' && (
            <BlueprintDetail id={item.id} teamId={teamId} title={title} tid={id} editing={above?.kind === 'blueprintEdit'}
              onEdit={() => onPush({ kind: 'blueprintEdit', id: item.id })} onGoneBlueprint={onDone} />
          )}
          {(item.kind === 'blueprintEdit' || item.kind === 'newBlueprint') && (
            <BlueprintEdit id={item.kind === 'blueprintEdit' ? item.id : null} title={title} tid={id} onDone={onDone} />
          )}
          {(item.kind === 'crewEdit' || item.kind === 'newCrew') && (
            <CrewEdit id={item.kind === 'crewEdit' ? item.id : null} teamId={teamId} title={title} tid={id} onDone={onDone} />
          )}
          {item.kind === 'fire' && <Fire id={item.id} title={title} tid={id} onDone={onClear} />}
          {item.kind === 'newTask' && (
            <NewTask teamId={teamId} title={title} tid={id} open={above?.kind === 'staff' ? above.node : null}
              onOpen={(node) => onPush({ kind: 'staff', node })} onDone={onDone} />
          )}
          {item.kind === 'disband' && <Disband teamId={teamId} title={title} tid={id} onDone={onDone} />}
          {item.kind === 'staff' && <StaffPick node={item.node} teamId={teamId} title={title} tid={id} onDone={onDone} />}
        </div>
      </div>
      {covered && !leaving && <button type="button" className="fx-detail-cover" aria-label="收起上面那張，回到這張" onClick={onBack} />}
    </aside>
  )
}

type Title = React.RefObject<HTMLHeadingElement | null>
type Head = { title: Title; tid: string }

function Heading({ title, tid, children }: Head & { children: React.ReactNode }) {
  return <h2 id={tid} ref={title} tabIndex={-1}>{children}</h2>
}

function Gone(h: Head) {
  return <Heading {...h}>已經不在了</Heading>
}

function Section({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <section className="fx-d-sec">
      <h3>{name}</h3>
      {children}
    </section>
  )
}

/** Log lines, given oldest first; shown in the order the preferences ask for. */
type LogLine = { at: number; kind: string; text: string; node?: string; who?: React.ReactNode }

function Log({ lines }: { lines: LogLine[] }) {
  return <LogList lines={lines} order={usePrefs((s) => s.logOrder)} />
}

export function LogList({ lines, order }: { lines: LogLine[]; order: LogOrder }) {
  if (!lines.length) return <p className="fx-d-muted">還沒有紀錄</p>
  return (
    <ol className="fx-d-log" reversed={order === 'newestFirst' || undefined}>
      {ordered(lines, order).map((l, i) => (
        <li key={i} className={`fx-d-log-${l.kind}`}>
          <time>{fmtClock(l.at)}</time>
          {l.who}
          {l.node && <b>{l.node}</b>}
          {/* the user's own replies, merges and send-backs */}
          {l.kind === 'human' && <strong className="fx-d-log-user">使用者</strong>}
          <span>{l.text}</span>
        </li>
      ))}
    </ol>
  )
}

function Bar({ value }: { value: number }) {
  return <span className="fx-d-bar" role="img" aria-label={`${Math.round(value * 100)}%`}><i style={{ width: `${value * 100}%` }} /></span>
}

/** The steps after 整理需求: work and discussions. */
function workSteps(wf: Workflow) {
  return wf.nodes.filter((n) => n.kind !== 'task')
}

/** A task someone asked for. The sub-tasks the employees made for it are listed here and open on their own sheet. */
function TaskDetail({ id, open, onOpen, flowOpen, onFlow, editing, onEdit, onGoneTask, crew, onCrew, image, onImage, ...h }: Head & {
  id: string
  /** The picture open on the sheet above, by index, and how to open one. */
  image: number | null
  onImage: (index: number) => void
  /** The employee open on the sheet above, and how to open one (the task's owner). */
  crew: string | null
  onCrew: (id: string) => void
  open: string | null
  onOpen: (subId: string) => void
  /** Whether its flow, spelled out step by step, is the sheet above. */
  flowOpen: boolean
  onFlow: () => void
  editing: boolean
  onEdit: () => void
  /** Called once the task is deleted, to put its sheet away. */
  onGoneTask: () => void
}) {
  const t = useT()
  const w = useStore((s) => s.world)
  const act = useStore((s) => s.act)
  const task = w.tasks[id]
  if (!task) return <Gone {...h} />
  const canPause = task.stage === 'running'
  const remove = () => {
    onGoneTask()
    act((x) => deleteTask(x, id))
  }
  const subs = subsOf(w, task.id).filter((s) => !s.cancelled).sort((a, b) => a.createdAt - b.createdAt)
  const status = statusOf(w, task)
  const flow = w.workflows[task.workflowId]?.name ?? task.workflow.name
  const staffOf = (n: string) => nodeOf(task.workflow, n)?.replicaIds ?? []
  const owner = task.ownerId ? w.replicas[task.ownerId] : undefined
  const lines = [
    ...taskLines(subs).map((l) => ({ ...l, text: logText(t, l), node: stepName(task.workflow, l.s.nodeId) })),
    ...(task.merge?.log ?? []).map((l) => ({ ...l, node: '合併' })),
  ].sort((a, b) => a.at - b.at).slice(-LOG_LINES)
  return (
    <>
      <div className="fx-tools">
        <EditTool onClick={onEdit} open={editing} />
        <button type="button" className="fx-tool fx-hit" disabled={!canPause} aria-pressed={task.paused}
          onClick={() => act((x) => (task.paused ? resumeTask(x, id) : pauseTask(x, id)))}
          aria-label={task.paused ? '繼續' : '暫停'} title={task.paused ? '繼續' : '暫停'}>
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            {task.paused ? <path d="M5 3l8 5-8 5z" fill="currentColor" /> : <path d="M5 3v10M11 3v10" stroke="currentColor" strokeWidth="2" />}
          </svg>
        </button>
        <DeleteTool what="任務" onConfirm={remove} />
      </div>
      <header className="fx-d-head">
        <Heading {...h}><span className="fx-task-no">#{task.number}</span>{task.title}</Heading>
        <p className="fx-d-meta">
          {/* one state: paused or merging says more than the column it sits in */}
          <span className="fx-pill">{task.stage === 'cancelled' ? '已停止' : task.paused ? '已暫停' : task.stage === 'merging' ? '合併中' : STATUS[status]}</span>
          {owner && (
            <span className="fx-d-owner">負責人
              <button type="button" className="fx-hit" aria-expanded={crew === owner.id} onClick={() => onCrew(owner.id)}>
                <PixelFace look={owner.look} name={owner.name} size={18} />{owner.name}
              </button>
            </span>
          )}
        </p>
      </header>
      {task.description && <p className="fx-d-text">{task.description}</p>}
      {task.images.length > 0 && (
        <div className="fx-thumbs">
          {task.images.map((im, i) => (
            <button key={i} type="button" className="fx-thumb fx-hit" aria-expanded={image === i} onClick={() => onImage(i)}>
              <img src={im.url} alt={im.name} />
            </button>
          ))}
        </div>
      )}
      {/* the drawing opens as a whole, as flows do in the company file: its title is the button */}
      <section className="fx-flow fx-flow-card fx-d-flowcard" onClick={openCard}>
        <h3><button type="button" className="fx-flow-open" aria-expanded={flowOpen} onClick={onFlow}>{flow}</button></h3>
        <FlowNotes wf={task.workflow} staff={staffOf} done={(n) => stepDone(subs, n)} />
      </section>
      <Section name="進度">
        <Progress wf={task.workflow} subs={subs} open={open} onOpen={onOpen} />
        <MergeRow taskId={task.id} />
      </Section>
      <Section name="紀錄"><Log lines={lines} /></Section>
    </>
  )
}

const stepName = (wf: Workflow, nodeId: string) => nodeOf(wf, nodeId)?.name ?? nodeId

/** A step's note colour, as on the flow drawing: the two fixed ends pink, a discussion green, the rest yellow. */
const noteCls = (wf: Workflow, nodeId: string) =>
  isFixed(wf, nodeId) ? ' fx-node-fixed' : nodeOf(wf, nodeId)?.kind === 'talk' ? ' fx-node-talk' : ''

/** The red round badge of something waiting on the user. */
const Badge = ({ inline }: { inline?: boolean }) => <span className={inline ? 'fx-badge fx-badge-inline' : 'fx-badge'} aria-hidden="true">!</span>


/**
 * Every sub-task of a task, in the order they started: who has it at which step, then what they handed on
 * (or sent back) once it is done, or how far along it is until then. One waiting on the user carries a red
 * badge; the user answers on its own sheet.
 */
function Progress({ wf, subs, open, onOpen }: { wf: Workflow; subs: SubTask[]; open: string | null; onOpen: (subId: string) => void }) {
  const w = useStore((s) => s.world)
  const replicas = w.replicas
  if (!subs.length) return <p className="fx-d-muted">還沒有開始</p>
  return (
    <ul className="fx-list">
      {subs.map((s) => {
        const r = s.replicaId ? replicas[s.replicaId] : undefined
        const out = s.status === 'complete' && !s.skipped ? s.handoff?.human.headline : undefined
        return (
          <li key={s.id}>
            <button type="button" className="fx-row fx-d-hand fx-hit" aria-expanded={open === s.id} onClick={() => onOpen(s.id)}>
              {r ? <PixelFace look={r.look} name={r.name} size={26} /> : <span className="fx-d-noface" />}
              <span className="fx-row-main">
                <span className="fx-d-hand-head">
                  <span className={`fx-d-stepname fx-d-stepname-sm${noteCls(wf, s.nodeId)}`}>{stepName(wf, s.nodeId)}</span>
                  {s.rework && <span className="fx-d-muted">重做</span>}
                </span>
                {out
                  ? <span className={s.sentBack ? 'fx-d-hand-text fx-d-hand-back' : 'fx-d-hand-text'}>{out}</span>
                  : <SubState sub={s} />}
              </span>
              {out && s.endedAt !== undefined && <time>{fmtClock(s.endedAt)}</time>}
              {s.review && <Badge inline />}
            </button>
          </li>
        )
      })}
    </ul>
  )
}

/** What an employee waiting on the user says, in full. */
function askText(w: World, sub: SubTask): string {
  const r = sub.review!
  const task = w.tasks[sub.taskId]
  if (r.kind === 'question') return r.prompt ?? ''
  if (r.kind === 'pickRoute') return '這一步做完了，但我不確定接下來要交給哪一步，請幫我選一個。'
  if (r.kind === 'failed') {
    const max = w.teams[task.teamId]?.settings.retries ?? 0
    return `執行${r.reason === 'timeout' ? '逾時' : '出錯'}，自動重試 ${max} 次都沒成功。要再試一次，還是略過這一步？`
  }
  return `任務花費已經到上限 $${costLimit(w, task).toFixed(2)}，我先停下來了。要提高上限繼續，還是暫停任務？`
}

/**
 * The user's answer to an employee waiting on them, on the step's sheet under what they ask: its choices, a
 * box to write in and 確認. A question can be answered in words alone; anything else needs one of its choices.
 */
function Reply({ sub }: { sub: SubTask }) {
  const t = useT()
  const act = useStore((s) => s.act)
  const [choice, setChoice] = useState('')
  const [text, setText] = useState('')
  const r = sub.review!
  const question = r.kind === 'question'
  const ready = !!choice || (question && !!text.trim())
  const send = (e: React.FormEvent) => {
    e.preventDefault()
    if (ready) act((x) => resolveReview(x, sub.id, choice, text))
  }
  return (
    <form className="fx-d-reply" onSubmit={send}>
      <div className="fx-d-choices" role="group" aria-label="選項">
        {r.options.map((o) => (
          <button key={o.id} type="button" aria-pressed={choice === o.id} className="fx-choice"
            title={o.detail || undefined} onClick={() => setChoice(choice === o.id ? '' : o.id)}>
            {o.label ?? t(`option.${o.id}`)}
          </button>
        ))}
      </div>
      <textarea className="fx-control" rows={2} value={text} aria-label="回覆"
        placeholder={question ? '回覆，或選上面一個' : '補充說明（會寫進記憶）'} onChange={(e) => setText(e.target.value)} />
      <div className="fx-d-merge-acts"><button type="submit" className="fx-save" disabled={!ready}>確認</button></div>
    </form>
  )
}

/**
 * A 使用者討論 step's conversation: the employee's messages on the left under their face, the user's on the
 * right, and while it is open a box to write in (Enter sends, Shift+Enter starts a new line) and 結束討論.
 * Ending asks how to go on: 繼續 (to which next step, when the step picks one of several), 退回 with a
 * reason, or 停止任務, which asks once more.
 */
function Chat({ sub }: { sub: SubTask }) {
  const w = useStore((s) => s.world)
  const act = useStore((s) => s.act)
  const [text, setText] = useState('')
  const [ending, setEnding] = useState<null | 'pick' | 'back' | 'stop'>(null)
  const [reason, setReason] = useState('')
  const list = useRef<HTMLOListElement>(null)
  const talk = sub.talk!
  const task = w.tasks[sub.taskId]
  const wf = task.workflow
  const r = sub.replicaId ? w.replicas[sub.replicaId] : undefined
  const open = talking(sub) && task.stage === 'running'
  const writing = talk.replyAt !== undefined
  // the newest message in view, inside the chat's own scroll
  const count = talk.messages.length + (writing ? 1 : 0)
  useEffect(() => {
    const el = list.current
    if (el) el.scrollTop = el.scrollHeight
  }, [count])
  const node = nodeOf(wf, sub.nodeId)
  const outs = outEdges(wf, sub.nodeId)
  // the step picks one of several next steps: going on names which
  const routes = node?.handoff === 'pickOne' && outs.length > 1 ? outs.map((e) => e.to) : null
  const send = () => {
    if (!text.trim() || writing) return
    act((x) => sayInTalk(x, sub.id, text))
    setText('')
  }
  const end = (e: TalkEnd) => {
    act((x) => endTalk(x, sub.id, e))
    setEnding(null)
  }
  const face = r ? <PixelFace look={r.look} name={r.name} size={22} /> : <span className="fx-d-noface" />
  const ENDED = { continue: '討論結束，繼續下一步', back: '討論結束，退回重做', stop: '討論結束，任務已停止' } as const
  return (
    <div className="fx-chat">
      <ol ref={list} className="fx-chat-log" aria-live="polite" aria-label={`和 ${r?.name ?? '員工'} 的討論`}>
        {talk.messages.map((m, i) => (
          <li key={i} className={`fx-chat-msg fx-chat-${m.from}`}>
            {m.from === 'agent' && face}
            <p><span className="fx-sr">{m.from === 'agent' ? r?.name ?? '員工' : '你'}：</span>{m.text}</p>
            <time>{fmtClock(m.at)}</time>
          </li>
        ))}
        {writing && (
          <li className="fx-chat-msg fx-chat-agent fx-chat-writing">
            {face}<p><span className="fx-sr">{r?.name ?? '員工'} 正在回覆</span><span aria-hidden="true">···</span></p>
          </li>
        )}
      </ol>
      {talk.ended && <p className="fx-d-muted">{ENDED[talk.ended]}</p>}
      {open && !ending && (
        <form className="fx-chat-say" onSubmit={(e) => { e.preventDefault(); send() }}>
          <textarea className="fx-control" rows={2} value={text} aria-label="訊息" placeholder={writing ? `${r?.name ?? '員工'} 正在回覆…` : '輸入訊息'}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends; not while a Chinese word is still being picked in the input method
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                send()
              }
            }} />
          <div className="fx-d-merge-acts">
            <button type="submit" className="fx-save" disabled={!text.trim() || writing}>送出</button>
            <button type="button" className="fx-save fx-plain" onClick={() => setEnding('pick')}>結束討論</button>
          </div>
        </form>
      )}
      {open && ending && (
        <div className="fx-chat-end" role="group" aria-label="結束討論"
          onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setEnding(null) } }}>
          {ending === 'back' ? (
            <form className="fx-d-merge-back" onSubmit={(e) => { e.preventDefault(); if (reason.trim()) end({ kind: 'back', reason }) }}>
              <textarea className="fx-control" rows={2} autoFocus value={reason} aria-label="退回原因" placeholder="要改什麼"
                onChange={(e) => setReason(e.target.value)} />
              <div className="fx-d-merge-acts">
                <button type="submit" className="fx-save fx-plain" disabled={!reason.trim()}>退回</button>
                <button type="button" className="fx-add" onClick={() => setEnding('pick')}>返回</button>
              </div>
            </form>
          ) : (
            <div className="fx-d-merge-acts">
              {routes
                ? routes.map((to) => (
                    <button key={to} type="button" className="fx-save" onClick={() => end({ kind: 'continue', to })}>繼續：{stepName(wf, to)}</button>
                  ))
                : <button type="button" className="fx-save" autoFocus onClick={() => end({ kind: 'continue' })}>繼續</button>}
              {sub.upstreamIds.length > 0 && <button type="button" className="fx-save fx-plain" onClick={() => setEnding('back')}>退回</button>}
              {ending === 'stop'
                ? <button type="button" className="fx-save fx-danger" autoFocus onClick={() => end({ kind: 'stop' })} onBlur={() => setEnding('pick')}>確定停止任務</button>
                : <button type="button" className="fx-save fx-plain" onClick={() => setEnding('stop')}>停止任務</button>}
              <button type="button" className="fx-add" onClick={() => setEnding(null)}>取消</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * The last row of a task's progress once every step is done: the owner merging the task's work tree into
 * the target branch. It opens nothing. While it waits for the user it carries 合併 and 退回 at its end; 退回
 * asks under the row what to change, and sends the work back to the steps before 驗收.
 */
function MergeRow({ taskId }: { taskId: string }) {
  const w = useStore((s) => s.world)
  const act = useStore((s) => s.act)
  const [returning, setReturning] = useState(false)
  const [feedback, setFeedback] = useState('')
  const task = w.tasks[taskId]
  const m = task?.merge
  const waiting = task?.stage === 'awaitMerge'
  if (!task || (!waiting && !m)) return null
  const id = m?.replicaId ?? task.ownerId
  const r = id ? w.replicas[id] : undefined
  const target = w.teams[task.teamId]?.targetBranch ?? 'main'
  const done = task.stage === 'done'
  const busy = m?.startedAt !== undefined && m.endsAt !== undefined && !done
  const state = waiting ? `${task.branch} → ${target}`
    : done ? `已合併回 ${target}`
    : !busy ? `等 ${r?.name ?? '負責人'} 有空`
    : m!.conflict && w.now - m!.startedAt! < RESOLVE_TIME ? '解衝突中' : '合併中'
  const sendBack = () => {
    act((x) => returnTask(x, taskId, feedback))
    setReturning(false)
    setFeedback('')
  }
  const face = r ? <PixelFace look={r.look} name={r.name} size={26} /> : <span className="fx-d-noface" />
  const main = (
    <span className="fx-row-main">
      <span className="fx-d-hand-head"><span className="fx-d-stepname fx-d-stepname-sm fx-node-fixed">合併</span></span>
      {busy
        ? <span className="fx-d-run fx-d-hand-text"><Bar value={(w.now - m!.startedAt!) / (m!.endsAt! - m!.startedAt!)} /><span className="fx-d-muted">{state}</span></span>
        : <span className="fx-d-hand-text fx-d-muted">{state}</span>}
    </span>
  )
  return (
    <div className="fx-d-merge">
      <div className="fx-row fx-d-hand">
        {face}{main}
        {done && task.doneAt !== undefined && <time>{fmtClock(task.doneAt)}</time>}
        {waiting && !returning && (
          <div className="fx-d-merge-acts">
            <button type="button" className="fx-save fx-danger" onClick={() => act((x) => mergeTask(x, taskId))}>合併</button>
            <button type="button" className="fx-save fx-plain" onClick={() => setReturning(true)}>退回</button>
          </div>
        )}
      </div>
      {waiting && returning && (
        <form className="fx-d-merge-back" onSubmit={(e) => { e.preventDefault(); sendBack() }}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setReturning(false) } }}>
          <textarea className="fx-control" rows={3} autoFocus value={feedback} aria-label="退回原因"
            placeholder="要改什麼" onChange={(e) => setFeedback(e.target.value)} />
          <div className="fx-d-merge-acts">
            <button type="submit" className="fx-save fx-plain" disabled={!feedback.trim()}>退回</button>
            <button type="button" className="fx-add" onClick={() => setReturning(false)}>取消</button>
          </div>
        </form>
      )}
    </div>
  )
}

/** Where a sub-task that has not handed on yet stands: a bar while worked on, else a word. */
function SubState({ sub }: { sub: SubTask }) {
  if (sub.status === 'progressing') {
    return (
      <span className="fx-d-run fx-d-hand-text">
        <Bar value={sub.progress} /><span className="fx-d-muted">{Math.round(sub.progress * 100)}%{sub.attempts > 1 ? `・第 ${sub.attempts} 次` : ''}</span>
      </span>
    )
  }
  const word = sub.skipped ? '略過'
    : sub.status === 'complete' ? '完成'
    : sub.review ? (sub.review.kind === 'talk' ? '討論中，等你回覆' : '等你回覆')
    : sub.waiting ? '等其他前一步完成'
    : sub.replicaId ? '準備開始' : '等人接手'
  return <span className="fx-d-hand-text fx-d-muted">{word}</span>
}

/** Every step, in the order the flow runs them, left to right and then top to bottom as drawn. */
function inOrder(wf: Workflow) {
  const { at } = layers(wf)
  const place = (id: string) => (at[id] ? at[id].layer * 1000 + at[id].rank : Infinity)
  return [...wf.nodes].sort((a, b) => place(a.id) - place(b.id))
}

/**
 * A flow drawing with each step spelled out under it, so its notes need not be opened one by one: clicking a
 * note brings its step into view instead.
 */
function FlowSteps(p: Parameters<typeof StepList>[0]) {
  const list = useRef<HTMLOListElement>(null)
  const show = (nodeId: string) => {
    const li = list.current?.querySelector<HTMLElement>(`[data-step-item="${CSS.escape(nodeId)}"]`)
    if (!li) return
    li.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
    // a brief shade, so the eye finds which step it landed on
    li.classList.remove('fx-d-flash')
    void li.offsetWidth
    li.classList.add('fx-d-flash')
  }
  return (
    <>
      <div className="fx-flow"><FlowNotes wf={p.wf} staff={p.staff} done={p.done} onOpen={show} /></div>
      <StepList {...p} listRef={list} />
    </>
  )
}

/** Under a flow drawing: each step spelled out on a whole note, coloured like its note in the drawing. */
function StepList({ wf, staff, done, crew, onCrew, listRef }: {
  listRef?: React.Ref<HTMLOListElement>
  wf: Workflow
  staff?: (nodeId: string) => string[]
  done?: (nodeId: string) => boolean
  /** The employee open on the sheet above, and how to open one. */
  crew?: string | null
  onCrew?: (id: string) => void
}) {
  return (
    <ol ref={listRef} className="fx-d-steps">
      {inOrder(wf).map((n) => {
        const finished = done?.(n.id)
        return (
          <li key={n.id} data-step-item={n.id} className={`fx-step-note${noteCls(wf, n.id)}${finished ? ' fx-node-done' : ''}`}>
            <h4>{n.name}</h4>
            {staff ? <Crew ids={staff(n.id)} open={crew} onOpen={onCrew} /> : isFixed(wf, n.id) && <Owner />}
            {n.prompt && !isFixed(wf, n.id) && <p className="fx-d-text">{n.prompt}</p>}
            <StepFacts wf={wf} id={n.id} />
          </li>
        )
      })}
    </ol>
  )
}

/** How a step takes work in and hands it on. */
function StepFacts({ wf, id }: { wf: Workflow; id: string }) {
  const n = nodeOf(wf, id)
  if (!n) return null
  const next = outEdges(wf, id).map((e) => nodeOf(wf, e.to)?.name).filter(Boolean)
  const before = inEdges(wf, id).length
  return (
    <dl className="fx-d-facts">
      {n.kind === 'talk' && <><dt>種類</dt><dd>{KINDS.talk}</dd></>}
      {!isFixed(wf, id) && <><dt>任務分派</dt><dd>{ASSIGN[n.assignment]}</dd></>}
      {before > 1 && <><dt>開始條件</dt><dd>{JOIN[n.join]}</dd></>}
      {next.length > 1 && <><dt>交接</dt><dd>{HANDOFF[n.handoff]}</dd></>}
      <dt>下一步</dt><dd>{next.length ? next.join('、') : '結束'}</dd>
    </dl>
  )
}

/** Who works 整理需求 and 驗收 on a flow, which names nobody: whoever owns the task. */
function Owner() {
  return <ul className="fx-d-crew"><li className="fx-d-crew-owner">任務負責人</li></ul>
}

/** The employees on a step, face and name; each opens on its own sheet when `onOpen` is given. */
function Crew({ ids, open, onOpen }: { ids: string[]; open?: string | null; onOpen?: (id: string) => void }) {
  const replicas = useStore((s) => s.world.replicas)
  const crew = ids.map((id) => replicas[id]).filter(Boolean)
  if (!crew.length) return <p className="fx-d-muted">沒有人</p>
  return (
    <ul className="fx-d-crew">
      {crew.map((r) => {
        const face = <><PixelFace look={r.look} name={r.name} size={18} />{r.name}</>
        return (
          <li key={r.id}>
            {onOpen ? <button type="button" className="fx-hit" aria-expanded={open === r.id} onClick={() => onOpen(r.id)}>{face}</button> : face}
          </li>
        )
      })}
    </ul>
  )
}

/** A task's flow spelled out: the drawing with this time's staff, and every step listed under it. */
function TaskFlow({ taskId, crew, onCrew, ...h }: Head & {
  taskId: string
  crew: string | null
  onCrew: (id: string) => void
}) {
  const w = useStore((s) => s.world)
  const task = w.tasks[taskId]
  if (!task) return <Gone {...h} />
  const subs = subsOf(w, task.id).filter((s) => !s.cancelled)
  const staffOf = (n: string) => nodeOf(task.workflow, n)?.replicaIds ?? []
  const done = (n: string) => stepDone(subs, n)
  return (
    <>
      <header className="fx-d-head">
        <Heading {...h}>{w.workflows[task.workflowId]?.name ?? task.workflow.name}</Heading>
        <p className="fx-d-meta"><span><span className="fx-task-no">#{task.number}</span>{task.title}</span></p>
      </header>
      <FlowSteps wf={task.workflow} staff={staffOf} done={done} crew={crew} onCrew={onCrew} />
    </>
  )
}

/** One piece of a task, made by an employee: who did it, what came in, what they handed on, and their log. */
function SubDetail({ id, open, onOpen, crew, onCrew, ...h }: Head & {
  id: string; open: string | null; onOpen: (path: string) => void
  /** The employee whose sheet lies on this one, if any. */
  crew: string | null; onCrew: (id: string) => void
}) {
  const t = useT()
  const w = useStore((s) => s.world)
  const sub = w.subTasks[id]
  const task = sub && w.tasks[sub.taskId]
  if (!sub || !task) return <Gone {...h} />
  const wf = task.workflow
  const r = sub.replicaId ? w.replicas[sub.replicaId] : undefined
  const name = (nodeId: string) => stepName(wf, nodeId)
  const from = sub.upstreamIds.map((x) => w.subTasks[x]).filter(Boolean).map((x) => name(x.nodeId))
  const out = sub.handoff?.human
  return (
    <>
      <header className="fx-d-head">
        <Heading {...h}>{name(sub.nodeId)}</Heading>
        <p className="fx-d-meta">
          <span className="fx-pill">{task.stage === 'cancelled' ? '已停止' : sub.skipped ? '略過' : STATUS[sub.status]}</span>
          <span><span className="fx-task-no">#{task.number}</span>{task.title}</span>
        </p>
      </header>
      {sub.status === 'progressing' && <p className="fx-d-run"><Bar value={sub.progress} /><span className="fx-d-muted">{Math.round(sub.progress * 100)}%</span></p>}
      {/* the user answers here: a discussion in its chat, anything else under what the employee asks */}
      {sub.talk && <Section name="討論"><Chat key={sub.id} sub={sub} /></Section>}
      {sub.review && sub.review.kind !== 'talk' && (
        <Section name="等你回覆">
          <p className="fx-d-text fx-d-quote">{askText(w, sub)}</p>
          <Reply key={sub.review.at} sub={sub} />
        </Section>
      )}
      <Section name="負責員工">
        {r ? (
          <ul className="fx-list">
            <li><button type="button" className="fx-row fx-hit" aria-expanded={crew === r.id} onClick={() => onCrew(r.id)}>
              <PixelFace look={r.look} name={r.name} size={34} />
              <span className="fx-row-main"><b>{r.name}</b><span>{w.blueprints[r.blueprintId]?.name}</span></span>
            </button></li>
          </ul>
        ) : <p className="fx-d-muted">等人接手</p>}
      </Section>
      <Section name="經過">
        <dl className="fx-d-facts">
          <dt>接自</dt><dd>{from.length ? from.join('、') : '任務本身'}</dd>
          {sub.rework && <><dt>退回自</dt><dd>{name(w.subTasks[sub.rework.from]?.nodeId ?? '')}：{sub.rework.reason}</dd></>}
          {sub.startedAt !== undefined && <><dt>開始</dt><dd>{fmtClock(sub.startedAt)}</dd></>}
          {sub.endedAt !== undefined && <><dt>結束</dt><dd>{fmtClock(sub.endedAt)}</dd></>}
          {sub.attempts > 1 && <><dt>嘗試</dt><dd>{sub.attempts} 次</dd></>}
          <dt>花費</dt><dd>${sub.costUsd.toFixed(2)}</dd>
          {sub.sentBack
            ? <><dt>退回給</dt><dd>{sub.sentBack.to.map(name).join('、')}</dd></>
            : sub.routedTo.length > 0 && <><dt>交給</dt><dd>{sub.routedTo.map(name).join('、')}</dd></>}
          <dt>分支</dt><dd><code>{task.branch}</code></dd>
        </dl>
      </Section>
      {out && (
        <Section name="交接">
          <p className="fx-d-text"><b>{out.headline}</b></p>
          {out.did.length > 0 && <ul className="fx-d-memory">{out.did.map((x, i) => <li key={i}>{x}</li>)}</ul>}
          {out.outputs.length > 0 && (
            <ul className="fx-list fx-d-files" aria-label="交出的檔案">
              {out.outputs.map((x) => (
                <li key={x}>
                  <button type="button" className="fx-row fx-hit" aria-expanded={open === x} onClick={() => onOpen(x)}>
                    <FileIcon />
                    <span className="fx-row-main"><b>{x.split('/').pop()}</b><span>{x}</span></span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}
      <Section name="紀錄"><Log lines={sub.log.slice(-LOG_LINES).map((l) => ({ ...l, text: logText(t, l) }))} /></Section>
    </>
  )
}

function FlowDetail({ id, teamId, editing, onEdit, onGoneFlow, ...h }: Head & {
  id: string
  teamId: string
  editing: boolean
  onEdit: () => void
  /** Called once the flow is deleted, to put its sheet away. */
  onGoneFlow: () => void
}) {
  const w = useStore((s) => s.world)
  const act = useStore((s) => s.act)
  const wf = w.workflows[id]
  if (!wf) return <Gone {...h} />
  const last = Object.values(w.workflows).filter((x) => x.teamId === teamId).length < 2
  const remove = () => {
    onGoneFlow()
    act((x) => deleteWorkflow(x, id))
  }
  const tasks = Object.values(w.tasks).filter((t) => t.teamId === teamId && t.workflowId === wf.id && statusOf(w, t) !== 'complete')
  return (
    <>
      <div className="fx-tools">
        <EditTool onClick={onEdit} open={editing} />
        <button type="button" className="fx-tool fx-hit" onClick={() => act((x) => void duplicateWorkflow(x, id))} aria-label="複製" title="複製">
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <rect x="5.5" y="5.5" width="8" height="8" rx="1" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M10.5 3.2V2.5h-8v8h.7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
          </svg>
        </button>
        <DeleteTool what="流程" onConfirm={remove} disabled={last} why="公司至少要有一條流程" />
      </div>
      <header className="fx-d-head">
        <Heading {...h}>{wf.name}</Heading>
        <p className="fx-d-meta">
          {w.teams[teamId]?.defaultWorkflowId === wf.id && <span className="fx-pill">預設</span>}
          <span>{workSteps(wf).length} 個步驟</span>
          <span>{tasks.length ? `${tasks.length} 個任務未完成` : '沒有未完成的任務'}</span>
        </p>
      </header>
      <FlowSteps wf={wf} />
    </>
  )
}

function CrewDetail({ id, editing, firing, onEdit, onFire, ...h }: Head & {
  id: string
  editing: boolean
  firing: boolean
  onEdit: () => void
  onFire: () => void
}) {
  const t = useT()
  const w = useStore((s) => s.world)
  const r = w.replicas[id]
  if (!r) return <Gone {...h} />
  const last = lastSub(w, r)
  const steps = staffedOn(w, r)
  const doing = doingOf(w, r)
  const alone = teamReplicas(w, r.teamId).length < 2
  return (
    <>
      <div className="fx-tools">
        <EditTool onClick={onEdit} open={editing} />
        <button type="button" className="fx-tool fx-hit" onClick={onFire} aria-expanded={firing} disabled={alone}
          aria-label="解僱" title={alone ? '公司至少要有一位員工' : '解僱'}>
          <BinIcon />
        </button>
      </div>
      <header className="fx-d-head fx-d-who">
        <PixelFace look={r.look} name={r.name} size={52} />
        <div>
          <Heading {...h}>{r.name}</Heading>
          <p className="fx-d-meta">
            <span>{w.blueprints[r.blueprintId]?.name}</span>
            <span>{mindOf(r)}</span>
            {doing ? <span className="fx-pill fx-pill-on">{doing}</span> : <span>沒有工作</span>}
          </p>
        </div>
      </header>
      <Section name="負責的任務">
        {steps.length === 0 ? <p className="fx-d-muted">還沒被安排</p> : (
          <p className="fx-d-chips">{steps.map(({ task, n }) => <span key={task.id + n.id}>#{task.number} › {stepName(task.workflow, n.id)}</span>)}</p>
        )}
      </Section>
      <Section name="最近的工作">
        <Log lines={(last?.log ?? []).slice(-LOG_LINES).map((l) => ({ ...l, text: logText(t, l) }))} />
      </Section>
      <Section name={`記憶 ${r.memory.length}`}>
        {r.memory.length === 0 ? <p className="fx-d-muted">還沒有記憶</p> : (
          <ul className="fx-d-memory">
            {r.memory.map((m) => (
              <li key={m.id}>{m.text}{m.taskId && w.tasks[m.taskId] && <span className="fx-d-muted"> #{w.tasks[m.taskId].number}</span>}</li>
            ))}
          </ul>
        )}
      </Section>
    </>
  )
}

/** The steps someone works in the tasks not yet finished. */
function staffedOn(w: World, r: Replica) {
  return Object.values(w.tasks)
    .filter((t) => t.teamId === r.teamId && t.stage !== 'done' && t.stage !== 'cancelled')
    .sort((a, b) => a.number - b.number)
    .flatMap((task) => task.workflow.nodes.filter((n) => n.replicaIds.includes(r.id)).map((n) => ({ task, n })))
}

/** What someone is working on right now, or null when idle. */
function doingOf(w: World, r: Replica) {
  const a = activity(w, r)
  if (a.sub && a.task) return `${nodeOf(a.task.workflow, a.sub.nodeId)?.name ?? ''} · #${a.task.number}`
  return a.merging ? `合併 · #${a.merging.number}` : null
}

/** A model provider: how it is reached, the models it offers, and who runs on them. */
function ProviderDetail({ id, editing, onEdit, onGoneProvider, ...h }: Head & {
  id: string
  editing: boolean
  onEdit: () => void
  /** Called once the provider is deleted, to put its sheet away. */
  onGoneProvider: () => void
}) {
  const w = useStore((s) => s.world)
  const act = useStore((s) => s.act)
  const p = w.providers[id]
  if (!p) return <Gone {...h} />
  const crew = providerUsers(w, p.id)
  const remove = () => {
    onGoneProvider()
    act((x) => void deleteProvider(x, id))
  }
  return (
    <>
      <div className="fx-tools">
        <EditTool onClick={onEdit} open={editing} />
        <DeleteTool what="供應商" onConfirm={remove} disabled={crew.length > 0} why={`還有 ${crew.length} 位員工使用這個供應商，無法刪除`} />
      </div>
      <header className="fx-d-head"><Heading {...h}>{p.name}</Heading></header>
      <Section name="類型"><p className="fx-d-text">{PROVIDER_KINDS[p.kind].label}</p></Section>
      <Section name="連線方式"><p className="fx-d-text">{authLabel(p)}</p></Section>
      {p.auth.kind === 'apiKey' && (
        <>
          <Section name="API 位址"><p className="fx-d-text"><code>{providerUrl(p)}</code></p></Section>
          <Section name="API Key"><p className="fx-d-text"><code>{p.auth.keyHint ? `••••${p.auth.keyHint}` : '沒有'}</code></p></Section>
        </>
      )}
      <Section name="模型">
        {p.models.length === 0 ? <p className="fx-d-muted">沒有</p> : (
          <p className="fx-d-chips fx-d-mono">{p.models.map((m) => <span key={m}>{m}</span>)}</p>
        )}
      </Section>
      <Section name="使用中的員工">
        {crew.length === 0 ? <p className="fx-d-muted">沒有人</p> : (
          <ul className="fx-d-people">
            {crew.map((r) => <li key={r.id}><PixelFace look={r.look} name={r.name} size={26} /><b>{r.name}</b><span>{r.model}</span></li>)}
          </ul>
        )}
      </Section>
    </>
  )
}

/**
 * Add a model provider (`id` null) or change one. A new one takes the models its kind lists, so none
 * are typed; the kind stays once added. Anthropic and OpenAI can be signed in to with a Claude or
 * ChatGPT subscription instead of a key. A key is taken whole, and only its last four characters kept;
 * left empty when editing, the old one stays.
 */
function ProviderEdit({ id, onDone, ...h }: Head & { id: string | null; onDone: () => void }) {
  const act = useStore((s) => s.act)
  const old = useStore((s) => (id ? s.world.providers[id] : undefined))
  const [kind, setKind] = useState<ProviderKind>(old?.kind ?? 'anthropic')
  const [auth, setAuth] = useState<'apiKey' | 'subscription'>(old?.auth.kind ?? 'apiKey')
  const [name, setName] = useState(old?.name ?? PROVIDER_KINDS.anthropic.label)
  const [named, setNamed] = useState(!!old)
  const [url, setUrl] = useState(old?.baseUrl ?? '')
  const [key, setKey] = useState('')
  const [signedIn, setSignedIn] = useState(old?.auth.kind === 'subscription')
  const [loginError, setLoginError] = useState(false)
  if (id && !old) return <Gone {...h} />
  const sub = SUBSCRIPTIONS[kind]
  const nameFor = (k: ProviderKind, a: typeof auth) => (a === 'subscription' ? `${SUBSCRIPTIONS[k]} 訂閱` : PROVIDER_KINDS[k].label)
  const pickKind = (k: ProviderKind) => {
    const a = SUBSCRIPTIONS[k] ? auth : 'apiKey'
    setKind(k)
    setAuth(a)
    setSignedIn(false)
    if (!named) setName(nameFor(k, a))
  }
  const pickAuth = (a: typeof auth) => {
    setAuth(a)
    setLoginError(false)
    if (!named) setName(nameFor(kind, a))
  }
  const custom = kind === 'compatible'
  // a key is asked for unless one is kept already, or the provider needs none
  const needKey = !custom && !(old?.auth.kind === 'apiKey')
  const save = (e: React.FormEvent) => {
    e.preventDefault()
    if (auth === 'subscription' && !signedIn) return setLoginError(true)
    const login: ProviderLogin | null = auth === 'subscription'
      ? (old?.auth.kind === 'subscription' ? null : { kind: 'subscription' })
      : { kind: 'apiKey', apiKey: key }
    act((x) => {
      if (old) updateProvider(x, old.id, { name, baseUrl: url, login })
      else addProvider(x, { name, kind, baseUrl: url, login: login ?? { kind: 'subscription' }, models: PROVIDER_KINDS[kind].models })
    })
    onDone()
  }
  return (
    <form className="fx-d-form" onSubmit={save}>
      <header className="fx-d-head"><Heading {...h}>{old ? `編輯 ${old.name}` : '新增模型供應商'}</Heading></header>
      <div className="fx-fields">
        {!old && (
          <Select label="類型" value={kind} options={Object.keys(PROVIDER_KINDS)} labelOf={(k) => PROVIDER_KINDS[k as ProviderKind].label}
            onChange={(k) => pickKind(k as ProviderKind)} />
        )}
        {sub && (
          <Select label="連線方式" value={auth} options={['apiKey', 'subscription']}
            labelOf={(a) => (a === 'apiKey' ? 'API Key' : `${sub} 訂閱`)} onChange={(a) => pickAuth(a as typeof auth)} />
        )}
        <label className="fx-field">
          <span>名稱</span>
          <input className="fx-control" value={name} required pattern=".*\S.*" title="名稱不可為空"
            onChange={(e) => { setName(e.target.value); setNamed(true) }} />
        </label>
        {auth === 'apiKey' ? (
          <>
            <label className="fx-field">
              <span>API 位址</span>
              <input className="fx-control" type="url" value={url} required={custom} spellCheck={false} autoComplete="off"
                placeholder={PROVIDER_KINDS[kind].url || 'http://localhost:11434/v1'} onChange={(e) => setUrl(e.target.value)} />
            </label>
            <label className="fx-field">
              <span>API Key</span>
              <input className="fx-control" type="password" value={key} required={needKey} spellCheck={false} autoComplete="off"
                placeholder={old?.auth.kind === 'apiKey' && old.auth.keyHint ? `••••${old.auth.keyHint}` : undefined}
                onChange={(e) => setKey(e.target.value)} />
            </label>
          </>
        ) : (
          <>
            <div className="fx-field">
              <span>帳號</span>
              {signedIn ? (
                <p className="fx-signed" role="status">✓ 已登入 {sub}</p>
              ) : (
                // stands in for the provider's own sign-in page, opened in the browser
                <button type="button" className="fx-control fx-login fx-hit" aria-describedby={loginError ? 'fx-login-error' : undefined}
                  onClick={() => { setSignedIn(true); setLoginError(false) }}>登入 {sub}</button>
              )}
            </div>
            {loginError && <p id="fx-login-error" className="fx-field-error">請先登入 {sub}</p>}
          </>
        )}
      </div>
      <button type="submit" className="fx-save">{old ? '儲存' : '新增'}</button>
    </form>
  )
}

function BlueprintDetail({ id, teamId, editing, onEdit, onGoneBlueprint, ...h }: Head & {
  id: string
  teamId: string
  editing: boolean
  onEdit: () => void
  /** Called once the blueprint is deleted, to put its sheet away. */
  onGoneBlueprint: () => void
}) {
  const w = useStore((s) => s.world)
  const act = useStore((s) => s.act)
  const bp = w.blueprints[id]
  if (!bp) return <Gone {...h} />
  // from the settings: everyone made from it, in every company
  const crew = (teamId ? teamReplicas(w, teamId) : Object.values(w.replicas)).filter((r) => r.blueprintId === bp.id)
  // anyone at all, in any company, keeps it
  const users = blueprintUsers(w, bp.id).length
  const remove = () => {
    onGoneBlueprint()
    act((x) => void deleteBlueprint(x, id))
  }
  return (
    <>
      <div className="fx-tools">
        <EditTool onClick={onEdit} open={editing} />
        <DeleteTool what="藍圖" onConfirm={remove} disabled={users > 0} why={`還有 ${users} 位員工使用這個藍圖，無法刪除`} />
      </div>
      <header className="fx-d-head fx-d-who">
        <BlueprintIcon look={bp.look} name={bp.name} size={52} />
        <Heading {...h}>{bp.name}</Heading>
      </header>
      <Section name="來源"><ul className="fx-src-list"><SourceRow source={bp.source} now={w.now} /></ul></Section>
      {bp.prompt && <Section name="提示詞"><p className="fx-d-text fx-d-quote">{bp.prompt}</p></Section>}
      {bp.comment && <Section name="備註"><p className="fx-d-text">{bp.comment}</p></Section>}
      <Section name="技能">
        {bp.skills.length === 0 ? <p className="fx-d-muted">沒有</p> : (
          <ul className="fx-src-list">
            {bp.skills.map((p, i) => (
              <SourceRow key={i} source={p.source} now={w.now}>
                <p className="fx-d-chips">
                  {p.include ? p.include.map((x) => <span key={x}>{x}</span>) : <span className="fx-chip-all">全部</span>}
                  {p.exclude.map((x) => <span key={x} className="fx-chip-out"><span className="fx-sr">排除 </span>{x}</span>)}
                </p>
              </SourceRow>
            ))}
          </ul>
        )}
      </Section>
      <Section name="工具">
        {bp.tools.length === 0 ? <p className="fx-d-muted">沒有</p> : (
          // in the order of TOOLS, whatever order they were allowed in
          <p className="fx-d-chips">{TOOLS.filter((t) => bp.tools.includes(t)).map((t) => <span key={t}>{TOOL_NAMES[t]}</span>)}</p>
        )}
      </Section>
      <Section name="使用中的員工">
        {crew.length === 0 ? <p className="fx-d-muted">沒有人</p> : (
          <ul className="fx-d-people">
            {crew.map((r) => <li key={r.id}><PixelFace look={r.look} name={r.name} size={26} /><b>{r.name}</b><span>{doingOf(w, r) ?? '沒有工作'}</span></li>)}
          </ul>
        )}
      </Section>
    </>
  )
}

/**
 * One place a blueprint reads from (`source` null: the blueprint's own repo), with whether its upstream
 * was found and how the last update went; `children` is what it brings, under it.
 */
function SourceRow({ source, now, children }: { source: BlueprintSource | LocalSkills | null; now: number; children?: React.ReactNode }) {
  const state = source?.kind === 'git' ? sourceState(source, now) : null
  return (
    <li className="fx-src">
      <p className="fx-src-head">
        {!source ? <span>藍圖本身</span> : source.kind === 'yaml' ? <span>{sourceText(source)}</span> : <code>{sourceText(source)}</code>}
        {source?.kind === 'git' && source.private && <span className="fx-d-muted">私有</span>}
        {source?.kind === 'local' && <span className="fx-d-muted">本機</span>}
        {state && <span className={`fx-src-state fx-src-${state.tone}`}>{state.label}</span>}
      </p>
      {state?.note && <p className={state.tone === 'bad' ? 'fx-src-note fx-src-note-bad' : 'fx-src-note'}>{state.note}</p>}
      {children}
    </li>
  )
}

/** Same repo at the same version: the one already known keeps what is known about its upstream. */
const keepSource = (old: Blueprint | undefined, next: GitSource) =>
  (old ? gitSources(old) : []).find((s) => s.repo === next.repo && s.ref === next.ref) ?? next

/**
 * A blueprint as saved: what was read or kept, with the look picked on the form, which wins over the one it
 * had, and whether it updates itself, as it was.
 */
export function blueprintOf(id: string, prev: Blueprint | undefined, look: Look, bp: Omit<Blueprint, 'id' | 'look' | 'autoUpdate'>): Blueprint {
  const { look: _was, ...rest } = bp as Partial<Blueprint>
  return { ...(rest as typeof bp), id, look, autoUpdate: prev?.autoUpdate ?? false }
}

/**
 * Add a blueprint (`id` null) or change one, from a GitHub repo or written out here as YAML. The repo is
 * typed as `owner/repo` or pasted as any GitHub address: a version in it (branch, tag or commit) moves to
 * the version field. With no version the default branch is used. The name follows the repo until it is
 * typed; a YAML blueprint names itself. Either way its icon is rolled at random. Nothing changes until it
 * is saved.
 */
function BlueprintEdit({ id, onDone, ...h }: Head & { id: string | null; onDone: () => void }) {
  const act = useStore((s) => s.act)
  const old = useStore((s) => (id ? s.world.blueprints[id] : undefined))
  const was = old?.source
  const [kind, setKind] = useState<'git' | 'yaml'>(was?.kind ?? 'git')
  const [repo, setRepo] = useState(was?.kind === 'git' ? was.repo.replace('git@github.com:', '') : '')
  const [ref, setRef] = useState(was?.kind === 'git' ? was.ref : '')
  const [text, setText] = useState(was?.kind === 'yaml' ? was.text : YAML_TEMPLATE)
  const [name, setName] = useState(old?.name ?? '')
  const [named, setNamed] = useState(!!old)
  // the face it is drawn with now, fixed, so the form shows the same one whatever name it goes by
  const [look, setLook] = useState<Look>(() => (old ? pinLook(old.look, old.name) : randomLook()))
  const [repoError, setRepoError] = useState(false)
  const [yamlError, setYamlError] = useState('')
  const repoField = useRef<HTMLInputElement>(null)
  const yamlField = useRef<HTMLTextAreaElement>(null)
  if (id && !old) return <Gone {...h} />
  const follow = (src: string) => {
    if (!named) setName((src.split(/[/\\:]/).filter(Boolean).pop() ?? '').replace(/\.git$/, ''))
  }
  // an address becomes owner/repo, and the version in it goes to the version field
  const takeRepo = (text: string) => {
    const g = parseGithub(text)
    if (!g) return false
    setRepo(g.repo)
    if (g.ref) setRef(g.ref)
    setRepoError(false)
    follow(g.repo)
    return true
  }
  const hash = () => Math.random().toString(16).slice(2, 9)
  const keep = (bp: Omit<Blueprint, 'id' | 'look' | 'autoUpdate'>) => {
    act((x) => {
      if (id && !x.blueprints[id]) return
      const key = id ?? `bp${++x.seq}`
      x.blueprints[key] = blueprintOf(key, x.blueprints[key], look, bp)
    })
    onDone()
  }
  const save = (e: React.FormEvent) => {
    e.preventDefault()
    const now = useStore.getState().world.now
    if (kind === 'yaml') {
      const parsed = parseBlueprintYaml(text, now, hash)
      if (!parsed.ok) {
        setYamlError(parsed.line ? `第 ${parsed.line} 行：${parsed.error}` : parsed.error)
        yamlField.current?.focus()
        return
      }
      const skills = parsed.value.skills.map((p) => (p.source?.kind === 'git' ? { ...p, source: keepSource(old, p.source) } : p))
      return keep({ ...parsed.value, skills, source: { kind: 'yaml', text } })
    }
    const g = parseGithub(repo)
    if (!g) {
      setRepoError(true)
      repoField.current?.focus()
      return
    }
    const version = (g.ref || ref).trim()
    const commit = hash()
    const source = keepSource(old, {
      kind: 'git', repo: `git@github.com:${g.repo}`, ref: version, commit, latestRef: version, latest: commit, private: false,
      upstream: true, update: { at: now, ok: true },
    })
    // the same repo and version: what it was read as stands
    if (old && was === source) return keep({ ...old, name: name.trim() })
    // the prompt, skills and tools are the repo's own; the prototype has no files to read them from.
    // The tools start read and write only.
    keep({
      name: name.trim(), source, prompt: '（從 AGENTS.md 讀取）', comment: '',
      skills: [{ source: null, include: ['code-review', 'tdd', 'summarize'], exclude: [] }], tools: ['readFile', 'writeFile'],
    })
  }
  return (
    <form className="fx-d-form" onSubmit={save}>
      <header className="fx-d-head fx-d-who">
        <BlueprintIcon look={look} name={(kind === 'git' ? name : '') || old?.name || '新藍圖'} size={52} />
        <Heading {...h}>{old ? `編輯 ${old.name}` : '新增員工藍圖'}</Heading>
      </header>
      <div className="fx-fields">
        <div className="fx-field fx-field-top">
          <span>樣式</span>
          <div className="fx-look">
            <BlueprintIcon look={look} name="藍圖樣式" size={96} />
            <Reroll onClick={() => setLook(randomLook())} label="隨機樣式" />
          </div>
        </div>
        <Select label="來源" value={kind} options={['git', 'yaml']} labelOf={(x) => (x === 'git' ? 'GitHub' : 'YAML')}
          onChange={(x) => setKind(x as 'git' | 'yaml')} />
        {kind === 'git' ? (
          <>
            <label className="fx-field">
              <span>Repo</span>
              <input ref={repoField} className="fx-control" value={repo} required spellCheck={false} autoComplete="off"
                placeholder="owner/repo" aria-invalid={repoError || undefined} aria-describedby={repoError ? 'fx-repo-error' : undefined}
                onChange={(e) => { setRepo(e.target.value); setRepoError(false); follow(e.target.value) }}
                onPaste={(e) => { if (takeRepo(e.clipboardData.getData('text'))) e.preventDefault() }}
                onBlur={() => repo.trim() && takeRepo(repo)} />
            </label>
            {repoError && <p id="fx-repo-error" className="fx-field-error">請輸入 owner/repo 或 GitHub 網址</p>}
            <label className="fx-field">
              <span>版本</span>
              <input className="fx-control" value={ref} onChange={(e) => setRef(e.target.value)} spellCheck={false} autoComplete="off"
                placeholder="master / main" />
            </label>
            <label className="fx-field">
              <span>名稱</span>
              {/* not blank: spaces alone are no name */}
              <input className="fx-control" value={name} required pattern=".*\S.*" title="名稱不可為空"
                onChange={(e) => { setName(e.target.value); setNamed(true) }} />
            </label>
          </>
        ) : (
          <>
            <label className="fx-field fx-field-top">
              <span>YAML</span>
              <textarea ref={yamlField} className="fx-control fx-yaml" rows={18} value={text} required spellCheck={false}
                autoComplete="off" autoCapitalize="off" aria-invalid={yamlError ? true : undefined}
                aria-describedby={yamlError ? 'fx-yaml-error' : undefined}
                onChange={(e) => { setText(e.target.value); setYamlError('') }}
                // Tab indents, as in an editor; Esc still leaves
                onKeyDown={(e) => {
                  if (e.key !== 'Tab' || e.shiftKey) return
                  e.preventDefault()
                  const el = e.currentTarget
                  el.setRangeText('  ', el.selectionStart, el.selectionEnd, 'end')
                  setText(el.value)
                }} />
            </label>
            {yamlError && <p id="fx-yaml-error" className="fx-field-error">{yamlError}</p>}
          </>
        )}
      </div>
      <button type="submit" className="fx-save">{old ? '儲存' : '新增'}</button>
    </form>
  )
}

/** Roll a look again, at random: a die. */
export function Reroll({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button type="button" className="fx-control fx-reroll fx-hit" onClick={onClick} aria-label={label} title={label}>
      <svg viewBox="0 0 16 16" width="24" height="24" aria-hidden="true">
        <rect x="2.5" y="2.5" width="11" height="11" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <circle cx="5.6" cy="5.6" r="1.1" fill="currentColor" /><circle cx="10.4" cy="10.4" r="1.1" fill="currentColor" />
        <circle cx="8" cy="8" r="1.1" fill="currentColor" />
      </svg>
    </button>
  )
}

const NAMES = ['Nova', 'Orin', 'Pip', 'Quill', 'Rune', 'Sage', 'Tess', 'Uma', 'Vex', 'Wren', 'Yuki', 'Zed', 'Bo', 'Cleo', 'Dax', 'Eli']

/**
 * Hire someone (`id` null) or change an employee, as a draft: nothing changes until it is saved. Their look
 * (the face here and the figure in the office) can be rolled again at random.
 */
function CrewEdit({ id, teamId, onDone, ...h }: Head & { id: string | null; teamId: string; onDone: () => void }) {
  const w = useStore((s) => s.world)
  const act = useStore((s) => s.act)
  const r = id ? w.replicas[id] : undefined
  const first = Object.values(w.blueprints)[0]
  const [name, setName] = useState(() => r?.name ?? NAMES.find((n) => !Object.values(w.replicas).some((x) => x.name === n)) ?? 'Nova')
  const [bp, setBp] = useState(r?.blueprintId ?? first?.id ?? '')
  const [model, setModel] = useState(r?.model ?? DEFAULT_MODEL)
  const [effort, setEffort] = useState<Effort>(r?.effort ?? 'medium')
  const [look, setLook] = useState<Look>(() => r?.look ?? randomLook())
  if (id && !r) return <Gone {...h} />
  const save = (e: React.FormEvent) => {
    e.preventDefault()
    act((x) => {
      if (!id) return void hire(x, teamId, bp, name.trim(), look, { model, effort })
      const y = x.replicas[id]
      if (!y) return
      Object.assign(y, { name: name.trim(), blueprintId: bp, model, effort, look })
    })
    onDone()
  }
  return (
    <form className="fx-d-form" onSubmit={save}>
      <header className="fx-d-head fx-d-who">
        <PixelFace look={look} name={name || '?'} size={52} />
        <Heading {...h}>{r ? `編輯 ${r.name}` : '新增員工'}</Heading>
      </header>
      <div className="fx-fields">
        <div className="fx-field fx-field-top">
          <span>外型</span>
          <div className="fx-look">
            <Standee look={look} seed={look.style ?? seedOf(r?.id ?? '')} />
            <Reroll onClick={() => setLook(randomLook())} label="隨機外型" />
          </div>
        </div>
        <label className="fx-field">
          <span>名字</span>
          <input className="fx-control" value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <Select label="藍圖" value={bp} options={Object.keys(w.blueprints)} labelOf={(x) => w.blueprints[x]?.name ?? x} onChange={setBp} />
        <Select label="模型" value={model} options={modelsOf(w)} onChange={setModel} />
        <Select label="思考等級" value={effort} options={EFFORTS.map((x) => x.id)} labelOf={(x) => effortName(x as Effort)}
          onChange={(x) => setEffort(x as Effort)} />
      </div>
      <button type="submit" className="fx-save" disabled={!name.trim() || !bp}>{r ? '儲存' : '新增'}</button>
    </form>
  )
}

/**
 * Let an employee go. Someone has to take over first: the tasks they own, the steps they are on and
 * whatever they are in the middle of all go to the one picked here, and only then are they let go.
 */
function Fire({ id, onDone, ...h }: Head & { id: string; onDone: () => void }) {
  const w = useStore((s) => s.world)
  const act = useStore((s) => s.act)
  const [heir, setHeir] = useState<string | null>(null)
  const r = w.replicas[id]
  if (!r) return <Gone {...h} />
  const others = teamReplicas(w, r.teamId).filter((x) => x.id !== id)
  // the two ends follow the owner, so they are already in the tasks owned
  const steps = staffedOn(w, r).filter(({ task, n }) => !isFixed(task.workflow, n.id))
  const owned = Object.values(w.tasks)
    .filter((t) => t.ownerId === id && t.stage !== 'done' && t.stage !== 'cancelled')
    .sort((a, b) => a.number - b.number)
  const go = (e: React.FormEvent) => {
    e.preventDefault()
    if (!heir) return
    onDone()
    act((x) => fire(x, id, heir))
  }
  return (
    <form className="fx-d-form" onSubmit={go}>
      <header className="fx-d-head fx-d-who">
        <PixelFace look={r.look} name={r.name} size={52} />
        <Heading {...h}>解僱 {r.name}</Heading>
      </header>
      <Section name="要交接的工作">
        {owned.length + steps.length === 0 ? <p className="fx-d-muted">沒有</p> : (
          <p className="fx-d-chips">
            {owned.map((t) => <span key={t.id}>#{t.number} 負責人</span>)}
            {steps.map(({ task, n }) => <span key={task.id + n.id}>#{task.number} › {stepName(task.workflow, n.id)}</span>)}
          </p>
        )}
      </Section>
      <Section name="交接給">
        <div className="fx-d-groups">
          {byBlueprint(w, others).map(({ bp, list }) => (
            <section key={bp.id} className="fx-d-group" aria-label={bp.name}>
              <h4>{bp.name}<span className="fx-count">{list.length}</span></h4>
              <ul className="fx-list">
                {list.map((x) => (
                  <li key={x.id}>
                    <button type="button" className="fx-row fx-hit" aria-pressed={heir === x.id} onClick={() => setHeir(x.id)}>
                      <PixelFace look={x.look} name={x.name} size={26} />
                      <span className="fx-row-main"><b>{x.name}</b><span>{mindOf(x)}</span></span>
                      <span className="fx-check" aria-hidden="true">{heir === x.id ? '✓' : ''}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </Section>
      <button type="submit" className="fx-save" disabled={!heir}>交接並解僱</button>
    </form>
  )
}

/**
 * Close the company, after saying what goes with it. Its project folder stays unless the box is ticked.
 */
function Disband({ teamId, onDone, ...h }: Head & { teamId: string; onDone: () => void }) {
  const w = useStore((s) => s.world)
  const act = useStore((s) => s.act)
  const [removeFiles, setRemoveFiles] = useState(false)
  const team = w.teams[teamId]
  if (!team) return <Gone {...h} />
  const people = teamReplicas(w, teamId).length
  const open = Object.values(w.tasks).filter((t) => t.teamId === teamId && t.stage !== 'done' && t.stage !== 'cancelled').length
  const go = (e: React.FormEvent) => {
    e.preventDefault()
    onDone()
    act((x) => deleteTeam(x, teamId, { removeFiles }))
  }
  return (
    <form className="fx-d-form" onSubmit={go}>
      <header className="fx-d-head">
        <Heading {...h}>解散 {team.name}</Heading>
        <p className="fx-d-meta"><span>{people} 位員工</span><span>{open} 個未完成的任務</span></p>
      </header>
      <button type="button" role="checkbox" aria-checked={removeFiles} className="fx-row fx-row-plain fx-hit fx-d-toggle"
        onClick={() => setRemoveFiles(!removeFiles)}>
        <span className="fx-row-main"><b>同時刪除本地檔案</b><span><code>{team.folder}</code></span></span>
        <span className="fx-box" aria-hidden="true">{removeFiles ? '✓' : ''}</span>
      </button>
      <button type="submit" className="fx-save fx-danger">解散公司</button>
    </form>
  )
}

/**
 * A new task: what it is, which flow it runs, and who works each step this time. The staff starts as the
 * last task's on that flow; a step's note opens a sheet to change it. It can start once every step has
 * someone.
 */
function NewTask({ teamId, open, onOpen, onDone, ...h }: Head & {
  teamId: string
  open: string | null
  onOpen: (nodeId: string) => void
  onDone: () => void
}) {
  const w = useStore((s) => s.world)
  const act = useStore((s) => s.act)
  const draft = useDraft((s) => s.draft)
  const flows = Object.values(w.workflows).filter((x) => x.teamId === teamId)
  // a fresh draft on the company's default flow, dropped when the sheet goes
  useEffect(() => {
    const s = useStore.getState().world
    const workflowId = s.teams[teamId]?.defaultWorkflowId ?? ''
    useDraft.setState({ draft: { title: '', description: '', workflowId, ...lastStaff(s, teamId, workflowId) } })
    return () => useDraft.setState({ draft: null })
  }, [teamId])
  if (!draft) return null
  const wf = w.workflows[draft.workflowId]
  const missing = unstaffed(w, draft)
  const ready = draft.title.trim() && wf && missing.length === 0
  const start = (e: React.FormEvent) => {
    e.preventDefault()
    if (!ready || !draft.ownerId) return
    const { title, description, workflowId, staff, ownerId, images } = draft
    act((x) => void createTask(x, { teamId, title: title.trim(), description: description.trim(), workflowId, staff, ownerId, images }))
    onDone()
  }
  // a screenshot pasted into either text box comes in as a picture
  const paste = (e: React.ClipboardEvent) => {
    const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'))
    if (!files.length) return
    e.preventDefault()
    void addImages(files)
  }
  const images = draft.images ?? []
  return (
    <form className="fx-d-form" onSubmit={start} onPaste={paste}>
      <header className="fx-d-head"><Heading {...h}>新增任務</Heading></header>
      <div className="fx-fields">
        <label className="fx-field">
          <span>標題</span>
          <input className="fx-control" value={draft.title} onChange={(e) => editDraft(() => ({ title: e.target.value }))} required />
        </label>
        <label className="fx-field fx-field-top">
          <span>說明</span>
          <textarea className="fx-control" rows={3} value={draft.description} placeholder="可直接貼上截圖"
            onChange={(e) => editDraft(() => ({ description: e.target.value }))} />
        </label>
        <div className="fx-field fx-field-top" role="group" aria-labelledby="fx-images-label">
          <span id="fx-images-label">附圖</span>
          <div className="fx-thumbs">
            {images.map((im, i) => (
              <figure key={i} className="fx-thumb">
                <img src={im.url} alt={im.name} />
                <button type="button" className="fx-thumb-x" aria-label={`移除 ${im.name}`}
                  onClick={() => editDraft((d) => ({ images: (d.images ?? []).filter((_, j) => j !== i) }))}>×</button>
              </figure>
            ))}
            <label className="fx-thumb fx-thumb-add fx-hit">
              <span aria-hidden="true">＋</span>
              <input type="file" accept="image/*" multiple className="fx-sr" aria-label="加入圖片"
                onChange={(e) => { void addImages(e.target.files ?? []); e.target.value = '' }} />
            </label>
          </div>
        </div>
        <Select label="流程" value={draft.workflowId} options={flows.map((x) => x.id)} labelOf={(x) => w.workflows[x]?.name ?? x}
          onChange={(id) => editDraft((d) => {
            const last = lastStaff(useStore.getState().world, teamId, id)
            return { workflowId: id, ...last, ownerId: d.ownerId ?? last.ownerId }
          })} />
        {wf && <OwnerField wf={wf} draft={draft} open={open} onOpen={onOpen} />}
      </div>
      {wf && (
        <Section name="人員">
          {draft.from !== null && <p className="fx-d-muted">沿用 #{draft.from} 的配置</p>}
          <div className="fx-flow">
            <FlowNotes wf={wf} staff={(n) => draftStaff(w, draft, n)} open={open} onOpen={onOpen}
              canOpen={(n) => !isFixed(wf, n)} />
          </div>
        </Section>
      )}
      <p className="fx-d-actions">
        <button type="submit" className="fx-save" disabled={!ready}>開始</button>
        {wf && <Missing draft={draft} missing={missing.length} />}
      </p>
    </form>
  )
}

/** Who works one step of the new task. Several can, and one employee can work several steps. */
function StaffPick({ node, teamId, onDone, ...h }: Head & { node: string; teamId: string; onDone: () => void }) {
  const w = useStore((s) => s.world)
  const draft = useDraft((s) => s.draft)
  const wf = draft && draftFlow(w, draft)
  // 整理需求 and 驗收 are the owner's: picking for either picks the one owner
  const owner = !!wf && isFixed(wf, node)
  const [picked, setPicked] = useState<string[]>(() => (draft ? draftStaff(w, draft, node) : []))
  const n = wf && nodeOf(wf, node)
  if (!wf || !n) return <Gone {...h} />
  const crew = teamReplicas(w, teamId)
  const toggle = (id: string) => setPicked((p) => (owner ? [id] : p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))
  const save = (e: React.FormEvent) => {
    e.preventDefault()
    // keep the team's order, so faces line up the same way everywhere
    if (owner) editDraft(() => ({ ownerId: picked[0] ?? null }))
    else editDraft((d) => ({ staff: { ...d.staff, [node]: crew.map((r) => r.id).filter((id) => picked.includes(id)) } }))
    onDone()
  }
  const ends = wf.nodes.filter((x) => isFixed(wf, x.id)).map((x) => x.name).join('・')
  return (
    <form className="fx-d-form" onSubmit={save}>
      <header className="fx-d-head">
        <Heading {...h}>{owner ? '任務負責人' : stepName(wf, node)}</Heading>
        <p className="fx-d-meta">
          {owner ? <span>{ends}</span> : <span>{wf.name}</span>}
          {!owner && picked.length > 1 && <span>任務分派：{ASSIGN[n.assignment]}</span>}
        </p>
      </header>
      {n.prompt && !owner && <p className="fx-d-text fx-d-quote">{n.prompt}</p>}
      <div className="fx-d-groups">
        {byBlueprint(w, crew).map(({ bp, list }) => (
          <section key={bp.id} className="fx-d-group" aria-label={bp.name}>
            <h4>{bp.name}<span className="fx-count">{list.length}</span></h4>
            <ul className="fx-list">
              {list.map((r) => {
                const on = picked.includes(r.id)
                return (
                  <li key={r.id}>
                    <button type="button" className="fx-row fx-hit" aria-pressed={on} onClick={() => toggle(r.id)}>
                      <PixelFace look={r.look} name={r.name} size={26} />
                      <span className="fx-row-main"><b>{r.name}</b><span>{mindOf(r)}</span></span>
                      <span className="fx-check" aria-hidden="true">{on ? '✓' : ''}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
      </div>
      <button type="submit" className="fx-save" disabled={picked.length === 0}>確定</button>
    </form>
  )
}

/** Change a task: its title, what it asks, and who works each step from here on. */
function TaskEdit({ id, teamId, open, onOpen, onDone, ...h }: Head & {
  id: string
  teamId: string
  open: string | null
  onOpen: (nodeId: string) => void
  onDone: () => void
}) {
  const w = useStore((s) => s.world)
  const act = useStore((s) => s.act)
  const draft = useDraft((s) => s.draft)
  useEffect(() => {
    const task = useStore.getState().world.tasks[id]
    if (!task) return
    const staff = Object.fromEntries(task.workflow.nodes.map((n) => [n.id, [...n.replicaIds]]))
    useDraft.setState({ draft: {
      title: task.title, description: task.description, workflowId: task.workflowId, staff, from: null, taskId: id, ownerId: task.ownerId,
    } })
    return () => useDraft.setState({ draft: null })
  }, [id])
  const task = w.tasks[id]
  if (!task) return <Gone {...h} />
  if (!draft) return null
  const missing = unstaffed(w, draft)
  const ready = draft.title.trim() && missing.length === 0
  const save = (e: React.FormEvent) => {
    e.preventDefault()
    if (!ready) return
    act((x) => {
      const t = x.tasks[id]
      if (!t) return
      t.title = draft.title.trim()
      t.description = draft.description.trim()
      for (const n of t.workflow.nodes) if (draft.staff[n.id]) n.replicaIds = [...draft.staff[n.id]]
      setOwner(t, draft.ownerId)
    })
    onDone()
  }
  return (
    <form className="fx-d-form" onSubmit={save}>
      <header className="fx-d-head"><Heading {...h}>編輯 #{task.number}</Heading></header>
      <div className="fx-fields">
        <label className="fx-field">
          <span>標題</span>
          <input className="fx-control" value={draft.title} onChange={(e) => editDraft(() => ({ title: e.target.value }))} required />
        </label>
        <label className="fx-field fx-field-top">
          <span>說明</span>
          <textarea className="fx-control" rows={3} value={draft.description} onChange={(e) => editDraft(() => ({ description: e.target.value }))} />
        </label>
        <OwnerField wf={task.workflow} draft={draft} open={open} onOpen={onOpen} />
      </div>
      <Section name="人員">
        <div className="fx-flow">
          <FlowNotes wf={task.workflow} staff={(n) => draftStaff(w, draft, n)} open={open} onOpen={onOpen}
            canOpen={(n) => !isFixed(task.workflow, n)} />
        </div>
      </Section>
      <p className="fx-d-actions">
        <button type="submit" className="fx-save" disabled={!ready}>儲存</button>
        <Missing draft={draft} missing={missing.length} />
      </p>
    </form>
  )
}

/**
 * The task's owner on a task being written: it opens the same sheet as the 整理需求 and 驗收 notes, which
 * the owner works.
 */
function OwnerField({ wf, draft, open, onOpen }: { wf: Workflow; draft: TaskDraft; open: string | null; onOpen: (nodeId: string) => void }) {
  const replicas = useStore((s) => s.world.replicas)
  const start = taskNodeOf(wf)?.id
  const r = draft.ownerId ? replicas[draft.ownerId] : undefined
  if (!start) return null
  return (
    <div className="fx-field">
      <span>任務負責人</span>
      <button type="button" className="fx-control fx-owner-pick" aria-expanded={!!open && isFixed(wf, open)} onClick={() => onOpen(start)}>
        {r ? <><PixelFace look={r.look} name={r.name} size={18} />{r.name}</> : <span className="fx-d-muted">選擇員工</span>}
      </button>
    </div>
  )
}

/** What still keeps a task from starting: its owner first, then the steps nobody works. */
function Missing({ draft, missing }: { draft: TaskDraft; missing: number }) {
  if (!draft.ownerId) return <span className="fx-d-muted">還沒有任務負責人</span>
  return missing > 0 ? <span className="fx-d-muted">還有 {missing} 步沒有人</span> : null
}

function FileIcon() {
  return (
    <svg className="fx-file" viewBox="0 0 16 16" width="22" height="22" aria-hidden="true">
      <path d="M3.5 1.5h6l3 3v10h-9z" fill="var(--clip)" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M9.5 1.5v3h3M5.5 8h5M5.5 10.5h5" fill="none" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  )
}

/** A file an employee handed on, as it reads. */
function DocDetail({ sub: subId, path, ...h }: Head & { sub: string; path: string }) {
  const w = useStore((s) => s.world)
  const sub = w.subTasks[subId]
  const task = sub && w.tasks[sub.taskId]
  if (!sub || !task) return <Gone {...h} />
  const step = stepName(task.workflow, sub.nodeId)
  const r = sub.replicaId ? w.replicas[sub.replicaId] : undefined
  const doc = docOf(task, step, sub, path)
  return (
    <>
      <header className="fx-d-head">
        <Heading {...h}>{path.split('/').pop()}</Heading>
        <p className="fx-d-meta">
          <code>{path}</code>
          <span>{step}{r ? ` · ${r.name}` : ''}</span>
          {sub.handoff && <code>{sub.handoff.commit}</code>}
        </p>
      </header>
      {/* the file itself, on a white sticky note */}
      <div className="fx-doc-note">
        {doc.lang === 'code' ? <pre className="fx-doc-code"><code>{doc.text}</code></pre> : <Markdown text={doc.text} />}
      </div>
    </>
  )
}

/** A picture added to a task, at full width. */
function ImageDetail({ task: taskId, index, ...h }: Head & { task: string; index: number }) {
  const task = useStore((s) => s.world.tasks[taskId])
  const im = task?.images[index]
  if (!task || !im) return <Gone {...h} />
  return (
    <>
      <header className="fx-d-head">
        <Heading {...h}>{im.name}</Heading>
        <p className="fx-d-meta"><span><span className="fx-task-no">#{task.number}</span>{task.title}</span></p>
      </header>
      <img className="fx-d-image" src={im.url} alt={im.name} />
    </>
  )
}

/** Just enough Markdown for a handed-on note: headings, bullets and paragraphs. */
function Markdown({ text }: { text: string }) {
  return (
    <div className="fx-doc">
      {text.split('\n\n').map((block, i) => {
        if (block.startsWith('# ')) return <h3 key={i} className="fx-doc-h1">{block.slice(2)}</h3>
        const [first, ...rest] = block.split('\n')
        const head = first.startsWith('## ') ? <h4>{first.slice(3)}</h4> : null
        const body = head ? rest : [first, ...rest]
        const items = body.filter((l) => l.startsWith('- '))
        return (
          <section key={i}>
            {head}
            {items.length ? <ul>{items.map((l, j) => <li key={j}>{l.slice(2)}</li>)}</ul> : body.length > 0 && <p>{body.join(' ')}</p>}
          </section>
        )
      })}
    </div>
  )
}

/** The round pencil in a sheet's upper right. */
function EditTool({ onClick, open }: { onClick: () => void; open?: boolean }) {
  return (
    <button type="button" className="fx-tool fx-hit" onClick={onClick} aria-expanded={open} aria-label="編輯" title="編輯">
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
        <path d="M2.5 13.5l.6-3L10.6 3l2.4 2.4-7.5 7.5z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        <path d="M9 4.6l2.4 2.4" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    </button>
  )
}

function BinIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path d="M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.8 9h6.4l.8-9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  )
}

/** A bin that asks first: the first press turns it into 確定刪除, the second deletes; looking away cancels. */
function DeleteTool({ what, onConfirm, disabled, why }: { what: string; onConfirm: () => void; disabled?: boolean; why?: string }) {
  const [asking, setAsking] = useState(false)
  return (
    <button type="button" className={asking ? 'fx-tool fx-tool-ask fx-hit' : 'fx-tool fx-hit'} disabled={disabled}
      onClick={() => (asking ? onConfirm() : setAsking(true))} onBlur={() => setAsking(false)}
      aria-label={asking ? `確定刪除這個${what}` : '刪除'} title={disabled ? why : asking ? undefined : '刪除'}>
      {asking ? '確定刪除' : (
        <BinIcon />
      )}
    </button>
  )
}

/**
 * Write a flow: a new one (`id` null) or one the company has. Every step is written right here, in a list
 * under the drawing; clicking a note goes to its place in the list. Nothing is kept until it is saved.
 */
function FlowEdit({ id, teamId, onDone, ...h }: Head & {
  id: string | null
  teamId: string
  onDone: () => void
}) {
  const w = useStore((s) => s.world)
  const act = useStore((s) => s.act)
  const draft = useFlowDraft((s) => s.draft)
  useEffect(() => {
    const s = useStore.getState().world
    const wf = id ? s.workflows[id] : undefined
    if (id && !wf) return
    const flow = wf ? structuredClone(wf) : blankFlow(teamId)
    useFlowDraft.setState({ draft: { flow, end: endOf(flow)?.id ?? '', isDefault: !!id && s.teams[teamId]?.defaultWorkflowId === id } })
    return () => useFlowDraft.setState({ draft: null })
  }, [id, teamId])
  // the list keeps the order it opened with, so a step does not jump away while its arrows change;
  // new steps go just before the end, as they do in the drawing
  const order = useRef<string[]>([])
  // the step to bring into view and type into, once it is in the list
  const [aim, setAim] = useState<string | null>(null)
  useEffect(() => {
    if (!aim) return
    const field = document.querySelector<HTMLElement>(`#fx-step-${CSS.escape(aim)} :is(input, textarea)`)
    field?.focus({ preventScroll: true })
    if (field instanceof HTMLInputElement) field.select()
    field?.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
    setAim(null)
  }, [aim])
  if (id && !w.workflows[id]) return <Gone {...h} />
  if (!draft) return null
  const { flow, end } = draft
  const wasDefault = !!id && w.teams[teamId]?.defaultWorkflowId === id
  const cut = loose(flow, end)
  const unnamed = flow.nodes.some((n) => !n.name.trim())
  if (!order.current.length) order.current = inOrder(flow).map((n) => n.id)
  else {
    // drop removed steps; put each new one just after the last step it comes from (or before the end)
    const list = order.current.filter((x) => flow.nodes.some((n) => n.id === x))
    for (const n of flow.nodes) {
      if (list.includes(n.id)) continue
      const from = Math.max(-1, ...inEdges(flow, n.id).map((e) => list.indexOf(e.from)))
      list.splice(from >= 0 ? from + 1 : Math.max(0, list.indexOf(end)), 0, n.id)
    }
    order.current = list
  }
  const ready = flow.name.trim() && cut.length === 0 && !unnamed
  // a step just made goes into the draft and stays put in the list; its note is clicked to go to it
  const made = ([next, step]: [Workflow, string]) => {
    if (step) editFlowDraft(() => ({ flow: next }))
  }
  const add = () => made(addStep(flow, end))
  const save = (e: React.FormEvent) => {
    e.preventDefault()
    if (!ready) return
    act((x) => {
      const wf = id ? x.workflows[id] : newWorkflow(x, teamId, '')
      if (!wf) return
      wf.name = flow.name.trim()
      wf.nodes = flow.nodes.map((n) => ({ ...structuredClone(n), name: n.name.trim(), prompt: n.prompt.trim() }))
      wf.edges = structuredClone(flow.edges)
      if (draft.isDefault && x.teams[teamId]) x.teams[teamId].defaultWorkflowId = wf.id
    })
    onDone()
  }
  return (
    <form className="fx-d-form" onSubmit={save}>
      <header className="fx-d-head"><Heading {...h}>{id ? `編輯 ${w.workflows[id].name}` : '新增流程'}</Heading></header>
      <div className="fx-fields">
        <label className="fx-field">
          <span>名稱</span>
          <input className="fx-control" value={flow.name} required
            onChange={(e) => editFlowDraft((d) => ({ flow: { ...d.flow, name: e.target.value } }))} />
        </label>
      </div>
      <button type="button" className="fx-row fx-row-plain fx-hit fx-d-toggle" aria-pressed={draft.isDefault} disabled={wasDefault}
        onClick={() => editFlowDraft((d) => ({ isDefault: !d.isDefault }))}>
        <span className="fx-row-main"><b>預設流程</b></span>
        <span className="fx-check" aria-hidden="true">{draft.isDefault ? '✓' : ''}</span>
      </button>
      <div className="fx-d-flowedit">
        <div className="fx-flow">
          <FlowNotes wf={flow} onOpen={setAim} edit={{
            end,
            canLink: (a, b) => canLink(flow, end, a, b),
            link: (a, b) => editFlowDraft((d) => ({ flow: link(d.flow, d.end, a, b) })),
            unlink: (e) => editFlowDraft((d) => ({ flow: unlink(d.flow, e) })),
            branch: (from) => made(branchStep(flow, end, from)),
            insert: (e) => made(insertStep(flow, e)),
            remove: (n) => editFlowDraft((d) => ({ flow: removeStep(d.flow, n) })),
          }} />
        </div>
        <button type="button" className="fx-task fx-task-new fx-flow-new fx-hit" onClick={add}>＋ 新增步驟</button>
        <ol className="fx-d-steps">
          {order.current.map((x) => <StepForm key={x} flow={flow} end={end} id={x} />)}
        </ol>
      </div>
      <p className="fx-d-actions">
        <button type="submit" className="fx-save" disabled={!ready}>{id ? '儲存' : '建立'}</button>
        {cut.length > 0 && <span className="fx-d-muted">{cut.map((n) => n.name.trim() || '沒有名稱的步驟').join('、')} 沒有接上</span>}
        {unnamed && <span className="fx-d-muted">有步驟沒有名稱</span>}
      </p>
    </form>
  )
}

/** One step of the flow being written, in the list under its drawing: every change goes into the draft at once. */
function StepForm({ flow, end, id }: { flow: Workflow; end: string; id: string }) {
  const n = nodeOf(flow, id)
  if (!n) return null
  const middle = isMiddle(flow, end, id)
  const isEnd = n.kind !== 'task' && !middle
  const next = outEdges(flow, id).map((e) => e.to)
  const choices = isEnd ? [] : nextChoices(flow, end, id)
  const before = inEdges(flow, id).length
  const put = (x: Partial<typeof n>) => editFlowDraft((d) => {
    const cur = nodeOf(d.flow, id)
    return cur ? { flow: putStep(d.flow, { ...cur, ...x }) } : {}
  })
  const toggle = (to: string) => editFlowDraft((d) => {
    const cur = nodeOf(d.flow, id)
    const now = outEdges(d.flow, id).map((e) => e.to)
    return cur ? { flow: putStep(d.flow, cur, now.includes(to) ? now.filter((x) => x !== to) : [...now, to]) } : {}
  })
  return (
    <li id={`fx-step-${id}`} className={`fx-step-form fx-step-note${noteCls(flow, id)}`}>
      <div className="fx-step-head">
        {middle
          ? <input className="fx-control fx-step-name" aria-label="步驟名稱" placeholder="步驟名稱" value={n.name} onChange={(e) => put({ name: e.target.value })} />
          : <h4>{n.name}</h4>}
        {middle && <DeleteTool what="步驟" onConfirm={() => editFlowDraft((d) => ({ flow: removeStep(d.flow, id) }))} />}
      </div>
      {!middle && <Owner />}
      <div className="fx-fields">
        {middle && (
          <>
            {/* a discussion has its own fixed instructions, and is held by one employee, so everyone working
                it is not offered; back to work, it starts with no instructions */}
            <Select label="種類" value={n.kind} options={Object.keys(KINDS)} labelOf={(x) => KINDS[x as keyof typeof KINDS]}
              onChange={(x) => put(x === 'talk'
                ? { kind: 'talk', prompt: TALK_PROMPT, ...(n.assignment === 'everyone' ? { assignment: 'firstAvailable' as const } : {}) }
                : { kind: 'work', prompt: '' })} />
            {n.kind !== 'talk' && (
              <label className="fx-field fx-field-top">
                <span>Prompt</span>
                <textarea className="fx-control" rows={2} value={n.prompt} onChange={(e) => put({ prompt: e.target.value })} />
              </label>
            )}
            <Select label="任務分派" value={n.assignment} options={Object.keys(ASSIGN).filter((x) => n.kind !== 'talk' || x !== 'everyone')}
              labelOf={(x) => ASSIGN[x as keyof typeof ASSIGN]} onChange={(x) => put({ assignment: x as typeof n.assignment })} />
          </>
        )}
        {before > 1 && (
          <Select label="開始條件" value={n.join} options={Object.keys(JOIN)} labelOf={(x) => JOIN[x as keyof typeof JOIN]}
            onChange={(x) => put({ join: x as typeof n.join })} />
        )}
        {next.length > 1 && (
          <Select label="交接" value={n.handoff} options={Object.keys(HANDOFF)} labelOf={(x) => HANDOFF[x as keyof typeof HANDOFF]}
            onChange={(x) => put({ handoff: x as typeof n.handoff })} />
        )}
        {!isEnd && (
          <div className="fx-field fx-field-top" role="group" aria-label={`${n.name || '這一步'}的下一步`}>
            <span>下一步</span>
            <div className="fx-d-picks">
              {choices.map((c) => (
                <button key={c.id} type="button" className="fx-hit" aria-pressed={next.includes(c.id)} onClick={() => toggle(c.id)}>
                  {next.includes(c.id) && <span aria-hidden="true">✓ </span>}{c.name.trim() || '沒有名稱'}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </li>
  )
}

/** A step is finished once it has run and every live sub-task at it is complete. */
function stepDone(subs: SubTask[], nodeId: string) {
  const at = subs.filter((s) => s.nodeId === nodeId)
  return at.length > 0 && at.every((s) => s.status === 'complete')
}
