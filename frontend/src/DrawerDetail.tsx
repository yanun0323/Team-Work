import { attachable, FileAttachment, isImage, MAX_ATTACHMENTS, readAttachments, splitAttachments } from './attachments'
// The detail sheets: anything in the company file or the settings that can be opened (a task and its sub-tasks,
// a flow and its steps, an employee, a blueprint, importing a blueprint) is shown on a sheet taped over the upper left of the map. Sheets stack: editing an employee
// tapes an edit sheet over theirs, a little lower and to the right, and clicking the strip of the sheet
// below that still shows puts the top one away unsaved. They read the live world.

import { colon, listOf, tr, trRecorded } from './core/i18n'
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { isFixed, nodeOf } from './core/domain/graph'
import { blueprintUsers, gitSources, statusOf, subsOf } from './core/domain/sim'
import { TOOLS, type Blueprint, type BlueprintSource, type GitSource, type LocalSkills, type Look, type MemoryEntry, type ProviderKind, type Replica, type SubTask, type Tool, type Workflow, type World } from './core/domain/types'
import { sourceState, sourceText, toolName } from './source'
import { flowList, activity, fmtClock, fmtTokens, layers, inEdges, lastSub, logText, outEdges, taskLines, teamReplicas, useStickToBottom } from './core/model'
import { useLiveText } from './core/live'
import { useStore } from './core/store'
import { PixelFace } from './core/voxel/PixelFace'
import { BlueprintIcon, pinLook } from './BlueprintIcon'
import { BlueprintSelect, CrewSelect, mineAndBuiltIn, ToolNotes } from './Pickers'
import { seedOf } from './People'
import { Standee } from './Standee'
import { ordered, usePrefs, type LogOrder } from './prefs'
import { ClaudeAccount } from './ClaudeAccount'
import { Markdown, MarkdownLine } from './Markdown'
import { Select, Switcher, WaitBadge } from './Controls'
import { FlowNotes, FlowPreview, openCard } from './FlowNotes'
import { copyDraft, draftFlow, draftStaff, editDraft, lastFlowId, lastStaff, ownerOnEveryStep, unstaffed, useDraft, type TaskDraft } from './draft'
import { byBlueprint, DEFAULT_EFFORT, effortsOf, mindOf, modelGroups, modelsOf, randomLook } from './crew'
import { docOf, outputFile, type Doc } from './doc'
import { MOCK } from './core/mode'
import { parseGithub } from './github'
import { blueprintToYaml } from './blueprintYaml'
import { blocked } from './prereqs'
import { Prereqs, usePrereqs } from './PrereqStamps'
import { MentionBox } from './MentionBox'
import { newSkillRow, skillPacksOf, skillRowsOf, type SkillRow } from './blueprintForm'
import { authLabel, mockThinking, PROVIDER_KINDS, providerUrl, SUBSCRIPTIONS } from './providers'
import { talking } from './core/domain/sim'
import { fixedSteps, isPreset } from './core/data/presets'
import type { TalkEnd } from './core/domain/types'
import { addProvider, providerUsers, updateProvider, type ProviderLogin, DEFAULT_MODEL, RESOLVE_TIME, costLimit, taskTokens } from './core/domain/sim'
import { readHandedFile, request } from './core/backend'
import { attempt, createTask, deleteBlueprint, deleteMemory, editMemory, deleteProvider, deleteTask, deleteTeam, deleteWorkflow, duplicateWorkflow, endTalk, fire, hire, mergeTask, pauseTask, resolveReview, resumeTask, returnTask, saveBlueprint, saveWorkflow, sayInTalk, updateReplica, updateTask } from './core/ops'
import { SubscriptionLogin } from './SubscriptionLogin'
import { ChatSheet, type ChatTaskSeed } from './ChatSheet'
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
  /** With copyOf, the sheet starts filled in from that task. */
  | { kind: 'newTask'; copyOf?: string; seed?: ChatTaskSeed }
  | { kind: 'chat'; id: string }
  | { kind: 'newChat' }
  | { kind: 'staff'; node: string }
  | { kind: 'taskEdit'; id: string }
  | { kind: 'doc'; sub: string; path: string }
  | { kind: 'image'; task: string; index: number }
  | { kind: 'flowEdit'; id: string }
  | { kind: 'newFlow' }
  /** With copyOf, the sheet starts filled in from that blueprint. */
  | { kind: 'newBlueprint'; copyOf?: string }
  | { kind: 'provider'; id: string }
  | { kind: 'providerEdit'; id: string }
  | { kind: 'newProvider' }
  | { kind: 'blueprintEdit'; id: string }
  | { kind: 'disband' }

export const itemKey = (x: Item) =>
  x.kind === 'newTask' ? `newTask:${x.copyOf ?? (x.seed ? 'chat' : '')}` : x.kind === 'newBlueprint' ? `newBlueprint:${x.copyOf ?? ''}` : x.kind === 'newChat' || x.kind === 'newFlow' || x.kind === 'newCrew' || x.kind === 'newProvider' || x.kind === 'disband' ? x.kind : x.kind === 'staff' ? `${x.kind}:${x.node}` : x.kind === 'doc' ? `doc:${x.sub}:${x.path}` : x.kind === 'image' ? `image:${x.task}:${x.index}` : `${x.kind}::${x.id}`

const STATUS = { todo: '待辦', progressing: '進行中', review: '待回覆', complete: '完成' } as const
const ASSIGN = { firstAvailable: '誰有空誰做', everyone: '每個人都做' } as const
const HANDOFF = { pickOne: '交給其中一個下一步', all: '交給所有下一步' } as const
const JOIN = { any: '任一個前一步完成就開始', all: '所有前一步都完成才開始' } as const
/** What a step in the middle of a flow can be. */
const KINDS = { work: '交給員工執行工作', talk: '和員工討論' } as const
/** The last lines of a log worth showing on a sheet this size. */
const LOG_LINES = 40

/** How far across each sheet in the stack sits, from the left (0) to right beside the company file (1). */
const SHEET_ACROSS = [0, 1, 1 / 3, 2 / 3]

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
      style={{ '--depth': depth, '--across': SHEET_ACROSS[depth] ?? 0 } as CSSProperties} aria-labelledby={id}
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
              copying={above?.kind === 'newTask'} onCopy={() => onPush({ kind: 'newTask', copyOf: item.id })}
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
            <FlowDetail id={item.id} title={title} tid={id} editing={above?.kind === 'flowEdit'}
              onEdit={() => onPush({ kind: 'flowEdit', id: item.id })} onGoneFlow={onDone} />
          )}
          {(item.kind === 'flowEdit' || item.kind === 'newFlow') && (
            <FlowEdit id={item.kind === 'flowEdit' ? item.id : null} title={title} tid={id} onDone={onDone} />
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
              copying={above?.kind === 'newBlueprint'} onEdit={() => onPush({ kind: 'blueprintEdit', id: item.id })}
              onCopy={() => onPush({ kind: 'newBlueprint', copyOf: item.id })} onGoneBlueprint={onDone} />
          )}
          {(item.kind === 'blueprintEdit' || item.kind === 'newBlueprint') && (
            <BlueprintEdit id={item.kind === 'blueprintEdit' ? item.id : null} copyOf={item.kind === 'newBlueprint' ? item.copyOf : undefined}
              title={title} tid={id} onDone={onDone} />
          )}
          {(item.kind === 'crewEdit' || item.kind === 'newCrew') && (
            <CrewEdit id={item.kind === 'crewEdit' ? item.id : null} teamId={teamId} title={title} tid={id} onDone={onDone} />
          )}
          {item.kind === 'fire' && <Fire id={item.id} title={title} tid={id} onDone={onClear} />}
          {item.kind === 'newTask' && (
            <NewTask teamId={teamId} copyOf={item.copyOf} seed={item.seed} title={title} tid={id} open={above?.kind === 'staff' ? above.node : null}
              onOpen={(node) => onPush({ kind: 'staff', node })} onDone={onDone} />
          )}
          {(item.kind === 'chat' || item.kind === 'newChat') && (
            <ChatSheet id={item.kind === 'chat' ? item.id : undefined} teamId={teamId} title={title} tid={id} creating={above?.kind === 'newTask'}
              onTask={(seed) => onPush({ kind: 'newTask', seed })} onFork={(x) => onPush({ kind: 'chat', id: x })} onGoneChat={onDone} />
          )}
          {item.kind === 'disband' && <Disband teamId={teamId} title={title} tid={id} onDone={onDone} />}
          {item.kind === 'staff' && <StaffPick node={item.node} teamId={teamId} title={title} tid={id} onDone={onDone} />}
        </div>
      </div>
      {covered && !leaving && <button type="button" className="fx-detail-cover" aria-label={tr('收起上面那張，回到這張')} onClick={onBack} />}
    </aside>
  )
}

type Title = React.RefObject<HTMLHeadingElement | null>
export type Head = { title: Title; tid: string }

export function Heading({ title, tid, children }: Head & { children: React.ReactNode }) {
  return <h2 id={tid} ref={title} tabIndex={-1}>{children}</h2>
}

export function Gone(h: Head) {
  return <Heading {...h}>{tr('已經不在了')}</Heading>
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
  if (!lines.length) return <p className="fx-d-muted">{tr('還沒有紀錄')}</p>
  return (
    <ol className="fx-d-log" reversed={order === 'newestFirst' || undefined}>
      {ordered(lines, order).map((l, i) => (
        <li key={i} className={`fx-d-log-${l.kind}`}>
          <time>{fmtClock(l.at)}</time>
          {l.who}
          {l.node && <b>{l.node}</b>}
          {/* the user's own replies, merges and send-backs */}
          {l.kind === 'human' && <strong className="fx-d-log-user">{tr('使用者')}</strong>}
          {/* what an employee says or thinks is Markdown; tool calls and the user's own words are as they are */}
          {l.kind === 'say' || l.kind === 'think' ? <div className="fx-d-log-text"><Markdown text={l.text} /></div> : <span>{l.text}</span>}
        </li>
      ))}
    </ol>
  )
}

function Bar({ value }: { value: number }) {
  return <span className="fx-d-bar" role="img" aria-label={`${Math.round(value * 100)}%`}><i style={{ width: `${value * 100}%` }} /></span>
}

/** A task someone asked for. The sub-tasks the employees made for it are listed here and open on their own sheet. */
function TaskDetail({ id, open, onOpen, flowOpen, onFlow, editing, onEdit, copying, onCopy, onGoneTask, crew, onCrew, image, onImage, ...h }: Head & {
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
  /** Whether a new task copied from this one is the sheet above, and how to open one. */
  copying: boolean
  onCopy: () => void
  /** Called once the task is deleted, to put its sheet away. */
  onGoneTask: () => void
}) {
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
    ...taskLines(subs).map((l) => ({ ...l, text: logText(l), node: stepName(task.workflow, l.s.nodeId) })),
    ...(task.merge?.log ?? []).map((l) => ({ ...l, node: tr('合併') })),
  ].sort((a, b) => a.at - b.at).slice(-LOG_LINES)
  return (
    <>
      <div className="fx-tools">
        <EditTool onClick={onEdit} open={editing} />
        <button type="button" className="fx-tool fx-hit" onClick={onCopy} aria-expanded={copying} aria-label={tr('複製')} title={tr('複製')}>
          <CopyIcon />
        </button>
        <button type="button" className="fx-tool fx-hit" disabled={!canPause} aria-pressed={task.paused}
          onClick={() => act((x) => (task.paused ? resumeTask(x, id) : pauseTask(x, id)))}
          aria-label={task.paused ? tr('繼續') : tr('暫停')} title={task.paused ? tr('繼續') : tr('暫停')}>
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            {task.paused ? <path d="M5 3l8 5-8 5z" fill="currentColor" /> : <path d="M5 3v10M11 3v10" stroke="currentColor" strokeWidth="2" />}
          </svg>
        </button>
        <DeleteTool what={tr('任務')} onConfirm={remove} />
      </div>
      <header className="fx-d-head">
        <Heading {...h}><span className="fx-task-no">#{task.number}</span>{task.title}</Heading>
        <p className="fx-d-sub">
          <span className="fx-branch" title={tr('任務分支')}><BranchIcon /><span className="fx-sr">{tr('任務分支 ')}</span><code>{task.branch}</code></span>
        </p>
        <p className="fx-d-meta">
          {/* one state: paused or merging says more than the column it sits in */}
          <span className="fx-pill">{task.stage === 'cancelled' ? tr('已停止') : task.paused ? tr('已暫停') : task.stage === 'merging' ? tr('合併中') : tr(STATUS[status])}</span>
          {owner && (
            <span className="fx-d-owner">{tr('負責人')}
              <button type="button" className="fx-hit" aria-expanded={crew === owner.id} onClick={() => onCrew(owner.id)}>
                <PixelFace look={owner.look} name={owner.name} size={18} />{owner.name}
              </button>
            </span>
          )}
          <span>Token {fmtTokens(taskTokens(w, task))}</span>
        </p>
      </header>
      {task.description && <div className="fx-d-text-md"><Markdown text={task.description} /></div>}
      {task.images.length > 0 && (
        <div className="fx-thumbs">
          {task.images.map((im, i) => (
            <button key={i} type="button" className="fx-thumb fx-hit" aria-expanded={image === i} onClick={() => onImage(i)}>
              <img src={im.url} alt={im.name} />
            </button>
          ))}
        </div>
      )}
      {!!task.files?.length && <div className="fx-thumbs">{task.files.map((file, i) => <FileAttachment key={i} file={file} />)}</div>}
      {/* the drawing opens as a whole, as flows do in the company file: its title is the button */}
      <section className="fx-flow fx-flow-card fx-d-flowcard" onClick={openCard}>
        <h3><button type="button" className="fx-flow-open" aria-expanded={flowOpen} onClick={onFlow}>{flow}</button></h3>
        <FlowNotes wf={task.workflow} staff={staffOf} done={(n) => stepDone(subs, n)} />
      </section>
      <Section name={tr('進度')}>
        <Progress wf={task.workflow} subs={subs} open={open} onOpen={onOpen} />
        <MergeRow taskId={task.id} />
        <dl className="fx-d-facts"><dt>Token</dt><dd>{fmtTokens(taskTokens(w, task))}</dd></dl>
      </Section>
      <Section name={tr('紀錄')}><Log lines={lines} /></Section>
    </>
  )
}

const stepName = (wf: Workflow, nodeId: string) => nodeOf(wf, nodeId)?.name ?? nodeId

/** A step's note colour, as on the flow drawing: the two fixed ends pink, a discussion green, the rest yellow. */
const noteCls = (wf: Workflow, nodeId: string) =>
  isFixed(wf, nodeId) ? ' fx-node-fixed' : nodeOf(wf, nodeId)?.kind === 'talk' ? ' fx-node-talk' : ''

/** A git branch, drawn small before its name. */
export const BranchIcon = () => (
  <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
    <path d="M5 3v10M5 9c0-3 6-1 6-5" stroke="currentColor" strokeWidth="1.6" fill="none" />
    <circle cx="5" cy="3" r="1.6" fill="currentColor" /><circle cx="5" cy="13" r="1.6" fill="currentColor" /><circle cx="11" cy="4" r="1.6" fill="currentColor" />
  </svg>
)



/**
 * Every sub-task of a task, in the order they started: who has it at which step, then what they handed on
 * (or sent back) once it is done, or how far along it is until then. One waiting on the user carries a red
 * badge; the user answers on its own sheet.
 */
function Progress({ wf, subs, open, onOpen }: { wf: Workflow; subs: SubTask[]; open: string | null; onOpen: (subId: string) => void }) {
  const w = useStore((s) => s.world)
  const replicas = w.replicas
  if (!subs.length) return <p className="fx-d-muted">{tr('還沒有開始')}</p>
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
                  {s.rework && <span className="fx-d-muted">{tr('重做')}</span>}
                </span>
                {out
                  ? <span className={s.sentBack ? 'fx-d-hand-text fx-d-hand-back' : 'fx-d-hand-text'}><MarkdownLine text={out} noLinks /></span>
                  : <SubState sub={s} />}
              </span>
              {out && s.endedAt !== undefined && <time>{fmtClock(s.endedAt)}</time>}
              {s.review && <WaitBadge inline />}
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
  if (r.kind === 'pickRoute') return tr('這一步做完了，但我不確定接下來要交給哪一步，請幫我選一個。')
  if (r.kind === 'failed') {
    const max = w.teams[task.teamId]?.settings.retries ?? 0
    return tr('執行{a}，自動重試 {max} 次都沒成功。要再試一次，還是略過這一步？', { a: r.reason === 'timeout' ? tr('逾時') : tr('出錯'), max })
  }
  return tr('任務花費已經到上限 ${a}，我先停下來了。要提高上限繼續，還是暫停任務？', { a: costLimit(w, task).toFixed(2) })
}

/**
 * The user's answer to an employee waiting on them, on the step's sheet under what they ask: its choices, a
 * box to write in and 確認. A question can be answered in words alone; anything else needs one of its choices.
 */
function Reply({ sub }: { sub: SubTask }) {
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
      <div className="fx-d-choices" role="group" aria-label={tr('選項')}>
        {r.options.map((o) => (
          <button key={o.id} type="button" aria-pressed={choice === o.id} className="fx-choice"
            title={o.detail || undefined} onClick={() => setChoice(choice === o.id ? '' : o.id)}>
            {o.label ?? trRecorded(`option.${o.id}`)}
          </button>
        ))}
      </div>
      <textarea className="fx-control" rows={2} value={text} aria-label={tr('回覆')}
        placeholder={question ? tr('回覆，或選上面一個') : tr('補充說明')} onChange={(e) => setText(e.target.value)} />
      <div className="fx-d-merge-acts"><button type="submit" className="fx-save" disabled={!ready}>{tr('確認')}</button></div>
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
  // the employee opens a discussion, so before their first words there is no talk yet
  const talk = sub.talk ?? { messages: [], replyAt: sub.startedAt ?? 0 }
  const task = w.tasks[sub.taskId]
  const wf = task.workflow
  const r = sub.replicaId ? w.replicas[sub.replicaId] : undefined
  const open = talking(sub) && task.stage === 'running'
  const writing = talk.replyAt !== undefined
  const live = useLiveText(sub.id)
  // the newest words in view, inside the chat's own scroll, unless the user scrolled up to read
  const list = useStickToBottom<HTMLOListElement>(`${talk.messages.length}:${writing}:${live.length}`)
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
  const ENDED = { continue: tr('討論結束，繼續下一步'), back: tr('討論結束，退回重做'), stop: tr('討論結束，任務已停止') } as const
  return (
    <div className="fx-chat">
      <ol ref={list} className="fx-chat-log" aria-live="polite" aria-label={tr('和 {a} 的討論', { a: r?.name ?? tr('員工') })}>
        {talk.messages.map((m, i) => (
          <li key={i} className={`fx-chat-msg fx-chat-${m.from}`}>
            {m.from === 'agent' && face}
            {m.from === 'agent'
              ? <div className="fx-chat-bubble"><span className="fx-sr">{r?.name ?? tr('員工')}{colon()}</span><Markdown text={m.text} /></div>
              : <p className="fx-chat-bubble"><span className="fx-sr">{tr('你：')}</span>{m.text}</p>}
            <time>{fmtClock(m.at)}</time>
          </li>
        ))}
        {writing && (
          <li className="fx-chat-msg fx-chat-agent fx-chat-writing">
            {face}
            <span className="fx-sr">{tr('{a} 正在回覆', { a: r?.name ?? tr('員工') })}</span>
            {live
              // read out when it is done, not piece by piece
              ? <div className="fx-chat-bubble" aria-hidden="true"><Markdown text={live} /></div>
              : <p><span aria-hidden="true">···</span></p>}
          </li>
        )}
      </ol>
      {talk.ended && <p className="fx-d-muted">{ENDED[talk.ended]}</p>}
      {open && !ending && (
        <form className="fx-chat-say" onSubmit={(e) => { e.preventDefault(); send() }}>
          <textarea className="fx-control" rows={2} value={text} aria-label={tr('訊息')} placeholder={writing ? tr('{a} 正在回覆…', { a: r?.name ?? tr('員工') }) : tr('輸入訊息')}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends; not while a Chinese word is still being picked in the input method
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                send()
              }
            }} />
          <div className="fx-d-merge-acts">
            <button type="submit" className="fx-save" disabled={!text.trim() || writing}>{tr('送出')}</button>
            <button type="button" className="fx-save fx-plain" onClick={() => setEnding('pick')}>{tr('結束討論')}</button>
          </div>
        </form>
      )}
      {open && ending && (
        <div className="fx-chat-end" role="group" aria-label={tr('結束討論')}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setEnding(null) } }}>
          {ending === 'back' ? (
            <form className="fx-d-merge-back" onSubmit={(e) => { e.preventDefault(); if (reason.trim()) end({ kind: 'back', reason }) }}>
              <textarea className="fx-control" rows={2} autoFocus value={reason} aria-label={tr('退回原因')} placeholder={tr('要改什麼')}
                onChange={(e) => setReason(e.target.value)} />
              <div className="fx-d-merge-acts">
                <button type="submit" className="fx-save fx-plain" disabled={!reason.trim()}>{tr('退回')}</button>
                <button type="button" className="fx-add" onClick={() => setEnding('pick')}>{tr('返回')}</button>
              </div>
            </form>
          ) : (
            <div className="fx-d-merge-acts">
              {routes
                ? routes.map((to) => (
                    <button key={to} type="button" className="fx-save" onClick={() => end({ kind: 'continue', to })}>{tr('繼續：{a}', { a: stepName(wf, to) })}</button>
                  ))
                : <button type="button" className="fx-save" autoFocus onClick={() => end({ kind: 'continue' })}>{tr('繼續')}</button>}
              {sub.upstreamIds.length > 0 && <button type="button" className="fx-save fx-plain" onClick={() => setEnding('back')}>{tr('退回')}</button>}
              {ending === 'stop'
                ? <button type="button" className="fx-save fx-danger" autoFocus onClick={() => end({ kind: 'stop' })} onBlur={() => setEnding('pick')}>{tr('確定停止任務')}</button>
                : <button type="button" className="fx-save fx-plain" onClick={() => setEnding('stop')}>{tr('停止任務')}</button>}
              <button type="button" className="fx-add" onClick={() => setEnding(null)}>{tr('取消')}</button>
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
    : done ? tr('已合併回 {target}', { target })
    : !busy ? tr('合併中')
    : m!.conflict && w.now - m!.startedAt! < RESOLVE_TIME ? tr('解衝突中') : tr('合併中')
  const sendBack = () => {
    act((x) => returnTask(x, taskId, feedback))
    setReturning(false)
    setFeedback('')
  }
  const face = r ? <PixelFace look={r.look} name={r.name} size={26} /> : <span className="fx-d-noface" />
  const main = (
    <span className="fx-row-main">
      <span className="fx-d-hand-head"><span className="fx-d-stepname fx-d-stepname-sm fx-node-fixed">{tr('合併')}</span></span>
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
        {/* one child: the row's grid has a single column left for its end */}
        {waiting && (
          <div className="fx-d-merge-acts">
            <WaitBadge merge inline />
            {!returning && <>
              <button type="button" className="fx-save fx-danger" onClick={() => act((x) => mergeTask(x, taskId))}>{tr('合併')}</button>
              <button type="button" className="fx-save fx-plain" onClick={() => setReturning(true)}>{tr('退回')}</button>
            </>}
          </div>
        )}
      </div>
      {waiting && returning && (
        <form className="fx-d-merge-back" onSubmit={(e) => { e.preventDefault(); sendBack() }}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setReturning(false) } }}>
          <textarea className="fx-control" rows={3} autoFocus value={feedback} aria-label={tr('退回原因')}
            placeholder={tr('要改什麼')} onChange={(e) => setFeedback(e.target.value)} />
          <div className="fx-d-merge-acts">
            <button type="submit" className="fx-save fx-plain" disabled={!feedback.trim()}>{tr('退回')}</button>
            <button type="button" className="fx-add" onClick={() => setReturning(false)}>{tr('取消')}</button>
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
        <Bar value={sub.progress} /><span className="fx-d-muted">{Math.round(sub.progress * 100)}%{sub.attempts > 1 ? tr('・第 {attempts} 次', { attempts: sub.attempts }) : ''}</span>
      </span>
    )
  }
  const word = sub.skipped ? tr('略過')
    : sub.status === 'complete' ? tr('完成')
    : sub.review ? (sub.review.kind === 'talk' ? tr('討論中，等你回覆') : tr('等你回覆'))
    : sub.waiting ? tr('等其他前一步完成')
    : sub.replicaId ? tr('準備開始') : tr('等人接手')
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
      {n.kind === 'talk' && <><dt>{tr('種類')}</dt><dd>{KINDS.talk}</dd></>}
      {!isFixed(wf, id) && <><dt>{tr('任務分派')}</dt><dd>{tr(ASSIGN[n.assignment])}</dd></>}
      {before > 1 && <><dt>{tr('開始條件')}</dt><dd>{tr(JOIN[n.join])}</dd></>}
      {next.length > 1 && <><dt>{tr('交接')}</dt><dd>{tr(HANDOFF[n.handoff])}</dd></>}
      <dt>{tr('下一步')}</dt><dd>{next.length ? listOf(next.filter((x) => x !== undefined)) : tr('結束')}</dd>
    </dl>
  )
}

/** Who works 整理需求 and 驗收 on a flow, which names nobody: whoever owns the task. */
function Owner() {
  return <ul className="fx-d-crew"><li className="fx-d-crew-owner">{tr('任務負責人')}</li></ul>
}

/** The employees on a step, face and name; each opens on its own sheet when `onOpen` is given. */
function Crew({ ids, open, onOpen }: { ids: string[]; open?: string | null; onOpen?: (id: string) => void }) {
  const replicas = useStore((s) => s.world.replicas)
  const crew = ids.map((id) => replicas[id]).filter(Boolean)
  if (!crew.length) return <p className="fx-d-muted">{tr('沒有人')}</p>
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
          <span className="fx-pill">{task.stage === 'cancelled' ? tr('已停止') : sub.skipped ? tr('略過') : tr(STATUS[sub.status])}</span>
          <span><span className="fx-task-no">#{task.number}</span>{task.title}</span>
        </p>
      </header>
      {sub.status === 'progressing' && <p className="fx-d-run"><Bar value={sub.progress} /><span className="fx-d-muted">{Math.round(sub.progress * 100)}%</span></p>}
      {/* the user answers here: a discussion in its chat, anything else under what the employee asks */}
      {(sub.talk || (nodeOf(wf, sub.nodeId)?.kind === 'talk' && sub.status === 'progressing')) && <Section name={tr('討論')}><Chat key={sub.id} sub={sub} /></Section>}
      {sub.review && sub.review.kind !== 'talk' && (
        <Section name={tr('等你回覆')}>
          <div className="fx-d-text-md fx-d-quote"><Markdown text={askText(w, sub)} /></div>
          <Reply key={sub.review.at} sub={sub} />
        </Section>
      )}
      <Section name={tr('負責員工')}>
        {r ? (
          <ul className="fx-list">
            <li><button type="button" className="fx-row fx-hit" aria-expanded={crew === r.id} onClick={() => onCrew(r.id)}>
              <PixelFace look={r.look} name={r.name} size={34} />
              <span className="fx-row-main"><b>{r.name}</b><span>{w.blueprints[r.blueprintId]?.name}</span></span>
            </button></li>
          </ul>
        ) : <p className="fx-d-muted">{tr('等人接手')}</p>}
      </Section>
      <Section name={tr('經過')}>
        <dl className="fx-d-facts">
          <dt>{tr('接自')}</dt><dd>{from.length ? listOf(from) : tr('任務本身')}</dd>
          {sub.rework && <><dt>{tr('退回自')}</dt><dd>{name(w.subTasks[sub.rework.from]?.nodeId ?? '')}{colon()}<MarkdownLine text={sub.rework.reason} /></dd></>}
          {sub.startedAt !== undefined && <><dt>{tr('開始')}</dt><dd>{fmtClock(sub.startedAt)}</dd></>}
          {sub.endedAt !== undefined && <><dt>{tr('結束')}</dt><dd>{fmtClock(sub.endedAt)}</dd></>}
          {sub.attempts > 1 && <><dt>{tr('嘗試')}</dt><dd>{tr('{attempts} 次', { attempts: sub.attempts })}</dd></>}
          <dt>{tr('花費')}</dt><dd>${sub.costUsd.toFixed(2)}</dd>
          <dt>Token</dt><dd>{fmtTokens(sub.tokens)}</dd>
          {sub.sentBack
            ? <><dt>{tr('退回給')}</dt><dd>{listOf(sub.sentBack.to.map(name))}</dd></>
            : sub.routedTo.length > 0 && <><dt>{tr('交給')}</dt><dd>{listOf(sub.routedTo.map(name))}</dd></>}
        </dl>
      </Section>
      {out && (
        <Section name={tr('交接')}>
          <p className="fx-d-text"><b><MarkdownLine text={out.headline} /></b></p>
          {out.did.length > 0 && <ul className="fx-d-memory">{out.did.map((x, i) => <li key={i}><Markdown text={x} /></li>)}</ul>}
          {out.outputs.length > 0 && (
            <ul className="fx-list fx-d-files" aria-label={tr('交出的檔案')}>
              {out.outputs.map((x) => {
                const file = outputFile(x)
                if (!file) return <li key={x} className="fx-d-text"><MarkdownLine text={x} /></li>
                return (
                  <li key={x}>
                    <button type="button" className="fx-row fx-hit" aria-expanded={open === file} onClick={() => onOpen(file)}>
                      <FileIcon />
                      <span className="fx-row-main"><b>{file.split('/').pop()}</b><span><MarkdownLine text={x} noLinks /></span></span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </Section>
      )}
      <Section name={tr('紀錄')}><Log lines={sub.log.slice(-LOG_LINES).map((l) => ({ ...l, text: logText(l) }))} /></Section>
    </>
  )
}

function FlowDetail({ id, editing, onEdit, onGoneFlow, ...h }: Head & {
  id: string
  editing: boolean
  onEdit: () => void
  /** Called once the flow is deleted, to put its sheet away. */
  onGoneFlow: () => void
}) {
  const w = useStore((s) => s.world)
  const act = useStore((s) => s.act)
  const wf = w.workflows[id]
  if (!wf) return <Gone {...h} />
  const remove = () => {
    onGoneFlow()
    act((x) => deleteWorkflow(x, id))
  }
  const tasks = Object.values(w.tasks).filter((t) => t.workflowId === wf.id && statusOf(w, t) !== 'complete')
  return (
    <>
      <div className="fx-tools">
        {!isPreset(id) && <EditTool onClick={onEdit} open={editing} />}
        <button type="button" className="fx-tool fx-hit" onClick={() => act((x) => void duplicateWorkflow(x, id))} aria-label={tr('複製')} title={tr('複製')}>
          <CopyIcon />
        </button>
        {!isPreset(id) && <DeleteTool what={tr('任務流程')} onConfirm={remove} />}
      </div>
      <header className="fx-d-head">
        <Heading {...h}>{wf.name}</Heading>
        <p className="fx-d-meta">
          <span>{tr('{length} 個步驟', { length: wf.nodes.length })}</span>
          <span>{tasks.length ? tr('{length} 個任務未完成', { length: tasks.length }) : tr('沒有未完成的任務')}</span>
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
          aria-label={tr('解僱')} title={alone ? tr('公司至少要有一位員工') : tr('解僱')}>
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
            {doing ? <span className="fx-pill fx-pill-on">{doing}</span> : <span>{tr('沒有工作')}</span>}
          </p>
        </div>
      </header>
      <Section name={tr('負責的任務')}>
        {steps.length === 0 ? <p className="fx-d-muted">{tr('還沒被安排')}</p> : (
          <p className="fx-d-chips">{steps.map(({ task, n }) => <span key={task.id + n.id}>#{task.number} › {stepName(task.workflow, n.id)}</span>)}</p>
        )}
      </Section>
      <Section name={tr('最近的工作')}>
        <Log lines={(last?.log ?? []).slice(-LOG_LINES).map((l) => ({ ...l, text: logText(l) }))} />
      </Section>
      <Section name={tr('記憶 {length}', { length: r.memory.length })}>
        {r.memory.length === 0 ? <p className="fx-d-muted">{tr('還沒有記憶')}</p> : (
          <ul className="fx-d-memory">
            {r.memory.map((m) => <MemoryNote key={m.id} replicaId={r.id} note={m} />)}
          </ul>
        )}
      </Section>
    </>
  )
}

/** One thing an employee remembers, which the user can correct or remove. */
function MemoryNote({ replicaId, note }: { replicaId: string; note: MemoryEntry }) {
  const w = useStore((s) => s.world)
  const act = useStore((s) => s.act)
  const [draft, setDraft] = useState<string | null>(null)
  if (draft !== null) {
    const text = draft.trim()
    const save = (e: React.FormEvent) => {
      e.preventDefault()
      if (text && text !== note.text) act((x) => editMemory(x, replicaId, note.id, text))
      setDraft(null)
    }
    return (
      <li>
        <form className="fx-d-reply" onSubmit={save}>
          <textarea className="fx-control" rows={3} value={draft} autoFocus aria-label={tr('記憶')} onChange={(e) => setDraft(e.target.value)} />
          <div className="fx-d-merge-acts">
            <button type="button" className="fx-add" onClick={() => setDraft(null)}>{tr('取消')}</button>
            <button type="submit" className="fx-save" disabled={!text}>{tr('儲存')}</button>
          </div>
        </form>
      </li>
    )
  }
  const task = note.taskId ? w.tasks[note.taskId] : undefined
  return (
    <li className="fx-d-note">
      <span>{note.text}{task && <span className="fx-d-muted"> #{task.number}</span>}</span>
      <div className="fx-d-note-tools">
        <EditTool onClick={() => setDraft(note.text)} />
        <DeleteTool what={tr('記憶')} onConfirm={() => act((x) => deleteMemory(x, replicaId, note.id))} />
      </div>
    </li>
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
  const more = a.more > 0 ? ` +${a.more}` : ''
  if (a.sub && a.task) return `${nodeOf(a.task.workflow, a.sub.nodeId)?.name ?? ''} · #${a.task.number}${more}`
  return a.merging ? tr('合併 · #{number}', { number: a.merging.number }) + more : null
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
        <DeleteTool what={tr('供應商')} onConfirm={remove} disabled={crew.length > 0} why={tr('還有 {length} 位員工使用這個供應商，無法刪除', { length: crew.length })} />
      </div>
      <header className="fx-d-head"><Heading {...h}>{p.name}</Heading></header>
      <Section name={tr('類型')}><p className="fx-d-text">{PROVIDER_KINDS[p.kind].label}</p></Section>
      <Section name={tr('連線方式')}><p className="fx-d-text">{authLabel(p)}</p></Section>
      {p.auth.kind === 'apiKey' && (
        <>
          <Section name={tr('API 位址')}><p className="fx-d-text"><code>{providerUrl(p)}</code></p></Section>
          <Section name="API Key"><p className="fx-d-text"><code>{p.auth.keyHint ? `••••${p.auth.keyHint}` : tr('沒有')}</code></p></Section>
        </>
      )}
      <Section name={tr('模型#list')}>
        {p.models.length === 0 ? <p className="fx-d-muted">{tr('沒有')}</p> : (
          <p className="fx-d-chips fx-d-mono">{p.models.map((m) => <span key={m}>{m}</span>)}</p>
        )}
      </Section>
      <Section name={tr('使用中的員工')}>
        {crew.length === 0 ? <p className="fx-d-muted">{tr('沒有人')}</p> : (
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
  // what a signed-in Claude account offers; only a new provider asks, as editing one keeps its sign-in
  const [claudeModels, setClaudeModels] = useState<string[]>([])
  // ChatGPT: the backend signs in a provider it has, so one is made when the user starts, and thrown away if
  // they leave before saving
  const [made, setMade] = useState<string | null>(null)
  const madeProvider = useStore((s) => (made ? s.world.providers[made] : undefined))
  const keepMade = useRef(false)
  const madeNow = useRef<string | null>(null)
  madeNow.current = made
  useEffect(() => () => {
    if (madeNow.current && !keepMade.current) void request('DELETE', `/providers/${madeNow.current}`).catch(() => {})
  }, [])
  const startChatGPT = async () => {
    const p = await attempt(() => request<{ id: string }>('POST', '/providers', { name, kind, login: { kind: 'subscription' } }))
    if (p) setMade(p.id)
  }
  if (id && !old) return <Gone {...h} />
  const sub = SUBSCRIPTIONS[kind]
  const nameFor = (k: ProviderKind, a: typeof auth) => (a === 'subscription' ? tr('{a} 訂閱', { a: SUBSCRIPTIONS[k] }) : PROVIDER_KINDS[k].label)
  const pickKind = (k: ProviderKind) => {
    const a = SUBSCRIPTIONS[k] ? auth : 'apiKey'
    setKind(k)
    setAuth(a)
    setSignedIn(false)
    setClaudeModels([])
    if (!named) setName(nameFor(k, a))
  }
  const pickAuth = (a: typeof auth) => {
    setAuth(a)
    setLoginError(false)
    setClaudeModels([])
    if (!named) setName(nameFor(kind, a))
  }
  const custom = kind === 'compatible'
  const claude = !old && kind === 'anthropic' && auth === 'subscription'
  // a key is asked for unless one is kept already, or the provider needs none
  const needKey = !custom && !(old?.auth.kind === 'apiKey')
  const save = (e: React.FormEvent) => {
    e.preventDefault()
    const account = (old ?? madeProvider)?.auth
    const done = claude ? claudeModels.length > 0 : MOCK ? signedIn : account?.kind === 'subscription' && !!account.signedIn
    if (auth === 'subscription' && !done) return setLoginError(true)
    const login: ProviderLogin | null = auth === 'subscription'
      ? (old?.auth.kind === 'subscription' ? null : { kind: 'subscription' })
      : { kind: 'apiKey', apiKey: key }
    if (!MOCK) {
      // the form stays open if the backend turns it down, for a key that does not work, say
      void attempt(async () => {
        if (made) await request('PATCH', `/providers/${made}`, { name })
        else if (old) await request('PATCH', `/providers/${old.id}`, { name, baseUrl: url, login })
        else {
          const p = await request<{ id: string }>('POST', '/providers', { name, kind, baseUrl: url, login: login ?? { kind: 'subscription' } })
          // Claude Code is signed in already by now; the backend only has to see it
          if (claude) await request('POST', `/providers/${p.id}/login`, {})
        }
        keepMade.current = true
        onDone()
      })
      return
    }
    const models = claude ? claudeModels : PROVIDER_KINDS[kind].models
    act((x) => {
      if (old) updateProvider(x, old.id, { name, baseUrl: url, login })
      else addProvider(x, { name, kind, baseUrl: url, login: login ?? { kind: 'subscription' }, models, thinking: mockThinking(kind, models) })
    })
    onDone()
  }
  return (
    <form className="fx-d-form" onSubmit={save}>
      <header className="fx-d-head"><Heading {...h}>{old ? tr('編輯 {name}', { name: old.name }) : tr('新增模型供應商')}</Heading></header>
      <div className="fx-fields">
        {!old && (
          <Select label={tr('類型')} value={kind} options={Object.keys(PROVIDER_KINDS)} labelOf={(k) => PROVIDER_KINDS[k as ProviderKind].label}
            onChange={(k) => pickKind(k as ProviderKind)} />
        )}
        {sub && (
          <Switcher label={tr('連線方式')} value={auth} options={['apiKey', 'subscription'] as const}
            labelOf={(a) => (a === 'apiKey' ? 'API Key' : tr('{sub} 訂閱', { sub }))} onChange={pickAuth} />
        )}
        <label className="fx-field">
          <span>{tr('名稱')}</span>
          <input className="fx-control" value={name} required pattern=".*\S.*" title={tr('名稱不可為空')}
            onChange={(e) => { setName(e.target.value); setNamed(true) }} />
        </label>
        {auth === 'apiKey' ? (
          <>
            <label className="fx-field">
              <span>{tr('API 位址')}</span>
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
        ) : claude ? (
          <>
            <ClaudeAccount describedBy={loginError ? 'fx-login-error' : undefined}
              onModels={(m) => { setClaudeModels(m); if (m.length) setLoginError(false) }} />
            {loginError && <p id="fx-login-error" className="fx-field-error">{tr('請先登入 {sub}', { sub })}</p>}
          </>
        ) : !MOCK ? (
          <>
            {old || made
              ? <SubscriptionLogin id={old?.id ?? (made as string)} />
              : (
                <div className="fx-field">
                  <span>{tr('帳號')}</span>
                  <button type="button" className="fx-control fx-login fx-hit" onClick={() => void startChatGPT()}>{tr('登入 {sub}', { sub })}</button>
                </div>
              )}
            {loginError && <p id="fx-login-error" className="fx-field-error">{tr('請先登入 {sub}', { sub })}</p>}
          </>
        ) : (
          <>
            <div className="fx-field">
              <span>{tr('帳號')}</span>
              {signedIn ? (
                <p className="fx-signed" role="status">{tr('✓ 已登入 {sub}', { sub })}</p>
              ) : (
                // stands in for the provider's own sign-in page, opened in the browser
                <button type="button" className="fx-control fx-login fx-hit" aria-describedby={loginError ? 'fx-login-error' : undefined}
                  onClick={() => { setSignedIn(true); setLoginError(false) }}>{tr('登入 {sub}', { sub })}</button>
              )}
            </div>
            {loginError && <p id="fx-login-error" className="fx-field-error">{tr('請先登入 {sub}', { sub })}</p>}
          </>
        )}
      </div>
      <button type="submit" className="fx-save">{old ? tr('儲存') : tr('新增')}</button>
    </form>
  )
}

function BlueprintDetail({ id, teamId, editing, copying, onEdit, onCopy, onGoneBlueprint, ...h }: Head & {
  id: string
  teamId: string
  editing: boolean
  copying: boolean
  onEdit: () => void
  onCopy: () => void
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
        {!isPreset(id) && <EditTool onClick={onEdit} open={editing} />}
        <button type="button" className="fx-tool fx-hit" onClick={onCopy} aria-expanded={copying} aria-label={tr('複製')} title={tr('複製')}>
          <CopyIcon />
        </button>
        {!isPreset(id) && <DeleteTool what={tr('藍圖')} onConfirm={remove} disabled={users > 0} why={tr('還有 {users} 位員工使用這個藍圖，無法刪除', { users })} />}
      </div>
      <header className="fx-d-head fx-d-who">
        <BlueprintIcon look={bp.look} name={bp.name} size={52} />
        <Heading {...h}>{bp.name}</Heading>
      </header>
      <Section name={tr('來源')}><ul className="fx-src-list"><SourceRow source={bp.source} now={w.now} /></ul></Section>
      {bp.prompt && <Section name="Prompt"><p className="fx-d-text fx-d-quote">{bp.prompt}</p></Section>}
      {bp.comment && <Section name={tr('備註')}><p className="fx-d-text">{bp.comment}</p></Section>}
      <Section name={tr('技能')}>
        {bp.skills.length === 0 ? <p className="fx-d-muted">{tr('沒有')}</p> : (
          <ul className="fx-src-list">
            {bp.skills.map((p, i) => (
              <SourceRow key={i} source={p.source} now={w.now}>
                <p className="fx-d-chips">
                  {p.include ? p.include.map((x) => <span key={x}>{x}</span>) : <span className="fx-chip-all">{tr('全部')}</span>}
                  {p.exclude.map((x) => <span key={x} className="fx-chip-out"><span className="fx-sr">{tr('排除 ')}</span>{x}</span>)}
                </p>
              </SourceRow>
            ))}
          </ul>
        )}
      </Section>
      <Section name={tr('工具')}>
        {bp.tools.length === 0 ? <p className="fx-d-muted">{tr('沒有')}</p> : (
          // in the order of TOOLS, whatever order they were allowed in
          <p className="fx-d-chips">{TOOLS.filter((t) => bp.tools.includes(t)).map((t) => <span key={t}>{toolName(t)}</span>)}</p>
        )}
      </Section>
      <Section name={tr('使用中的員工')}>
        {crew.length === 0 ? <p className="fx-d-muted">{tr('沒有人')}</p> : (
          <ul className="fx-d-people">
            {crew.map((r) => <li key={r.id}><PixelFace look={r.look} name={r.name} size={26} /><b>{r.name}</b><span>{doingOf(w, r) ?? tr('沒有工作')}</span></li>)}
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
        {!source ? <span>{tr('藍圖本身')}</span> : source.kind === 'yaml' || source.kind === 'preset' ? <span>{sourceText(source)}</span> : <code>{sourceText(source)}</code>}
        {source?.kind === 'git' && source.private && <span className="fx-d-muted">{tr('私有')}</span>}
        {source?.kind === 'local' && <span className="fx-d-muted">{tr('本機')}</span>}
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
 * Add a blueprint (`id` null) by filling it in, or change one. One from GitHub keeps its repo, typed as
 * `owner/repo` or pasted as any GitHub address: a version in it (branch, tag or commit) moves to the version
 * field. With no version the default branch is used. A new one's icon is rolled at random. Nothing changes
 * until it is saved.
 */
function BlueprintEdit({ id, copyOf, onDone, ...h }: Head & { id: string | null; copyOf?: string; onDone: () => void }) {
  const act = useStore((s) => s.act)
  const old = useStore((s) => (id ? s.world.blueprints[id] : undefined))
  const language = useStore((s) => s.world.language)
  // what the form starts from: a copy takes the text as it is shown now
  const from = useStore((s) => (copyOf ? s.world.blueprints[copyOf] : old))
  const was = from?.source
  // new ones are filled in here; one already from GitHub stays tied to its repo
  const kind = was?.kind === 'git' ? 'git' : 'local'
  const [repo, setRepo] = useState(was?.kind === 'git' ? was.repo.replace('git@github.com:', '') : '')
  const [ref, setRef] = useState(was?.kind === 'git' ? was.ref : '')
  const [prompt, setPrompt] = useState(from?.prompt ?? '')
  const [comment, setComment] = useState(from?.comment ?? '')
  const [rows, setRows] = useState<SkillRow[]>(() => skillRowsOf(from?.skills ?? []))
  const [tools, setTools] = useState<Tool[]>(from?.tools ?? ['readFile', 'writeFile'])
  const [name, setName] = useState(old?.name ?? (from ? (language === 'en' ? `${from.name} copy` : tr('{name} 副本', { name: from.name })) : ''))
  const [named, setNamed] = useState(!!from)
  // the face it is drawn with now, fixed, so the form shows the same one whatever name it goes by
  const [look, setLook] = useState<Look>(() => (old ? pinLook(old.look, old.name) : randomLook()))
  const [repoError, setRepoError] = useState(false)
  // the key of the skill row whose repo is not one
  const [badRow, setBadRow] = useState<number | null>(null)
  // a row just added takes the keyboard
  const [focusRow, setFocusRow] = useState<number | null>(null)
  const repoField = useRef<HTMLInputElement>(null)
  const rowFields = useRef(new Map<number, HTMLInputElement>())
  const addRow = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (focusRow === null) return
    rowFields.current.get(focusRow)?.focus()
    setFocusRow(null)
  }, [focusRow])
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
    act((x) => saveBlueprint(x, id, (key, prev) => blueprintOf(key, prev, look, bp)))
    onDone()
  }
  const save = (e: React.FormEvent) => {
    e.preventDefault()
    const now = useStore.getState().world.now
    if (kind === 'local') {
      // the simulator makes up a version; the backend finds the real one once the blueprint is saved
      const read = skillPacksOf(rows, now, () => (MOCK ? hash() : ''))
      if (!read.ok) {
        const row = rows[read.row]
        setBadRow(row.key)
        rowFields.current.get(row.key)?.focus()
        return
      }
      const skills = read.skills.map((p) => (p.source?.kind === 'git' ? { ...p, source: keepSource(old, p.source) } : p))
      const form = { name: name.trim(), prompt: prompt.trim(), comment: comment.trim(), skills, tools: TOOLS.filter((t) => tools.includes(t)) }
      return keep({ ...form, source: { kind: 'yaml', text: blueprintToYaml(form) } })
    }
    const g = parseGithub(repo)
    if (!g) {
      setRepoError(true)
      repoField.current?.focus()
      return
    }
    const version = (g.ref || ref).trim()
    // the simulator makes up a version; the backend finds the real one once the blueprint is saved
    const commit = MOCK ? hash() : ''
    const source = keepSource(old, {
      kind: 'git', repo: `git@github.com:${g.repo}`, ref: version, commit, latestRef: version, latest: commit, private: false,
      upstream: true, update: { at: now, ok: true },
    })
    // the same repo and version: what it was read as stands
    if (old && was === source) return keep({ ...old, name: name.trim() })
    // the prompt and skills are the repo's own; the prototype has no files to read them from, and with the
    // backend an empty prompt means its AGENTS.md. The tools start read and write only.
    keep({
      name: name.trim(), source, prompt: MOCK ? tr('（從 AGENTS.md 讀取）') : '', comment: '',
      skills: [{ source: null, include: MOCK ? ['code-review', 'tdd', 'summarize'] : null, exclude: [] }], tools: ['readFile', 'writeFile'],
    })
  }
  return (
    <form className="fx-d-form" onSubmit={save}>
      <header className="fx-d-head fx-d-who">
        <BlueprintIcon look={look} name={name || old?.name || tr('新藍圖')} size={52} />
        <Heading {...h}>{old ? tr('編輯 {name}', { name: old.name }) : tr('新增員工藍圖')}</Heading>
      </header>
      <div className="fx-fields">
        <div className="fx-field fx-field-top">
          <span>{tr('樣式')}</span>
          <div className="fx-look">
            <BlueprintIcon look={look} name={tr('藍圖樣式')} size={96} />
            <Reroll onClick={() => setLook(randomLook())} label={tr('隨機樣式')} />
          </div>
        </div>
        <label className="fx-field">
          <span>{tr('名稱')}</span>
          {/* not blank: spaces alone are no name */}
          <input className="fx-control" value={name} required pattern=".*\S.*" title={tr('名稱不可為空')}
            onChange={(e) => { setName(e.target.value); setNamed(true) }} />
        </label>
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
            {repoError && <p id="fx-repo-error" className="fx-field-error">{tr('請輸入 owner/repo 或 GitHub 網址')}</p>}
            <label className="fx-field">
              <span>{tr('版本')}</span>
              <input className="fx-control" value={ref} onChange={(e) => setRef(e.target.value)} spellCheck={false} autoComplete="off"
                placeholder="master / main" />
            </label>
          </>
        ) : (
          <>
            <label className="fx-field fx-field-top">
              <span>Prompt</span>
              <textarea className="fx-control" rows={8} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
            </label>
            <label className="fx-field fx-field-top">
              <span>{tr('備註')}</span>
              <textarea className="fx-control" rows={2} value={comment} onChange={(e) => setComment(e.target.value)} />
            </label>
          </>
        )}
      </div>
      {kind === 'local' && (
        <>
          <Section name={tr('技能')}>
            {rows.length > 0 && (
              <ul className="fx-skill-rows">
                {rows.map((row, i) => {
                  const change = (patch: Partial<SkillRow>) => setRows((rs) => rs.map((r) => (r.key === row.key ? { ...r, ...patch } : r)))
                  const bad = badRow === row.key
                  return (
                    <li key={row.key} className="fx-skill-row">
                      <Select label={tr('位置')} value={row.kind} options={['local', 'git']} labelOf={(x) => (x === 'local' ? tr('本機資料夾') : 'GitHub')}
                        onChange={(x) => {
                          if (x !== row.kind) change({ kind: x as SkillRow['kind'], where: '', ref: '' })
                          setBadRow(null)
                        }} />
                      <label className="fx-field">
                        <span>{row.kind === 'local' ? tr('資料夾') : 'Repo'}</span>
                        <input ref={(el) => { if (el) rowFields.current.set(row.key, el); else rowFields.current.delete(row.key) }}
                          className="fx-control" value={row.where} required pattern=".*\S.*" spellCheck={false} autoComplete="off"
                          placeholder={row.kind === 'local' ? '~/.agents/' : 'owner/repo'} aria-invalid={bad || undefined}
                          aria-describedby={bad ? `fx-skill-error-${row.key}` : undefined}
                          onChange={(e) => { change({ where: e.target.value }); setBadRow(null) }}
                          // an address becomes owner/repo, and the version in it goes to the version field
                          onBlur={() => {
                            const g = row.kind === 'git' ? parseGithub(row.where) : null
                            if (g) change({ where: g.repo, ref: g.ref || row.ref })
                          }} />
                      </label>
                      {bad && <p id={`fx-skill-error-${row.key}`} className="fx-field-error">{tr('請輸入 owner/repo 或 GitHub 網址')}</p>}
                      {row.kind === 'git' && (
                        <label className="fx-field">
                          <span>{tr('版本')}</span>
                          <input className="fx-control" value={row.ref} spellCheck={false} autoComplete="off" placeholder="master / main"
                            onChange={(e) => change({ ref: e.target.value })} />
                        </label>
                      )}
                      <label className="fx-field">
                        <span>{tr('只載入')}</span>
                        <input className="fx-control" value={row.include} spellCheck={false} autoComplete="off" placeholder={tr('全部（以逗號分隔）')}
                          onChange={(e) => change({ include: e.target.value })} />
                      </label>
                      <label className="fx-field">
                        <span>{tr('排除')}</span>
                        <input className="fx-control" value={row.exclude} spellCheck={false} autoComplete="off" placeholder={tr('無（以逗號分隔）')}
                          onChange={(e) => change({ exclude: e.target.value })} />
                      </label>
                      <button type="button" className="fx-tool fx-hit fx-skill-remove" aria-label={tr('刪除第 {a} 個技能來源', { a: i + 1 })} title={tr('刪除')}
                        onClick={() => {
                          setRows((rs) => rs.filter((r) => r.key !== row.key))
                          addRow.current?.focus()
                        }}>
                        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                          <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                        </svg>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
            <button ref={addRow} type="button" className="fx-task fx-task-new fx-flow-new fx-hit fx-skill-add"
              onClick={() => {
                const row = newSkillRow()
                setRows((rs) => [...rs, row])
                setFocusRow(row.key)
              }}>{tr('＋ 新增技能來源')}</button>
          </Section>
          <Section name={tr('工具')}>
            <div className="fx-tool-picks" role="group" aria-label={tr('允許的工具')}>
              {TOOLS.map((t) => (
                <label key={t}>
                  <input type="checkbox" className="fx-tick" checked={tools.includes(t)}
                    onChange={(e) => setTools((ts) => (e.target.checked ? [...ts, t] : ts.filter((x) => x !== t)))} />
                  {toolName(t)}
                </label>
              ))}
            </div>
          </Section>
        </>
      )}
      <button type="submit" className="fx-save">{old ? tr('儲存') : tr('新增')}</button>
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
  const [model, setModel] = useState(r?.model ?? (MOCK ? DEFAULT_MODEL : modelsOf(w)[0] ?? ''))
  const [effort, setEffort] = useState(r?.effort ?? DEFAULT_EFFORT)
  // what the model takes decides; another model that doesn't take this level starts on the default
  const levels = effortsOf(w, model)
  const level = levels.includes(effort) ? effort : DEFAULT_EFFORT
  const [look, setLook] = useState<Look>(() => r?.look ?? randomLook())
  // what a new hire needs may go while this is open; changing an employee needs nothing of it
  const needs = usePrereqs(teamId, 'crew').filter((x) => !id && x.blocks)
  if (id && !r) return <Gone {...h} />
  const save = (e: React.FormEvent) => {
    e.preventDefault()
    act((x) => {
      if (!id) return void hire(x, teamId, bp, name.trim(), look, { model, effort: level })
      updateReplica(x, id, { name: name.trim(), blueprintId: bp, model, effort: level, look })
    })
    onDone()
  }
  return (
    <form className="fx-d-form" onSubmit={save}>
      <header className="fx-d-head fx-d-who">
        <PixelFace look={look} name={name || '?'} size={52} />
        <Heading {...h}>{r ? tr('編輯 {name}', { name: r.name }) : tr('新增員工')}</Heading>
      </header>
      <div className="fx-fields">
        <div className="fx-field fx-field-top">
          <span>{tr('外型')}</span>
          <div className="fx-look">
            <Standee look={look} seed={look.style ?? seedOf(r?.id ?? '')} />
            <Reroll onClick={() => setLook(randomLook())} label={tr('隨機外型')} />
          </div>
        </div>
        <label className="fx-field">
          <span>{tr('名字')}</span>
          <input className="fx-control" value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <BlueprintSelect label={tr('藍圖')} value={bp} onChange={setBp} />
        <Select label={tr('模型')} value={model} options={modelsOf(w)} onChange={setModel}
          groups={modelGroups(w).map((g) => ({ label: g.label, count: g.models.length }))}
          groupOf={(m) => modelGroups(w).findIndex((g) => g.models.includes(m))} />
        <Select label={tr('思考等級')} value={level} options={levels} onChange={setEffort} />
      </div>
      <Prereqs list={needs} />
      <button type="submit" className="fx-save" disabled={!name.trim() || !bp || blocked(needs)}>{r ? tr('儲存') : tr('新增')}</button>
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
        <Heading {...h}>{tr('解僱 {name}', { name: r.name })}</Heading>
      </header>
      <Section name={tr('要交接的工作')}>
        {owned.length + steps.length === 0 ? <p className="fx-d-muted">{tr('沒有')}</p> : (
          <p className="fx-d-chips">
            {owned.map((t) => <span key={t.id}>{tr('#{number} 負責人', { number: t.number })}</span>)}
            {steps.map(({ task, n }) => <span key={task.id + n.id}>#{task.number} › {stepName(task.workflow, n.id)}</span>)}
          </p>
        )}
      </Section>
      <Section name={tr('交接給')}>
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
      <button type="submit" className="fx-save" disabled={!heir}>{tr('交接並解僱')}</button>
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
        <Heading {...h}>{tr('解散 {name}', { name: team.name })}</Heading>
        <p className="fx-d-meta"><span>{tr('{people} 位員工', { people })}</span><span>{tr('{open} 個未完成的任務', { open })}</span></p>
      </header>
      {MOCK && (
        <button type="button" role="checkbox" aria-checked={removeFiles} className="fx-row fx-row-plain fx-hit fx-d-toggle"
          onClick={() => setRemoveFiles(!removeFiles)}>
          <span className="fx-row-main"><b>{tr('同時刪除本地檔案')}</b><span><code>{team.folder}</code></span></span>
          <span className="fx-box" aria-hidden="true">{removeFiles ? '✓' : ''}</span>
        </button>
      )}
      <button type="submit" className="fx-save fx-danger">{tr('解散公司')}</button>
    </form>
  )
}

/**
 * A new task: what it is, which flow it runs, and who works each step this time. The staff starts as the
 * last task's on that flow; a step's note opens a sheet to change it. It can start once every step has
 * someone.
 */
function NewTask({ teamId, copyOf, seed, open, onOpen, onDone, ...h }: Head & {
  teamId: string
  /** The task to start from, if it is a copy. */
  copyOf?: string
  /** What a chat came to, if it starts from one. */
  seed?: ChatTaskSeed
  open: string | null
  onOpen: (nodeId: string) => void
  onDone: () => void
}) {
  const w = useStore((s) => s.world)
  const act = useStore((s) => s.act)
  const draft = useDraft((s) => s.draft)
  const [reading, setReading] = useState(false)
  const [attachmentError, setAttachmentError] = useState('')
  const attachmentSession = useRef(0)
  const flows = flowList(w)
  // what a task needs may go while this is open
  const needs = usePrereqs(teamId, 'tasks').filter((x) => x.blocks)
  // a fresh draft on the flow last chosen, or a copy of a task; dropped when the sheet goes
  useEffect(() => {
    const s = useStore.getState().world
    const workflowId = lastFlowId(s, teamId)
    const source = copyOf ? s.tasks[copyOf] : undefined
    const last = lastStaff(s, teamId, workflowId)
    useDraft.setState({ draft: source ? copyDraft(s, teamId, source) : {
      workflowId, ...last, title: seed?.title ?? '', description: seed?.description ?? '', ownerId: seed?.ownerId ?? last.ownerId,
    } })
    return () => { attachmentSession.current++; useDraft.setState({ draft: null }) }
  }, [teamId, copyOf, seed])
  if (!draft) return null
  const wf = w.workflows[draft.workflowId]
  const missing = unstaffed(w, draft)
  const ready = !reading && draft.title.trim() && wf && missing.length === 0 && !blocked(needs)
  const start = (e: React.FormEvent) => {
    e.preventDefault()
    if (!ready || !draft.ownerId) return
    const { title, description, workflowId, staff, ownerId, images, files } = draft
    act((x) => void createTask(x, { teamId, title: title.trim(), description: description.trim(), workflowId, staff, ownerId, images, files }))
    onDone()
  }
  // a screenshot pasted into either text box comes in as a picture
  const paste = (e: React.ClipboardEvent) => {
    const files = [...e.clipboardData.files]
    if (!files.length) return
    e.preventDefault()
    void attach(files)
  }
  const images = [...(draft.images ?? []), ...(draft.files ?? [])]
  const attach = async (files: Iterable<File>) => {
    if (reading) return
    const session = attachmentSession.current
    const { fit, refused } = attachable([...files], MAX_ATTACHMENTS - images.length)
    setAttachmentError(refused ? tr('圖片最大 3.75MB，其他檔案最大 25MB，最多 6 個附件') : '')
    setReading(true)
    try {
      const more = await readAttachments(fit)
      // Do not add late reads to a different sheet.
      if (attachmentSession.current === session) editDraft((d) => splitAttachments([...(d.images ?? []), ...(d.files ?? []), ...more].slice(0, MAX_ATTACHMENTS)))
    } catch { setAttachmentError(tr('讀取附件失敗，請重試')) }
    finally { setReading(false) }
  }
  return (
    <form className="fx-d-form" onSubmit={start} onPaste={paste}>
      <header className="fx-d-head"><Heading {...h}>{tr('新增任務')}</Heading></header>
      <div className="fx-fields">
        <label className="fx-field">
          <span>{tr('標題')}</span>
          <input className="fx-control" value={draft.title} onChange={(e) => editDraft(() => ({ title: e.target.value }))} required />
        </label>
        <label className="fx-field fx-field-top">
          <span>{tr('說明#task')}</span>
          <div className="fx-mention-wrap">
            <MentionBox value={draft.description} teamId={teamId} label={tr('說明#task')} placeholder={tr('@ 選檔案，可直接貼上截圖')}
              rows={3} below onChange={(description) => editDraft(() => ({ description }))} />
          </div>
        </label>
        <div className="fx-field fx-field-top" role="group" aria-labelledby="fx-images-label">
          <span id="fx-images-label">{tr('附件')}</span>
          <div className="fx-thumbs">
            {images.map((im, i) => (
              <figure key={i} className={isImage(im) ? "fx-thumb" : "fx-file-wrap"}>
                {isImage(im) ? <img src={im.url} alt={im.name} /> : <FileAttachment file={im} />}
                <button type="button" className="fx-thumb-x" aria-label={tr('移除 {name}', { name: im.name })}
                  onClick={() => editDraft(() => splitAttachments(images.filter((_, j) => j !== i)))}>×</button>
              </figure>
            ))}
            <label className="fx-thumb fx-thumb-add fx-hit">
              <span aria-hidden="true">＋</span>
              <input type="file" disabled={reading} multiple className="fx-sr" aria-label={tr('加入附件')}
                onChange={(e) => { void attach(e.target.files ?? []); e.target.value = '' }} />
            </label>
          </div>
        </div>
        {attachmentError && <p role="alert" className="fx-room-warn">{attachmentError}</p>}
        <Select label={tr('任務流程')} value={draft.workflowId} options={flows.map((x) => x.id)} labelOf={(x) => w.workflows[x]?.name ?? x}
          {...mineAndBuiltIn(flows.map((x) => x.id))}
          rowOf={(id, on) => (
            <>
              <b>{w.workflows[id].name}</b>
              <span className="fx-check" aria-hidden="true">{on ? '✓' : ''}</span>
              <FlowPreview wf={w.workflows[id]} />
            </>
          )}
          onChange={(id) => editDraft((d) => {
            const last = lastStaff(useStore.getState().world, teamId, id)
            return { workflowId: id, ...last, ownerId: d.ownerId ?? last.ownerId }
          })} />
        {wf && <OwnerField teamId={teamId} draft={draft} />}
      </div>
      {wf && (
        <Section name={tr('人員')}>
          {draft.from !== null && <p className="fx-d-muted">{tr('沿用 #{from} 的配置', { from: draft.from })}</p>}
          <div className="fx-flow">
            <FlowNotes wf={wf} staff={(n) => draftStaff(w, draft, n)} open={open} onOpen={onOpen}
              canOpen={(n) => !isFixed(wf, n)} />
          </div>
        </Section>
      )}
      <p className="fx-d-actions">
        <button type="submit" className="fx-save" disabled={!ready}>{tr('開始')}</button>
        <Prereqs list={needs} />
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
  const [picked, setPicked] = useState<string[]>(() => (draft ? draftStaff(w, draft, node) : []))
  const n = wf && nodeOf(wf, node)
  if (!wf || !n) return <Gone {...h} />
  const crew = teamReplicas(w, teamId)
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))
  const save = (e: React.FormEvent) => {
    e.preventDefault()
    // keep the team's order, so faces line up the same way everywhere
    editDraft((d) => ({ staff: { ...d.staff, [node]: crew.map((r) => r.id).filter((id) => picked.includes(id)) } }))
    onDone()
  }
  return (
    <form className="fx-d-form" onSubmit={save}>
      <header className="fx-d-head">
        <Heading {...h}>{stepName(wf, node)}</Heading>
        <p className="fx-d-meta">
          <span>{wf.name}</span>
          {picked.length > 1 && <span>{tr('任務分派：{a}', { a: tr(ASSIGN[n.assignment]) })}</span>}
        </p>
      </header>
      {n.prompt && <p className="fx-d-text fx-d-quote">{n.prompt}</p>}
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
                      <ToolNotes bp={bp} />
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>
        ))}
      </div>
      <button type="submit" className="fx-save" disabled={picked.length === 0}>{tr('確定')}</button>
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
    act((x) => updateTask(x, id, { title: draft.title.trim(), description: draft.description.trim(), staff: draft.staff, ownerId: draft.ownerId }))
    onDone()
  }
  return (
    <form className="fx-d-form" onSubmit={save}>
      <header className="fx-d-head"><Heading {...h}>{tr('編輯 #{number}', { number: task.number })}</Heading></header>
      <div className="fx-fields">
        <label className="fx-field">
          <span>{tr('標題')}</span>
          <input className="fx-control" value={draft.title} onChange={(e) => editDraft(() => ({ title: e.target.value }))} required />
        </label>
        <label className="fx-field fx-field-top">
          <span>{tr('說明#task')}</span>
          <div className="fx-mention-wrap">
            <MentionBox value={draft.description} teamId={task.teamId} label={tr('說明#task')} placeholder={tr('@ 選檔案')}
              rows={3} below onChange={(description) => editDraft(() => ({ description }))} />
          </div>
        </label>
        <OwnerField teamId={task.teamId} draft={draft} />
      </div>
      <Section name={tr('人員')}>
        <div className="fx-flow">
          <FlowNotes wf={task.workflow} staff={(n) => draftStaff(w, draft, n)} open={open} onOpen={onOpen}
            canOpen={(n) => !isFixed(task.workflow, n)} />
        </div>
      </Section>
      <p className="fx-d-actions">
        <button type="submit" className="fx-save" disabled={!ready}>{tr('儲存')}</button>
        <Missing draft={draft} missing={missing.length} />
      </p>
    </form>
  )
}

/**
 * The task's owner on a task being written: it opens the same sheet as the 整理需求 and 驗收 notes, which
 * the owner works.
 */
function OwnerField({ teamId, draft }: { teamId: string; draft: TaskDraft }) {
  const w = useStore((s) => s.world)
  return (
    <div className="fx-owner-field">
      <CrewSelect label={tr('任務負責人')} value={draft.ownerId ?? ''} crew={teamReplicas(w, teamId)} placeholder={tr('選擇員工')} onChange={(id) => editDraft(() => ({ ownerId: id }))} />
      <button type="button" className="fx-save fx-plain fx-owner-apply" disabled={!draft.ownerId} onClick={() => editDraft((d) => ownerOnEveryStep(w, d))}>{tr('套用到所有節點')}</button>
    </div>
  )
}

/** What still keeps a task from starting: its owner first, then the steps nobody works. */
function Missing({ draft, missing }: { draft: TaskDraft; missing: number }) {
  if (!draft.ownerId) return <span className="fx-d-muted">{tr('還沒有任務負責人')}</span>
  return missing > 0 ? <span className="fx-d-muted">{tr('還有 {missing} 步沒有人', { missing })}</span> : null
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
        {MOCK ? <MockDoc doc={docOf(task, step, sub, path)} /> : <RealDoc sub={subId} path={path} />}
      </div>
    </>
  )
}

function MockDoc({ doc }: { doc: Doc }) {
  return doc.lang === 'code' ? <pre className="fx-doc-code"><code>{doc.text}</code></pre> : <Markdown text={doc.text} file />
}

/** The file as committed: a Markdown file rendered, anything else character for character, wrapped to stay on the note. */
function RealDoc({ sub, path }: { sub: string; path: string }) {
  const [state, setState] = useState<{ text?: string; error?: string }>({})
  useEffect(() => {
    const stop = new AbortController()
    setState({})
    readHandedFile(sub, path, stop.signal).then(
      (text) => setState({ text }),
      (e: Error) => { if (e.name !== 'AbortError') setState({ error: e.message }) },
    )
    return () => stop.abort()
  }, [sub, path])
  if (state.error) return <p className="fx-d-text" role="alert">{state.error}</p>
  if (state.text === undefined) return <p className="fx-d-text">{tr('讀取中…')}</p>
  if (/\.mdx?$/i.test(path)) return <Markdown text={state.text} file />
  return <pre className="fx-doc-code fx-doc-raw"><code>{state.text}</code></pre>
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

/** The round pencil in a sheet's upper right. */
function EditTool({ onClick, open }: { onClick: () => void; open?: boolean }) {
  return (
    <button type="button" className="fx-tool fx-hit" onClick={onClick} aria-expanded={open} aria-label={tr('編輯')} title={tr('編輯')}>
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
        <path d="M2.5 13.5l.6-3L10.6 3l2.4 2.4-7.5 7.5z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        <path d="M9 4.6l2.4 2.4" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    </button>
  )
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <rect x="5.5" y="5.5" width="8" height="8" rx="1" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10.5 3.2V2.5h-8v8h.7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
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
export function DeleteTool({ what, onConfirm, disabled, why }: { what: string; onConfirm: () => void; disabled?: boolean; why?: string }) {
  const [asking, setAsking] = useState(false)
  return (
    <button type="button" className={asking ? 'fx-tool fx-tool-ask fx-hit' : 'fx-tool fx-hit'} disabled={disabled}
      onClick={() => (asking ? onConfirm() : setAsking(true))} onBlur={() => setAsking(false)}
      aria-label={asking ? tr('確定刪除這個{what}', { what }) : tr('刪除')} title={disabled ? why : asking ? undefined : tr('刪除')}>
      {asking ? tr('確定刪除') : (
        <BinIcon />
      )}
    </button>
  )
}

/**
 * Write a flow: a new one (`id` null) or one the company has. Every step is written right here, in a list
 * under the drawing; clicking a note goes to its place in the list. Nothing is kept until it is saved.
 */
function FlowEdit({ id, onDone, ...h }: Head & {
  id: string | null
  onDone: () => void
}) {
  const w = useStore((s) => s.world)
  const act = useStore((s) => s.act)
  const draft = useFlowDraft((s) => s.draft)
  useEffect(() => {
    const s = useStore.getState().world
    const wf = id ? s.workflows[id] : undefined
    if (id && !wf) return
    const flow = wf ? structuredClone(wf) : blankFlow(s.language)
    useFlowDraft.setState({ draft: { flow, end: endOf(flow)?.id ?? '' } })
    return () => useFlowDraft.setState({ draft: null })
  }, [id])
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
    act((x) => saveWorkflow(x, id, {
      name: flow.name.trim(),
      nodes: flow.nodes.map((n) => ({ ...structuredClone(n), name: n.name.trim(), prompt: n.prompt.trim() })),
      edges: structuredClone(flow.edges),
    }))
    onDone()
  }
  return (
    <form className="fx-d-form" onSubmit={save}>
      <header className="fx-d-head"><Heading {...h}>{id ? tr('編輯 {name}', { name: w.workflows[id].name }) : tr('新增任務流程')}</Heading></header>
      <div className="fx-fields">
        <label className="fx-field">
          <span>{tr('名稱')}</span>
          <input className="fx-control" value={flow.name} required
            onChange={(e) => editFlowDraft((d) => ({ flow: { ...d.flow, name: e.target.value } }))} />
        </label>
      </div>
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
        <button type="button" className="fx-task fx-task-new fx-flow-new fx-hit" onClick={add}>{tr('＋ 新增步驟')}</button>
        <ol className="fx-d-steps">
          {order.current.map((x) => <StepForm key={x} flow={flow} end={end} id={x} />)}
        </ol>
      </div>
      <p className="fx-d-actions">
        <button type="submit" className="fx-save" disabled={!ready}>{id ? tr('儲存') : tr('建立')}</button>
        {cut.length > 0 && <span className="fx-d-muted">{tr('{a} 沒有接上', { a: listOf(cut.map((n) => n.name.trim() || tr('沒有名稱的步驟'))) })}</span>}
        {unnamed && <span className="fx-d-muted">{tr('有步驟沒有名稱')}</span>}
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
          ? <input className="fx-control fx-step-name" aria-label={tr('步驟名稱')} placeholder={tr('步驟名稱')} value={n.name} onChange={(e) => put({ name: e.target.value })} />
          : <h4>{n.name}</h4>}
        {middle && <DeleteTool what={tr('步驟')} onConfirm={() => editFlowDraft((d) => ({ flow: removeStep(d.flow, id) }))} />}
      </div>
      {!middle && <Owner />}
      <div className="fx-fields">
        {middle && (
          <>
            {/* a discussion has its own fixed instructions, and is held by one employee, so everyone working
                it is not offered; back to work, it starts with no instructions */}
            <Select label={tr('種類')} value={n.kind} options={Object.keys(KINDS)} labelOf={(x) => tr(KINDS[x as keyof typeof KINDS])}
              onChange={(x) => put(x === 'talk'
                ? { kind: 'talk', prompt: fixedSteps(useStore.getState().world.language).talkPrompt, ...(n.assignment === 'everyone' ? { assignment: 'firstAvailable' as const } : {}) }
                : { kind: 'work', prompt: '' })} />
            {n.kind !== 'talk' && (
              <label className="fx-field fx-field-top">
                <span>Prompt</span>
                <textarea className="fx-control" rows={2} value={n.prompt} onChange={(e) => put({ prompt: e.target.value })} />
              </label>
            )}
            <Select label={tr('任務分派')} value={n.assignment} options={Object.keys(ASSIGN).filter((x) => n.kind !== 'talk' || x !== 'everyone')}
              labelOf={(x) => tr(ASSIGN[x as keyof typeof ASSIGN])} onChange={(x) => put({ assignment: x as typeof n.assignment })} />
          </>
        )}
        {before > 1 && (
          <Select label={tr('開始條件')} value={n.join} options={Object.keys(JOIN)} labelOf={(x) => tr(JOIN[x as keyof typeof JOIN])}
            onChange={(x) => put({ join: x as typeof n.join })} />
        )}
        {next.length > 1 && (
          <Select label={tr('交接')} value={n.handoff} options={Object.keys(HANDOFF)} labelOf={(x) => tr(HANDOFF[x as keyof typeof HANDOFF])}
            onChange={(x) => put({ handoff: x as typeof n.handoff })} />
        )}
        {!isEnd && (
          <div className="fx-field fx-field-top" role="group" aria-label={tr('{a}的下一步', { a: n.name || tr('這一步') })}>
            <span>{tr('下一步')}</span>
            <div className="fx-d-picks">
              {choices.map((c) => (
                <button key={c.id} type="button" className="fx-hit" aria-pressed={next.includes(c.id)} onClick={() => toggle(c.id)}>
                  {next.includes(c.id) && <span aria-hidden="true">✓ </span>}{c.name.trim() || tr('沒有名稱')}
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
