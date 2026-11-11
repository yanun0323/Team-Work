import { attachable, FileAttachment, isImage, MAX_ATTACHMENTS, readAttachments, splitAttachments } from './attachments'
// The detail sheets: anything in the company file or the settings that can be opened (a task and its sub-tasks,
// a flow and its steps, an employee, a blueprint, importing a blueprint) is shown on a sheet taped over the upper left of the map. Sheets stack: editing an employee
// tapes an edit sheet over theirs, a little lower and to the right, and clicking the strip of the sheet
// below that still shows puts the top one away unsaved. They read the live world.

import { shownUrl } from './core/island'
import { colon, listOf, tr, trRecorded } from './core/i18n'
import { useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import { canSendBack, nodeOf } from './core/domain/graph'
import { blueprintUsers, gitSources, notStarted, statusOf, subsOf, swappable, type OwnSettings } from './core/domain/sim'
import { TOOLS, type Attachment, type Blueprint, type Chat, type BlueprintSource, type GitSource, type LocalSkills, type Look, type MemoryEntry, type ProviderKind, type Replica, type SkillPack, type Source, type SubTask, type Tool, type Workflow, type WorkflowNode, type World } from './core/domain/types'
import { keptState, sourceName, sourceState, sourceText, toolName } from './source'
import { composing } from './ime'
import { flowList, hireList, unhidden, activity, fmtClock, fmtTokens, layers, inEdges, lastSub, logText, outEdges, taskLines, teamReplicas, useStickToBottom } from './core/model'
import { useLiveText } from './core/live'
import { useNow, useStore } from './core/store'
import { PixelFace } from './core/voxel/PixelFace'
import { BlueprintIcon, pinLook } from './BlueprintIcon'
import { BlueprintSelect, byOrigin, crewOrder, CrewPicks, CrewRow, CrewSelect } from './Pickers'
import { seedOf } from './People'
import { Standee } from './Standee'
import { ordered, usePrefs, type LogOrder } from './prefs'
import { ClaudeAccount } from './ClaudeAccount'
import { Markdown, MarkdownLine } from './Markdown'
import { useAutoGrow, Select, Switcher, Toggle, WaitBadge } from './Controls'
import { changeAsk, ChangeLines } from './ChangeCard'
import { FlowNotes, openCard } from './FlowNotes'
import { copyDraft, customFlow, draftFlow, draftStaff, editCustom, editDraft, lastFlowId, lastStaff, ownerOnEveryStep, unstaffed, useDraft, type TaskDraft } from './draft'
import { blueprintGone, blueprintLabel, chatPreview, CONTEXT_UNKNOWN, providerWindow, DEFAULT_EFFORT, effortsOf, isCustom, mindOf, modelGroups, modelsOf, randomLook } from './crew'
import { docDiffOf, docOf, outputFile, type Doc } from './doc'
import { MOCK } from './core/mode'
import { githubAddress, parseGithub, shortRepo, wholeRef } from './github'
import { blueprintToYaml } from './blueprintYaml'
import { blocked } from './prereqs'
import { Prereqs, usePrereqs } from './PrereqStamps'
import { MentionBox } from './MentionBox'
import { ChatFaces } from './ChatFaces'
import { ALL, mentionedPeople, withAll } from './mentions'
import { SkillPicker } from './SkillPicker'
import { NewSource, SourceDetail } from './Sources'
import { authLabel, makesImages, mockThinking, PROVIDER_KINDS, providerUrl, SUBSCRIPTIONS } from './providers'
import { MAX_CHAT_PEOPLE, talking, talkPeople } from './core/domain/sim'
import { AIRPORT_BLUEPRINT, fixedSteps, isLocked } from './core/data/presets'
import { sourceOfId } from './core/domain/sources'
import type { SkillText, TalkEnd } from './core/domain/types'
import { addProvider, fixedContext, providerUsers, updateProvider, type ProviderLogin, DEFAULT_MODEL, RESOLVE_TIME, costLimit, taskTokens } from './core/domain/sim'
import { handedImageUrl, readHandedDiff, readHandedFile, request } from './core/backend'
import { DiffNote, useDocView, useRoomForSplit, ViewSwitch } from './HandedDiff'
import { tally, type DiffLine } from './diffView'
import { attempt, blueprintSkills, createTask, deleteBlueprint, deleteMemory, editMemory, deleteProvider, deleteTask, deleteTeam, deleteWorkflow, duplicateWorkflow, hideBlueprint, hideWorkflow, endTalk, fire, hire, pinChat, projectImageUrl, readChatSkill, readProjectFile, readSourceSkill, mergeTask, pauseTask, refreshModels, refreshStaleModels, resolveReview, resumeTask, returnTask, saveBlueprint, saveWorkflow, sayInTalk, updateReplica, updateTask } from './core/ops'
import { SubscriptionLogin } from './SubscriptionLogin'
import { NotesSheet } from './Notes'
import { FileDetail, FileEdit } from './FileSheets'
import { CodeFile } from './Highlight'
import { learn } from './tutorial'
import { ChatSheet, SentTo, type ChatTaskSeed } from './ChatSheet'
import { addStep, blankFlow, branchStep, canLink, insertStep, editFlowDraft, link, nextChoices, putStep, removeStep, unlink, useFlowDraft } from './flowDraft'
import { isOwnerTask } from './core/domain/owner'
import { OwnerRunFacts, OwnerTaskDetail, ReturnStep } from './TaskPanel'
import { FACT_KIND, SaidContext } from './Said'

export type Item =
  | { kind: 'task'; id: string }
  | { kind: 'sub'; id: string }
  | { kind: 'flow'; id: string }
  | { kind: 'taskFlow'; id: string }
  | { kind: 'crew'; id: string }
  /** A task's record (a decision or a constraint), by its id. */
  | { kind: 'fact'; id: string }
  | { kind: 'blueprint'; id: string }
  | { kind: 'crewEdit'; id: string }
  | { kind: 'newCrew' }
  | { kind: 'fire'; id: string }
  /** Deleting a blueprint employees are made from: they move to another one first. */
  | { kind: 'blueprintDelete'; id: string }
  /** With copyOf, the sheet starts filled in from that task. */
  | { kind: 'newTask'; copyOf?: string; seed?: ChatTaskSeed }
  | { kind: 'chat'; id: string }
  | { kind: 'newChat' }
  | { kind: 'staff'; node: string }
  | { kind: 'taskEdit'; id: string }
  | { kind: 'doc'; sub: string; path: string }
  /** A file in the company's folder as it is now, and a skill of someone in a chat, that a message mentions. */
  | { kind: 'file'; path: string }
  | { kind: 'fileEdit'; path: string }
  | { kind: 'skill'; chat: string; name: string }
  /** A picture at full width; `key` says where it was opened from, and `task` or `chat` what it belongs to. */
  | { kind: 'image'; key: string; image: Attachment; task?: string; chat?: string }
  | { kind: 'flowEdit'; id: string }
  | { kind: 'newFlow' }
  /** A step of the blueprint being written on the sheet under it. */
  | { kind: 'flowStep'; node: string }
  /** With copyOf, the sheet starts filled in from that blueprint. */
  | { kind: 'newBlueprint'; copyOf?: string }
  | { kind: 'provider'; id: string }
  | { kind: 'providerEdit'; id: string }
  | { kind: 'newProvider' }
  | { kind: 'blueprintEdit'; id: string }
  | { kind: 'disband' }
  /** The company's notes, from the note pinned to its file. */
  | { kind: 'notes' }
  | { kind: 'source'; id: string }
  /** One of a source's skills, by its path among the source's items. */
  | { kind: 'sourceSkill'; source: string; path: string }
  | { kind: 'newSource' }

export const itemKey = (x: Item) =>
  x.kind === 'newTask' ? `newTask:${x.copyOf ?? (x.seed ? 'chat' : '')}` : x.kind === 'newBlueprint' ? `newBlueprint:${x.copyOf ?? ''}` : x.kind === 'newChat' || x.kind === 'newFlow' || x.kind === 'newCrew' || x.kind === 'newProvider' || x.kind === 'disband' || x.kind === 'notes' || x.kind === 'newSource' ? x.kind : x.kind === 'staff' || x.kind === 'flowStep' ? `${x.kind}:${x.node}` : x.kind === 'doc' ? `doc:${x.sub}:${x.path}` : x.kind === 'file' || x.kind === 'fileEdit' ? `${x.kind}:${x.path}` : x.kind === 'skill' ? `skill:${x.chat}:${x.name}` : x.kind === 'sourceSkill' ? `sourceSkill:${x.source}:${x.path}` : x.kind === 'image' ? `image:${x.key}` : `${x.kind}::${x.id}`

const STATUS = { todo: '待辦', progressing: '進行中', review: '待回覆', complete: '完成' } as const
const HANDOFF = { pickOne: '交給其中一個下一步', all: '交給所有下一步' } as const
const JOIN = { any: '任一個前一步完成就開始', all: '所有前一步都完成才開始' } as const
/** What a step in the middle of a flow can be. */
const KINDS = { work: '員工執行', talk: '開會討論' } as const
/** The last lines of a log worth showing on a sheet this size. The backend sends each sub-task only this many (logShown). */
const LOG_LINES = 40

/** How far across each sheet in the stack sits, from the left (0) to right beside the company file (1). */
const SHEET_ACROSS = [0, 1, 1 / 3, 2 / 3]

export function Detail({ item, teamId, depth, covered, above, leaving, onGone, onBack, onDone, onClear, onPush, onOpen }: {
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
  /** Put every sheet away and open this one alone, as from the list. */
  onOpen: (x: Item) => void
}) {
  const title = useRef<HTMLHeadingElement>(null)
  const sheet = useRef<HTMLElement>(null)
  // a fresh sheet (it is keyed by item): move focus to its title, unless what is on it took the focus already (a chat's box)
  useEffect(() => {
    if (!sheet.current?.contains(document.activeElement)) title.current?.focus({ preventScroll: true })
  }, [])
  const id = `fx-detail-title-${depth}`
  // scrolled down: the sheet's tools get a strip of paper behind them, so what scrolls by does not run under them
  const [scrolled, setScrolled] = useState(false)
  return (
    <aside ref={sheet} id={depth === 0 ? 'fx-detail' : undefined} className={`fx-detail${leaving ? ' leaving' : ''}`}
      style={{ '--depth': depth, '--across': SHEET_ACROSS[depth] ?? 0 } as CSSProperties} aria-labelledby={id}
      aria-hidden={leaving || undefined} inert={leaving || undefined}
      onAnimationEnd={(e) => { if (leaving && e.target === e.currentTarget) onGone() }}>
      <span className="fx-tape fx-tape-l" aria-hidden="true" />
      <div className={`fx-sheet${scrolled ? ' fx-scrolled' : ''}`} inert={covered || undefined}>
        <div className="fx-detail-body" onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}>
          {item.kind === 'task' && (
            <TaskDetail id={item.id} title={title} tid={id} open={above?.kind === 'sub' ? above.id : null}
              onOpen={(x) => onPush({ kind: 'sub', id: x })} editing={above?.kind === 'taskEdit'}
              flowOpen={above?.kind === 'taskFlow'} onFlow={() => onPush({ kind: 'taskFlow', id: item.id })}
              onEdit={() => onPush({ kind: 'taskEdit', id: item.id })} onGoneTask={onDone}
              copying={above?.kind === 'newTask'} onCopy={() => onPush({ kind: 'newTask', copyOf: item.id })}
              crew={above?.kind === 'crew' ? above.id : null} onCrew={(x) => onPush({ kind: 'crew', id: x })} onFact={(x) => onPush({ kind: 'fact', id: x })}
              image={above?.kind === 'image' ? above.key : null} onImage={(key, image) => onPush({ kind: 'image', key, image, task: item.id })} />
          )}
          {item.kind === 'image' && <ImageDetail item={item} title={title} tid={id} />}
          {item.kind === 'taskFlow' && (
            <TaskFlow taskId={item.id} title={title} tid={id}
              crew={above?.kind === 'crew' ? above.id : null} onCrew={(x) => onPush({ kind: 'crew', id: x })} />
          )}
          {item.kind === 'sub' && (
            <SubDetail id={item.id} title={title} tid={id} open={above?.kind === 'doc' ? above.path : null}
              onOpen={(path) => onPush({ kind: 'doc', sub: item.id, path })}
              crew={above?.kind === 'crew' ? above.id : null} onCrew={(x) => onPush({ kind: 'crew', id: x })}
              onFact={(x) => onPush({ kind: 'fact', id: x })} />
          )}
          {item.kind === 'fact' && <FactDetail id={item.id} title={title} tid={id} />}
          {item.kind === 'doc' && <DocDetail sub={item.sub} path={item.path} title={title} tid={id} />}
          {item.kind === 'file' && (teamId && !MOCK
            ? <FileDetail teamId={teamId} path={item.path} title={title} tid={id} editing={above?.kind === 'fileEdit'}
                onEdit={() => onPush({ kind: 'fileEdit', path: item.path })} />
            : <ProjectFileDetail teamId={teamId} path={item.path} title={title} tid={id} />)}
          {item.kind === 'fileEdit' && <FileEdit teamId={teamId} path={item.path} title={title} tid={id} onDone={onDone} />}
          {item.kind === 'skill' && (
            <SkillDetail name={`$${item.name}`} at={`${item.chat}:${item.name}`} title={title} tid={id}
              read={(signal) => readChatSkill(useStore.getState().world, item.chat, item.name, signal)} />
          )}
          {item.kind === 'sourceSkill' && (
            <SkillDetail name={item.path.split('/').pop() ?? item.path} at={`${item.source}:${item.path}`} title={title} tid={id}
              read={(signal) => readSourceSkill(useStore.getState().world, item.source, item.path, signal)} />
          )}
          {item.kind === 'taskEdit' && (
            <TaskEdit id={item.id} teamId={teamId} title={title} tid={id} open={above?.kind === 'staff' ? above.node : null}
              onOpen={(node) => onPush({ kind: 'staff', node })} onDone={onDone} />
          )}
          {item.kind === 'flow' && (
            <FlowDetail id={item.id} title={title} tid={id} editing={above?.kind === 'flowEdit'}
              onEdit={() => onPush({ kind: 'flowEdit', id: item.id })} onGoneFlow={onDone} />
          )}
          {(item.kind === 'flowEdit' || item.kind === 'newFlow') && (
            <FlowEdit id={item.kind === 'flowEdit' ? item.id : null} title={title} tid={id} onDone={onDone}
              open={above?.kind === 'flowStep' ? above.node : null} onOpen={(node) => onPush({ kind: 'flowStep', node })} />
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
              onCopy={() => onPush({ kind: 'newBlueprint', copyOf: item.id })} onGoneBlueprint={onDone}
              deleting={above?.kind === 'blueprintDelete'} onDelete={() => onPush({ kind: 'blueprintDelete', id: item.id })} />
          )}
          {(item.kind === 'blueprintEdit' || item.kind === 'newBlueprint') && (
            <BlueprintEdit id={item.kind === 'blueprintEdit' ? item.id : null} copyOf={item.kind === 'newBlueprint' ? item.copyOf : undefined}
              title={title} tid={id} onDone={onDone} />
          )}
          {item.kind === 'source' && (
            <SourceDetail id={item.id} title={title} tid={id} open={above?.kind === 'sourceSkill' ? above.path : null}
              onSkill={(path) => onPush({ kind: 'sourceSkill', source: item.id, path })}
              openItem={above?.kind === 'blueprint' || above?.kind === 'flow' ? itemKey(above) : null} onItem={onPush} onGoneSource={onDone} />
          )}
          {item.kind === 'newSource' && <NewSource title={title} tid={id} onDone={onDone} />}
          {(item.kind === 'crewEdit' || item.kind === 'newCrew') && (
            <CrewEdit id={item.kind === 'crewEdit' ? item.id : null} teamId={teamId} title={title} tid={id} onDone={onDone} />
          )}
          {item.kind === 'fire' && <Fire id={item.id} title={title} tid={id} onDone={onClear} />}
          {item.kind === 'blueprintDelete' && <BlueprintDelete id={item.id} teamId={teamId} title={title} tid={id} onDone={onClear} />}
          {item.kind === 'newTask' && (
            <NewTask teamId={teamId} copyOf={item.copyOf} seed={item.seed} title={title} tid={id} open={above?.kind === 'staff' ? above.node : null}
              onOpen={(node) => onPush({ kind: 'staff', node })} image={above?.kind === 'image' ? above.key : null}
              onImage={(key, image) => onPush({ kind: 'image', key, image })} onDone={onDone} />
          )}
          {(item.kind === 'chat' || item.kind === 'newChat') && (
            <ChatSheet id={item.kind === 'chat' ? item.id : undefined} teamId={teamId} title={title} tid={id} creating={above?.kind === 'newTask'}
              crewOpen={above?.kind === 'crew'} onCrew={(x) => onPush({ kind: 'crew', id: x })}
              onFile={(path) => onPush({ kind: 'file', path })} onSkill={(chat, name) => onPush({ kind: 'skill', chat, name })}
              image={above?.kind === 'image' ? above.key : null} onImage={(key, image, chat) => onPush({ kind: 'image', key, image, chat })}
              onTask={(seed) => onPush({ kind: 'newTask', seed })} onHandOff={(x) => onOpen({ kind: 'chat', id: x })}
              chat={above?.kind === 'chat' ? above.id : null} onOpenChat={(x) => onPush({ kind: 'chat', id: x })}
              task={above?.kind === 'task' ? above.id : null} onOpenTask={(x) => onPush({ kind: 'task', id: x })}
              made={above?.kind === 'blueprint' || above?.kind === 'provider' ? above : above?.kind === 'flow' ? { kind: 'workflow', id: above.id } : null}
              onOpenMade={(x) => onPush({ kind: x.kind === 'workflow' ? 'flow' : x.kind, id: x.id })}
              onProvider={(x) => onPush({ kind: 'providerEdit', id: x })} onGoneChat={onDone} />
          )}
          {item.kind === 'disband' && <Disband teamId={teamId} title={title} tid={id} onDone={onDone} />}
          {item.kind === 'notes' && <NotesSheet teamId={teamId} title={title} tid={id} />}
          {item.kind === 'flowStep' && <FlowStepSheet node={item.node} title={title} tid={id} onDone={onDone} />}
          {item.kind === 'staff' && <StepSheet node={item.node} teamId={teamId} title={title} tid={id} onDone={onDone} />}
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
          {l.kind === 'say' || l.kind === 'think' ? <div className="fx-d-log-text"><Markdown text={l.text} /></div> : <span className="fx-d-log-plain">{l.text}</span>}
        </li>
      ))}
    </ol>
  )
}

function Bar({ value }: { value: number }) {
  return <span className="fx-d-bar" role="img" aria-label={`${Math.round(value * 100)}%`}><i style={{ width: `${value * 100}%` }} /></span>
}

/** A task someone asked for. The sub-tasks the employees made for it are listed here and open on their own sheet. */
function TaskDetail({ id, open, onOpen, flowOpen, onFlow, editing, onEdit, copying, onCopy, onGoneTask, crew, onCrew, onFact, image, onImage, ...h }: Head & {
  id: string
  /** The picture open on the sheet above, by its key, and how to open one. */
  image: string | null
  onImage: (key: string, image: Attachment) => void
  /** The employee open on the sheet above, and how to open one (the task's owner). */
  crew: string | null
  onCrew: (id: string) => void
  /** Opens a record its owner names by id. */
  onFact: (id: string) => void
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
  if (isOwnerTask(task)) {
    return <OwnerTaskDetail id={id} open={open} onOpen={onOpen} flowOpen={flowOpen} onFlow={onFlow} editing={editing} onEdit={onEdit} copying={copying}
      onCopy={onCopy} onGoneTask={onGoneTask} crew={crew} onCrew={onCrew} onFact={onFact} image={image} onImage={onImage} {...h} />
  }
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
          aria-label={tr(notStarted(task) ? '開始' : task.paused ? '繼續' : '暫停')} title={tr(notStarted(task) ? '開始' : task.paused ? '繼續' : '暫停')}>
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
          <span className="fx-pill">{task.stage === 'cancelled' ? tr('已停止') : task.paused && !notStarted(task) ? tr('已暫停') : task.stage === 'merging' ? tr('合併中') : tr(STATUS[status])}</span>
          {owner && (
            <span className="fx-d-owner">{tr('負責人')}
              <button type="button" className="fx-hit" aria-expanded={crew === owner.id} onClick={() => onCrew(owner.id)}>
                <PixelFace look={owner.look} name={owner.name} size={18} />{owner.name}
              </button>
            </span>
          )}
          {task.origin && <span>{tr('由 {name} 建立', { name: task.origin.kind === 'airport' ? tr('機場服務人員') : task.origin.name })}</span>}
          <span>Token {fmtTokens(taskTokens(w, task))}</span>
          {/* made before owners ran tasks: its flow runs itself, and the owner only merges */}
          <span className="fx-d-muted">{tr('舊制流程')}</span>
        </p>
      </header>
      {/* the drawing opens as a whole, as flows do in the company file: its title is the button */}
      <section className="fx-flow fx-flow-card fx-d-flowcard" onClick={openCard}>
        <h3><button type="button" className="fx-flow-open" aria-expanded={flowOpen} onClick={onFlow}>{flow}</button></h3>
        <FlowNotes wf={task.workflow} staff={staffOf} done={(n) => stepDone(subs, n)} />
      </section>
      <Section name={tr('進度')}>
        <Progress wf={task.workflow} subs={subs} open={open} onOpen={onOpen} />
        <MergeRow taskId={task.id} />
        <dl className="fx-d-facts"><dt>{tr('Token')}</dt><dd>{fmtTokens(taskTokens(w, task))}</dd></dl>
      </Section>
      {task.description && <div className="fx-doc-note"><Markdown text={task.description} /></div>}
      {task.images.length > 0 && (
        <div className="fx-thumbs">
          {task.images.map((im, i) => (
            <button key={i} type="button" className="fx-thumb fx-hit" aria-expanded={image === `task:${task.id}:${i}`} onClick={() => onImage(`task:${task.id}:${i}`, im)}>
              <img src={shownUrl(im.url)} alt={im.name} />
            </button>
          ))}
        </div>
      )}
      {!!task.files?.length && <div className="fx-thumbs">{task.files.map((file, i) => <FileAttachment key={i} file={file} />)}</div>}
      <Section name={tr('紀錄')}><Log lines={lines} /></Section>
    </>
  )
}

const stepName = (wf: Workflow, nodeId: string) => nodeOf(wf, nodeId)?.name ?? nodeId

/** A step's note colour, as on the flow drawing: a discussion blue, the rest white. */
const noteCls = (wf: Workflow, nodeId: string) => (nodeOf(wf, nodeId)?.kind === 'talk' ? ' fx-node-talk' : '')

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
  if (r.kind === 'change' && r.change) return changeAsk(r.change)
  if (r.kind === 'pickRoute') return tr('這一步做完了，但我不確定接下來要交給哪一步，請幫我選一個。')
  if (r.kind === 'failed') {
    if (r.reason === 'environment' && r.prompt) return r.prompt
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
      {r.options.length > 0 && <div className="fx-d-choices" role="group" aria-label={tr('選項')}>
        {r.options.map((o) => (
          <button key={o.id} type="button" aria-pressed={choice === o.id} className="fx-choice"
            title={o.detail || undefined} onClick={() => setChoice(choice === o.id ? '' : o.id)}>
            {o.label ?? trRecorded(`option.${o.id}`)}
          </button>
        ))}
      </div>}
      <textarea className="fx-control" rows={2} value={text} aria-label={tr('回覆')}
        placeholder={!question ? tr('補充說明') : r.options.length ? tr('回覆，或選上面一個') : tr('回覆')} onChange={(e) => setText(e.target.value)} />
      <div className="fx-d-merge-acts"><button type="submit" className="fx-save" disabled={!ready}>{tr('確認')}</button></div>
    </form>
  )
}

/**
 * A 使用者討論 step's conversation: the employees' messages on the left under their faces, the user's on the
 * right, and while it is open a box to write in (Enter sends, Shift+Enter starts a new line) and 結束討論.
 * Held by several, it is a meeting: "@" picks who replies, "@All" everyone, the chair last; with no one, the chair.
 * Ending asks how to go on: 繼續 (to which next step, when the step picks one of several), 退回 with a
 * reason, or 停止任務, which asks once more.
 */
function Chat({ sub }: { sub: SubTask }) {
  const w = useStore((s) => s.world)
  const act = useStore((s) => s.act)
  const [text, setText] = useState('')
  const box = useRef<HTMLTextAreaElement>(null)
  useAutoGrow(box, text)
  const [ending, setEnding] = useState<null | 'pick' | 'back' | 'stop'>(null)
  const [reason, setReason] = useState('')
  // the employee opens a discussion, so before their first words there is no talk yet
  const talk = sub.talk ?? { messages: [], replyAt: sub.startedAt ?? 0 }
  const task = w.tasks[sub.taskId]
  const wf = task.workflow
  const r = sub.replicaId ? w.replicas[sub.replicaId] : undefined
  const people = talkPeople(w, sub).map((id) => w.replicas[id])
  const meeting = people.length > 1
  const mentionable = meeting ? [ALL, ...people.map((x) => ({ id: x.id, name: x.name }))] : []
  const mentionRow = (id: string) => id === ALL.id ? (
    <>
      <ChatFaces people={people} size={26} />
      <span className="fx-row-main">
        <b className="fx-crew-head"><span className="fx-crew-name">{ALL.name}</span></b>
        <span>{listOf(people.map((x) => x.name))}</span>
      </span>
    </>
  ) : w.replicas[id] && <CrewRow r={w.replicas[id]} on chair={id === people[0]?.id} />
  // who said it: the one tagged, or in a discussion from before that, its one employee
  const by = (id?: string) => (id ? w.replicas[id] : undefined) ?? r
  const speaker = by(talk.speaker)
  const open = talking(sub) && task.stage === 'running'
  const writing = talk.replyAt !== undefined
  const live = useLiveText(sub.id)
  // the newest words in view, inside the chat's own scroll, unless the user scrolled up to read
  const [list, pin] = useStickToBottom<HTMLOListElement>(`${talk.messages.length}:${writing}:${live.length}`)
  const node = nodeOf(wf, sub.nodeId)
  const outs = outEdges(wf, sub.nodeId)
  // the step picks one of several next steps: going on names which
  const routes = node?.handoff === 'pickOne' && outs.length > 1 ? outs.map((e) => e.to) : null
  const mentionsIn = (words: string) => (meeting ? withAll(mentionedPeople(words, mentionable), people.slice(1).map((x) => x.id), people[0].id) : [])
  // who the message goes to as it is typed: those it mentions, or else the chair
  const sendTo = meeting && text.trim() ? (() => { const m = mentionsIn(text); return m.length ? m : [people[0].id] })().flatMap((id) => (w.replicas[id] ? [w.replicas[id]] : [])) : []
  const send = () => {
    if (!text.trim() || writing) return
    const mentions = mentionsIn(text)
    pin()
    act((x) => sayInTalk(x, sub.id, text, mentions))
    setText('')
  }
  const end = (e: TalkEnd) => {
    act((x) => endTalk(x, sub.id, e))
    setEnding(null)
  }
  const face = (p = r) => (p ? <PixelFace look={p.look} name={p.name} size={22} /> : <span className="fx-d-noface" />)
  const ENDED = { continue: tr('討論結束，繼續下一步'), back: tr('討論結束，退回重做'), stop: tr('討論結束，任務已停止') } as const
  return (
    <div className="fx-chat">
      <ol ref={list} className="fx-chat-log" aria-live="polite" aria-label={tr('和 {a} 的討論', { a: people.length ? listOf(people.map((x) => x.name)) : r?.name ?? tr('員工') })}>
        {talk.messages.map((m, i) => (
          <li key={i} className={`fx-chat-msg fx-chat-${m.from}`}>
            {m.from === 'agent' && face(by(m.by))}
            {m.from === 'agent'
              ? <div className="fx-chat-bubble"><span className="fx-sr">{by(m.by)?.name ?? tr('員工')}{colon()}</span><Markdown text={m.text} /></div>
              : <p className="fx-chat-bubble"><span className="fx-sr">{tr('你：')}</span>{m.text}</p>}
            <time>{fmtClock(m.at)}</time>
          </li>
        ))}
        {writing && (
          <li className="fx-chat-msg fx-chat-agent fx-chat-writing">
            {face(speaker)}
            <span className="fx-sr">{tr('{a} 正在回覆', { a: speaker?.name ?? tr('員工') })}</span>
            {live
              // read out when it is done, not piece by piece
              ? <div className="fx-chat-bubble" aria-hidden="true"><Markdown text={live} /></div>
              : <p><span className="fx-chat-dots" aria-hidden="true"><span /><span /><span /></span></p>}
          </li>
        )}
      </ol>
      {talk.ended && <p className="fx-d-muted">{ENDED[talk.ended]}</p>}
      {open && !ending && (
        <form className="fx-chat-say" onSubmit={(e) => { e.preventDefault(); send() }}>
          {sendTo.length > 0 && <SentTo people={sendTo} live />}
          {meeting ? (
            <div className="fx-mention-wrap">
              <MentionBox box={box} grow value={text} teamId={task.teamId} people={mentionable} personRow={mentionRow} label={tr('訊息')}
                placeholder={writing ? tr('{a} 正在回覆…', { a: speaker?.name ?? tr('員工') }) : tr('輸入訊息，@ 找員工，@All 所有人')} onChange={setText} onSend={send} />
            </div>
          ) : (
            <textarea ref={box} className="fx-control" rows={2} value={text} aria-label={tr('訊息')} placeholder={writing ? tr('{a} 正在回覆…', { a: speaker?.name ?? tr('員工') }) : tr('輸入訊息')}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                // Enter sends; not while a Chinese word is still being picked in the input method
                if (e.key === 'Enter' && !e.shiftKey && !composing(e.nativeEvent)) {
                  e.preventDefault()
                  send()
                }
              }} />
          )}
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
 * asks under the row what to change, and sends the work back to the steps before the last step.
 */
function MergeRow({ taskId }: { taskId: string }) {
  const now = useNow()
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
    : m!.conflict && now - m!.startedAt! < RESOLVE_TIME ? tr('解衝突中') : tr('合併中')
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
        ? <span className="fx-d-run fx-d-hand-text"><Bar value={(now - m!.startedAt!) / (m!.endsAt! - m!.startedAt!)} /><span className="fx-d-muted">{state}</span></span>
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
function FlowSteps({ blueprint, ...p }: Parameters<typeof StepList>[0] & { blueprint?: boolean }) {
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
    <div className={blueprint ? 'fx-blueprint fx-contents' : 'fx-contents'}>
      <div className="fx-flow"><FlowNotes wf={p.wf} staff={p.staff} done={p.done} onOpen={show} /></div>
      <StepList {...p} listRef={list} />
    </div>
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
            {staff && <Crew ids={staff(n.id)} open={crew} onOpen={onCrew} />}
            {n.prompt && n.kind !== 'talk' && <p className="fx-d-text">{n.prompt}</p>}
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
      {before > 1 && <><dt>{tr('開始條件')}</dt><dd>{tr(JOIN[n.join])}</dd></>}
      {next.length > 1 && <><dt>{tr('交接')}</dt><dd>{tr(HANDOFF[n.handoff])}</dd></>}
      {canSendBack(wf, id) && <><dt>{tr('退回')}</dt><dd>{tr('可以退回上一步')}</dd></>}
      <dt>{tr('下一步')}</dt><dd>{next.length ? listOf(next.filter((x) => x !== undefined)) : tr('結束')}</dd>
    </dl>
  )
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
function SubDetail({ id, open, onOpen, crew, onCrew, onFact, ...h }: Head & {
  id: string; open: string | null; onOpen: (path: string) => void
  /** The employee whose sheet lies on this one, if any. */
  crew: string | null; onCrew: (id: string) => void
  onFact: (id: string) => void
}) {
  const w = useStore((s) => s.world)
  const sub = w.subTasks[id]
  const task = sub && w.tasks[sub.taskId]
  if (!sub || !task) return <Gone {...h} />
  const wf = task.workflow
  const r = sub.replicaId ? w.replicas[sub.replicaId] : undefined
  // a meeting lists everyone in it, the chair first; any other step its one employee
  const held = nodeOf(wf, sub.nodeId)?.kind === 'talk' ? talkPeople(w, sub).map((id) => w.replicas[id]) : r ? [r] : []
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
      <SaidContext.Provider value={{ person: onCrew, canPerson: (x) => !!w.replicas[x], fact: onFact }}><OwnerRunFacts task={task} sub={sub} /></SaidContext.Provider>
      <ReturnStep key={sub.id} task={task} sub={sub} />
      {/* the user answers here: a discussion in its chat, anything else under what the employee asks; under an owner, in the task's conversation */}
      {(sub.talk || (nodeOf(wf, sub.nodeId)?.kind === 'talk' && sub.status === 'progressing')) && <Section name={tr('討論')}><Chat key={sub.id} sub={sub} /></Section>}
      {sub.review && sub.review.kind !== 'talk' && !isOwnerTask(task) && (
        <Section name={tr('等你回覆')}>
          <div className="fx-d-text-md fx-d-quote"><Markdown text={askText(w, sub)} /></div>
          {sub.review.change && <ChangeLines change={sub.review.change} />}
          <Reply key={sub.review.at} sub={sub} />
        </Section>
      )}
      <Section name={tr('負責員工')}>
        {held.length ? (
          <ul className="fx-list">
            {held.map((p, i) => (
              <li key={p.id}><button type="button" className="fx-row fx-hit" aria-expanded={crew === p.id} onClick={() => onCrew(p.id)}>
                <PixelFace look={p.look} name={p.name} size={34} />
                <span className="fx-row-main"><b className="fx-crew-head">{p.name}{held.length > 1 && i === 0 && <span className="fx-pill">{tr('主持人')}</span>}</b><span>{blueprintLabel(w, p)}</span></span>
              </button></li>
            ))}
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
          <dt>{tr('Token')}</dt><dd>{fmtTokens(sub.tokens)}</dd>
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
  const hidden = usePrefs((s) => s.hiddenWorkflows.includes(id))
  if (!wf) return <Gone {...h} />
  const remove = () => {
    onGoneFlow()
    act((x) => deleteWorkflow(x, id))
  }
  const tasks = Object.values(w.tasks).filter((t) => t.workflowId === wf.id && statusOf(w, t) !== 'complete')
  // where a flow that cannot be edited comes from, so it is plain why: its source, or 內建
  const from = sourceOfId(id)
  const origin = from ? (w.sources[from] ? sourceName(w.sources[from]) : from) : isLocked(id) ? tr('內建') : ''
  return (
    <>
      <div className="fx-tools">
        {!isLocked(id) && <EditTool onClick={onEdit} open={editing} />}
        <button type="button" className="fx-tool fx-hit" onClick={() => act((x) => void duplicateWorkflow(x, id))} aria-label={tr('複製')} title={tr('複製')}>
          <CopyIcon />
        </button>
        <HideTool hidden={hidden} onChange={(on) => act((x) => hideWorkflow(x, id, on))} />
        {!isLocked(id) && <DeleteTool what={tr('任務藍圖')} onConfirm={remove} />}
      </div>
      <header className="fx-d-head">
        <Heading {...h}>{wf.name}</Heading>
        <p className="fx-d-meta">
          {origin && <span className="fx-d-origin">{origin}</span>}
          <span>{tr('{length} 個步驟', { length: wf.nodes.length })}</span>
          <span>{tasks.length ? tr('{length} 個任務未完成', { length: tasks.length }) : tr('沒有未完成的任務')}</span>
        </p>
      </header>
      <FlowSteps wf={wf} blueprint />
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
            <span className={blueprintGone(w, r) ? 'fx-bp-gone' : undefined}>{blueprintLabel(w, r)}</span>
            <span>{mindOf(r)}</span>
            {doing ? <span className="fx-pill fx-pill-on">{doing}</span> : <span>{tr('沒有工作')}</span>}
          </p>
        </div>
      </header>
      {isCustom(w, r) && <BlueprintFacts bp={w.blueprints[r.blueprintId]} />}
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
    // the backend lets go of a deleted provider itself; the mock keeps preferences apart from the world
    if (MOCK && usePrefs.getState().imageProvider === id) usePrefs.getState().set({ imageProvider: '' })
  }
  return (
    <>
      <div className="fx-tools">
        {(p.auth.kind === 'apiKey' || p.auth.signedIn) && <RefreshModelsTool id={id} />}
        <EditTool onClick={onEdit} open={editing} />
        <DeleteTool what={tr('供應商')} onConfirm={remove} disabled={crew.length > 0} why={tr('還有 {length} 位員工使用這個供應商，無法刪除', { length: crew.length })} />
      </div>
      <header className="fx-d-head"><Heading {...h}>{p.name}</Heading></header>
      <Section name={tr('類型')}><p className="fx-d-text">{PROVIDER_KINDS[p.kind].label}</p></Section>
      <Section name={tr('連線方式')}><p className="fx-d-text">{authLabel(p)}</p></Section>
      {p.auth.kind === 'apiKey' && (
        <>
          <Section name={tr('Base URL')}><p className="fx-d-text"><code>{providerUrl(p)}</code></p></Section>
          <Section name={tr('API Key')}><p className="fx-d-text"><code>{p.auth.keyHint ? `••••${p.auth.keyHint}` : tr('沒有')}</code></p></Section>
        </>
      )}
      <Section name={tr('Context window')}><p className="fx-d-text"><code>{providerWindow(p).toLocaleString('en-US')}</code></p></Section>
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
 * Asks a provider for its models now, turning while it waits; the list comes back as a change to the world. It stays
 * focusable while it turns, so the keyboard does not lose its place; a second press then does nothing.
 */
function RefreshModelsTool({ id }: { id: string }) {
  const [busy, setBusy] = useState(false)
  const refresh = async () => {
    if (busy) return
    setBusy(true)
    await attempt(() => refreshModels(id))
    setBusy(false)
  }
  const label = busy ? tr('正在讀取模型') : tr('重新讀取模型')
  return (
    <button type="button" className="fx-tool fx-hit fx-spin-tool" aria-busy={busy} aria-label={label} title={label} onClick={refresh}>
      <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
        <path d="M13 8a5 5 0 1 1-1.46-3.54M12.8 2v3h-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  )
}

/** How many tokens a provider's models can read, typed or picked from the usual sizes; empty leaves the 128K guess. */
export function ContextWindowField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const id = useId()
  return (
    <div className="fx-field">
      <label htmlFor={id}>{tr('Context window')}</label>
      <span className="fx-unit">
        <input id={id} className="fx-control" type="number" inputMode="numeric" min={8_000} max={10_000_000} step={1_000} value={value}
          placeholder={String(CONTEXT_UNKNOWN)} onChange={(e) => onChange(e.target.value)} />
        {([['128K', 128_000], ['256K', 256_000], ['1M', 1_000_000]] as const).map(([label, n]) => (
          <button key={label} type="button" className="fx-window-pick fx-hit" aria-pressed={value === String(n)} onClick={() => onChange(String(n))}>{label}</button>
        ))}
      </span>
    </div>
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
  const [windowSize, setWindowSize] = useState(old?.contextWindow ? String(old.contextWindow) : '')
  const [key, setKey] = useState('')
  const [signedIn, setSignedIn] = useState(old?.auth.kind === 'subscription')
  const [loginError, setLoginError] = useState(false)
  // checked while it is the one that draws; a new one starts checked only when none does yet
  const [imageDefault, setImageDefault] = useState(() => {
    const now = usePrefs.getState().imageProvider
    return old ? now === old.id : !useStore.getState().world.providers[now]
  })
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
  const draws = makesImages({ kind, auth: { kind: auth } })
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
    const image = draws ? { imageDefault } : {}
    const contextWindow = fixedContext(kind) ? undefined : Number(windowSize) || 0
    if (!MOCK) {
      // the form stays open if the backend turns it down, for a key that does not work, say
      void attempt(async () => {
        if (made) await request('PATCH', `/providers/${made}`, { name, ...image })
        else if (old) await request('PATCH', `/providers/${old.id}`, { name, baseUrl: url, login, contextWindow, ...image })
        else {
          const p = await request<{ id: string }>('POST', '/providers', { name, kind, baseUrl: url, login: login ?? { kind: 'subscription' }, contextWindow, ...image })
          // Claude Code is signed in already by now; the backend only has to see it
          if (claude) await request('POST', `/providers/${p.id}/login`, {})
        }
        keepMade.current = true
        onDone()
      })
      return
    }
    const models = claude ? claudeModels : PROVIDER_KINDS[kind].models
    let saved = old?.id ?? ''
    act((x) => {
      if (old) updateProvider(x, old.id, { name, baseUrl: url, login, contextWindow })
      else saved = addProvider(x, { name, kind, baseUrl: url, login: login ?? { kind: 'subscription' }, models, thinking: mockThinking(kind, models), contextWindow }).id
    })
    // the mock keeps preferences apart from the world, so it follows the backend here
    const prefs = usePrefs.getState()
    if (draws && imageDefault) prefs.set({ imageProvider: saved })
    else if (prefs.imageProvider === saved) prefs.set({ imageProvider: '' })
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
            labelOf={(a) => (a === 'apiKey' ? tr('API Key') : tr('{sub} 訂閱', { sub }))} onChange={pickAuth} />
        )}
        <label className="fx-field">
          <span>{tr('名稱')}</span>
          <input className="fx-control" value={name} required pattern=".*\S.*" title={tr('名稱不可為空')}
            onChange={(e) => { setName(e.target.value); setNamed(true) }} />
        </label>
        {auth === 'apiKey' ? (
          <>
            <label className="fx-field">
              <span>{tr('Base URL')}</span>
              <input className="fx-control" type="url" value={url} required={custom} spellCheck={false} autoComplete="off"
                placeholder={PROVIDER_KINDS[kind].url || 'http://localhost:11434/v1'} onChange={(e) => setUrl(e.target.value)} />
            </label>
            <label className="fx-field">
              <span>{tr('API Key')}</span>
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
        {!fixedContext(kind) && <ContextWindowField value={windowSize} onChange={setWindowSize} />}
        {draws && <Toggle label={tr('作為預設圖片生成供應商')} checked={imageDefault} onChange={setImageDefault} />}
      </div>
      <button type="submit" className="fx-save">{old ? tr('儲存') : tr('新增')}</button>
    </form>
  )
}

function BlueprintDetail({ id, teamId, editing, copying, deleting, onEdit, onCopy, onGoneBlueprint, onDelete, ...h }: Head & {
  id: string
  teamId: string
  editing: boolean
  copying: boolean
  /** The sheet that moves its employees to another blueprint before deleting it is open. */
  deleting: boolean
  onEdit: () => void
  onCopy: () => void
  /** Called once the blueprint is deleted, to put its sheet away. */
  onGoneBlueprint: () => void
  /** Open that sheet, for a blueprint employees are made from. */
  onDelete: () => void
}) {
  const w = useStore((s) => s.world)
  const act = useStore((s) => s.act)
  const now = useNow()
  const bp = w.blueprints[id]
  const hidden = usePrefs((s) => s.hiddenBlueprints.includes(id))
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
        {!isLocked(id) && <EditTool onClick={onEdit} open={editing} />}
        <button type="button" className="fx-tool fx-hit" onClick={onCopy} aria-expanded={copying} aria-label={tr('複製')} title={tr('複製')}>
          <CopyIcon />
        </button>
        {id !== AIRPORT_BLUEPRINT && <HideTool hidden={hidden} onChange={(on) => act((x) => hideBlueprint(x, id, on))} />}
        {!isLocked(id) && (users > 0
          ? (
            <button type="button" className="fx-tool fx-hit" onClick={onDelete} aria-expanded={deleting} aria-label={tr('刪除')} title={tr('刪除')}>
              <BinIcon />
            </button>
          )
          : <DeleteTool what={tr('藍圖')} onConfirm={remove} />)}
      </div>
      <header className="fx-d-head fx-d-who">
        <BlueprintIcon look={bp.look} name={bp.name} size={52} />
        <Heading {...h}>{bp.name}</Heading>
      </header>
      <Section name={tr('來源')}><ul className="fx-src-list"><SourceRow source={sourceOfId(bp.id) ? w.sources[sourceOfId(bp.id)] ?? null : bp.source} now={now} /></ul></Section>
      <BlueprintFacts bp={bp} />
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

/** What those who work by a blueprint are given, to read: its prompt, note, skills and tools. */
function BlueprintFacts({ bp }: { bp: Blueprint }) {
  const now = useNow()
  const sources = useStore((s) => s.world.sources)
  // what each pack that takes every skill turns out to bring; read again whenever the packs change
  const packs = JSON.stringify(bp.skills)
  const [found, setFound] = useState<(string[] | null)[]>([])
  useEffect(() => {
    setFound([])
    if (!bp.skills.some((p) => !p.include)) return
    const ask = new AbortController()
    blueprintSkills(useStore.getState().world, bp.id, ask.signal).then(setFound, () => {})
    return () => ask.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bp.id, packs])
  return (
    <>
      {bp.prompt && <Section name={tr('Prompt')}><p className="fx-d-text fx-d-quote">{bp.prompt}</p></Section>}
      {bp.comment && <Section name={tr('備註')}><p className="fx-d-text">{bp.comment}</p></Section>}
      <Section name={tr('技能')}>
        {bp.skills.length === 0 ? <p className="fx-d-muted">{tr('沒有')}</p> : (
          <ul className="fx-src-list">
            {bp.skills.map((p, i) => (
              <SourceRow key={i} source={p.sourceId ? sources[p.sourceId] ?? null : p.source ?? null} folder={p.path} now={now}>
                <p className="fx-d-chips">
                  {/* every skill: what was read, or 全部 until then or when it cannot be read */}
                  {(p.include ?? found[i])?.map((x) => <span key={x}>{x}</span>) ?? <span className="fx-chip-all">{tr('全部')}</span>}
                  {found[i]?.length === 0 && !p.include && <span className="fx-chip-all">{tr('沒有')}</span>}
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
    </>
  )
}

/**
 * One place a blueprint reads from (`source` null: the blueprint's own repo), with whether its upstream
 * was found and how the last update went; `children` is what it brings, under it.
 */
function SourceRow({ source: given, folder, now, children }: {
  /** A source kept apart is shown as one, with `folder` its folder read. */
  source: BlueprintSource | LocalSkills | Source | null
  folder?: string
  now: number
  children?: React.ReactNode
}) {
  if (given && 'id' in given) {
    const state = keptState(given, now)
    return (
      <li className="fx-src">
        <p className="fx-src-head">
          <code>{[sourceName(given), folder].filter(Boolean).join(' / ')}</code>
          {given.kind === 'local' && <span className="fx-d-muted">{tr('本機')}</span>}
          {state && <span className={`fx-src-state fx-src-${state.tone}`}>{state.label}</span>}
        </p>
        {state?.note && <p className={state.tone === 'bad' ? 'fx-src-note fx-src-note-bad' : 'fx-src-note'}>{state.note}</p>}
        {children}
      </li>
    )
  }
  const source = given
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

/** Same repo at the same version and folder: the one already known keeps what is known about its upstream. */
const keepSource = (old: Blueprint | undefined, next: GitSource) =>
  (old ? gitSources(old) : []).find((s) => s.repo === next.repo && s.ref === next.ref && (s.path ?? '') === (next.path ?? '')) ?? next

/**
 * A blueprint as saved: what was read or kept, with the look picked on the form, which wins over the one it had.
 */
export function blueprintOf(id: string, look: Look, bp: Omit<Blueprint, 'id' | 'look'>): Blueprint {
  const { look: _was, ...rest } = bp as Partial<Blueprint>
  return { ...(rest as typeof bp), id, look }
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
  const [repo, setRepo] = useState(was?.kind === 'git' ? shortRepo(was.repo) : '')
  const [ref, setRef] = useState(was?.kind === 'git' ? was.ref : '')
  const [prompt, setPrompt] = useState(from?.prompt ?? '')
  const [comment, setComment] = useState(from?.comment ?? '')
  const [packs, setPacks] = useState<SkillPack[]>(from?.skills ?? [])
  const [tools, setTools] = useState<Tool[]>(from?.tools ?? ['readFile', 'writeFile'])
  const [name, setName] = useState(old?.name ?? (from ? (language === 'en' ? `${from.name} copy` : tr('{name} 副本', { name: from.name })) : ''))
  const [named, setNamed] = useState(!!from)
  // the face it is drawn with now, fixed, so the form shows the same one whatever name it goes by
  const [look, setLook] = useState<Look>(() => (old ? pinLook(old.look, old.name) : randomLook()))
  const [repoError, setRepoError] = useState(false)
  const repoField = useRef<HTMLInputElement>(null)
  if (id && !old) return <Gone {...h} />
  const follow = (src: string) => {
    if (!named) setName((src.split(/[/\\:]/).filter(Boolean).pop() ?? '').replace(/\.git$/, ''))
  }
  // an address becomes owner/repo, and the version in it goes to the version field
  const takeRepo = (text: string) => {
    const g = parseGithub(text)
    if (!g) return false
    setRepo(shortRepo(githubAddress(g)))
    // a blueprint is read from the top of its repo, so a folder in the address is part of the version
    if (g.ref) setRef(wholeRef(g))
    setRepoError(false)
    follow(g.repo)
    return true
  }
  const hash = () => Math.random().toString(16).slice(2, 9)
  const keep = (bp: Omit<Blueprint, 'id' | 'look'>) => {
    act((x) => saveBlueprint(x, id, (key) => blueprintOf(key, look, bp)))
    if (copyOf) learn('copyBlueprint')
    onDone()
  }
  const save = (e: React.FormEvent) => {
    e.preventDefault()
    const now = MOCK ? useStore.getState().world.now : Date.now() / 1000
    if (kind === 'local') {
      const form = { name: name.trim(), prompt: prompt.trim(), comment: comment.trim(), skills: packs, tools: TOOLS.filter((t) => tools.includes(t)) }
      return keep({ ...form, source: { kind: 'yaml', text: blueprintToYaml(form, useStore.getState().world.sources) } })
    }
    const g = parseGithub(repo)
    if (!g) {
      setRepoError(true)
      repoField.current?.focus()
      return
    }
    const version = (wholeRef(g) || ref).trim()
    // the simulator makes up a version; the backend finds the real one once the blueprint is saved
    const commit = MOCK ? hash() : ''
    const source = keepSource(old, {
      kind: 'git', repo: githubAddress(g), ref: version, commit, latestRef: version, latest: commit, private: false,
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
                placeholder={tr('留空為預設分支')} />
            </label>
          </>
        ) : (
          <>
            <label className="fx-field fx-field-top">
              <span>{tr('Prompt')}</span>
              <textarea className="fx-control" rows={8} value={prompt} placeholder={tr('可留空')} onChange={(e) => setPrompt(e.target.value)} />
            </label>
            <label className="fx-field fx-field-top">
              <span>{tr('備註')}</span>
              <textarea className="fx-control" rows={2} value={comment} placeholder={tr('可留空')} onChange={(e) => setComment(e.target.value)} />
            </label>
          </>
        )}
      </div>
      {kind === 'local' && (
        <>
          <SkillPicker packs={packs} onChange={setPacks} />
          <ToolPicks tools={tools} setTools={setTools} />
        </>
      )}
      <button type="submit" className="fx-save">{old ? tr('儲存') : tr('新增')}</button>
    </form>
  )
}

/** Which of the tools are allowed, to tick. */
function ToolPicks({ tools, setTools }: { tools: Tool[]; setTools: React.Dispatch<React.SetStateAction<Tool[]>> }) {
  return (
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
  // their own settings, when they work by those rather than a blueprint
  const mine = r && isCustom(w, r) ? w.blueprints[r.blueprintId] : undefined
  const listed = (x?: string) => (x && w.blueprints[x] && !w.blueprints[x].owner ? x : undefined)
  const [name, setName] = useState(() => r?.name ?? NAMES.find((n) => !Object.values(w.replicas).some((x) => x.name === n)) ?? 'Nova')
  const [mode, setMode] = useState<'blueprint' | 'custom'>(mine ? 'custom' : 'blueprint')
  // one whose blueprint is gone picks another here: none is picked for them
  const [bp, setBp] = useState(() => (r && blueprintGone(w, r) ? '' : listed(mine ? mine.from : r?.blueprintId) ?? unhidden(hireList(w), usePrefs.getState().hiddenBlueprints)[0]?.id ?? ''))
  // the settings of their own being written, and what they were copied from: theirs, or the blueprint copied
  const [base, setBase] = useState<Blueprint | undefined>(mine)
  const [prompt, setPrompt] = useState(mine?.prompt ?? '')
  const [packs, setPacks] = useState<SkillPack[]>(() => (mine ? ownPacks(mine) : []))
  const [tools, setTools] = useState<Tool[]>(mine?.tools ?? ['readFile', 'writeFile'])
  const [model, setModel] = useState(r?.model ?? (MOCK ? DEFAULT_MODEL : modelsOf(w)[0] ?? ''))
  const [effort, setEffort] = useState(r?.effort ?? DEFAULT_EFFORT)
  // what the model takes decides; another model that doesn't take this level starts on the default
  const levels = effortsOf(w, model)
  const level = levels.includes(effort) ? effort : DEFAULT_EFFORT
  const [look, setLook] = useState<Look>(() => r?.look ?? randomLook())
  // what a new hire needs may go while this is open; changing an employee needs nothing of it
  const needs = usePrereqs(teamId, 'crew').filter((x) => !id && x.blocks)
  if (id && !r) return <Gone {...h} />
  const picked = w.blueprints[bp]
  const from = base && (base.owner ? base.from : base.id)
  // filling in their own settings from a blueprint, or blank ones for none: what was written here gives way to it
  const take = (bpId: string) => {
    const b = w.blueprints[bpId]
    setBase(b)
    setPrompt(b?.prompt ?? '')
    setPacks(b ? ownPacks(b) : [])
    setTools(b?.tools ?? [])
  }
  const save = (e: React.FormEvent) => {
    e.preventDefault()
    let own: OwnSettings | undefined
    if (mode === 'custom') {
      const skills = packs
      const form = { name: name.trim(), prompt: prompt.trim(), comment: '', skills, tools: TOOLS.filter((t) => tools.includes(t)) }
      // a copy of a blueprint from GitHub keeps its repo, whose AGENTS.md stands in for an empty prompt
      const source: BlueprintSource = base?.source.kind === 'git' ? base.source : { kind: 'yaml', text: blueprintToYaml(form, w.sources) }
      own = { source, prompt: form.prompt, comment: '', skills, tools: form.tools, ...(from && { from }) }
    }
    act((x) => {
      if (!id) return void hire(x, teamId, own ? '' : bp, name.trim(), look, { model, effort: level }, own)
      updateReplica(x, id, { name: name.trim(), blueprintId: own ? x.replicas[id]?.blueprintId ?? bp : bp, model, effort: level, look }, own)
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
        <Select label={tr('模型')} value={model} options={modelsOf(w)} onChange={setModel} onOpen={refreshStaleModels}
          groups={modelGroups(w).map((g) => ({ label: g.label, count: g.models.length }))}
          groupOf={(m) => modelGroups(w).findIndex((g) => g.models.includes(m))} />
        <Select label={tr('思考等級')} value={level} options={levels} onChange={setEffort} />
        <Switcher label={tr('設定方式')} value={mode} options={['blueprint', 'custom'] as const}
          labelOf={(x) => (x === 'blueprint' ? tr('使用員工藍圖') : tr('自訂'))} onChange={setMode} />
        {mode === 'blueprint' ? <BlueprintSelect label={tr('員工藍圖#kind')} value={bp} onChange={setBp} /> : (
          <>
            <BlueprintSelect label={tr('從員工藍圖匯入')} value={listed(from) ?? ''} none onChange={take} />
            <label className="fx-field fx-field-top">
              <span>{tr('Prompt')}</span>
              <textarea className="fx-control" rows={8} value={prompt} onChange={(e) => setPrompt(e.target.value)}
                placeholder={base?.source.kind === 'git' ? tr('留空則使用 {repo} 的 AGENTS.md', { repo: shortRepo(base.source.repo) }) : tr('可留空')} />
            </label>
          </>
        )}
      </div>
      {mode === 'blueprint' ? picked && (
        <>
          {/* what the blueprint gives, read only, set apart from what is filled in here */}
          <div className="fx-bp-facts"><BlueprintFacts bp={picked} /></div>
        </>
      ) : (
        <>
          <SkillPicker key={from ?? ''} packs={packs} onChange={setPacks} />
          <ToolPicks tools={tools} setTools={setTools} />
        </>
      )}
      <Prereqs list={needs} />
      <button type="submit" className="fx-save" disabled={!name.trim() || (mode === 'blueprint' && !bp) || blocked(needs)}>{r ? tr('儲存') : tr('新增')}</button>
    </form>
  )
}

/** A blueprint's skill packs, each naming where it reads from: those of its own repo name the repo. */
function ownPacks(bp: Blueprint): SkillPack[] {
  const own = bp.source.kind === 'git' ? bp.source : null
  return bp.skills.flatMap((p) => (p.sourceId || p.source ? [p] : own ? [{ ...p, source: own }] : []))
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
  const steps = staffedOn(w, r)
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
        <ul className="fx-list">
          {crewOrder(w, others).map((x) => (
            <li key={x}>
              <button type="button" className="fx-row fx-hit" aria-pressed={heir === x} onClick={() => setHeir(x)}>
                <CrewRow r={w.replicas[x]} on={heir === x} />
              </button>
            </li>
          ))}
        </ul>
      </Section>
      <button type="submit" className="fx-save" disabled={!heir}>{tr('交接並解僱')}</button>
    </form>
  )
}

/**
 * Delete a blueprint employees are made from. Everyone on it, in every company, moves to the one picked here first;
 * their names, looks, models and memories stay.
 */
function BlueprintDelete({ id, teamId, onDone, ...h }: Head & { id: string; teamId: string; onDone: () => void }) {
  const w = useStore((s) => s.world)
  const act = useStore((s) => s.act)
  const [to, setTo] = useState('')
  const bp = w.blueprints[id]
  if (!bp) return <Gone {...h} />
  const users = blueprintUsers(w, id)
  const go = (e: React.FormEvent) => {
    e.preventDefault()
    if (!to) return
    onDone()
    act((x) => void deleteBlueprint(x, id, to))
  }
  return (
    <form className="fx-d-form" onSubmit={go}>
      <header className="fx-d-head fx-d-who">
        <BlueprintIcon look={bp.look} name={bp.name} size={52} />
        <Heading {...h}>{tr('刪除 {name}', { name: bp.name })}</Heading>
      </header>
      <Section name={tr('使用中的員工')}>
        {users.length === 0 ? <p className="fx-d-muted">{tr('沒有人')}</p> : (
          <ul className="fx-d-people">
            {users.map((r) => (
              <li key={r.id}>
                <PixelFace look={r.look} name={r.name} size={26} /><b>{r.name}</b>
                {r.teamId !== teamId && <span>{w.teams[r.teamId]?.name}</span>}
              </li>
            ))}
          </ul>
        )}
      </Section>
      <div className="fx-fields">
        <BlueprintSelect label={tr('轉移到')} value={to} exclude={id} onChange={setTo} />
      </div>
      <button type="submit" className="fx-save" disabled={!to}>{tr('轉移並刪除')}</button>
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
function NewTask({ teamId, copyOf, seed, open, onOpen, image, onImage, onDone, ...h }: Head & {
  teamId: string
  /** The task to start from, if it is a copy. */
  copyOf?: string
  /** What a chat came to, if it starts from one. */
  seed?: ChatTaskSeed
  open: string | null
  onOpen: (nodeId: string) => void
  /** The attached picture open on the sheet above, by its key, and how to open one. */
  image: string | null
  onImage: (key: string, image: Attachment) => void
  onDone: () => void
}) {
  const w = useStore((s) => s.world)
  const act = useStore((s) => s.act)
  const draft = useDraft((s) => s.draft)
  const [reading, setReading] = useState(false)
  const [attachmentError, setAttachmentError] = useState('')
  const attachmentSession = useRef(0)
  // the flow of the task's own last saved as a blueprint, so saving again waits for a change
  const [saved, setSaved] = useState<Workflow | null>(null)
  const hiddenFlows = usePrefs((s) => s.hiddenWorkflows)
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
  const { custom } = draft
  // hidden flows are not offered, but the one this draft is on stays
  const flowIds = unhidden(flowList(w), hiddenFlows, custom ? undefined : draft.workflowId).map((x) => x.id)
  const flowGroups = byOrigin(flowIds, w.sources)
  const wf = draftFlow(w, draft)
  const missing = unstaffed(w, draft)
  const unnamed = !!custom?.nodes.some((n) => !n.name.trim())
  const flowReady = custom ? !!custom.name.trim() && !unnamed : !!wf
  const ready = !reading && draft.title.trim() && flowReady && missing.length === 0 && !blocked(needs)
  const start = (e: React.FormEvent) => {
    e.preventDefault()
    if (!ready || !draft.ownerId) return
    const { title, description, workflowId, staff, ownerId, images, files } = draft
    const workflow = custom && trimmedFlow(custom)
    act((x) => void createTask(x, { teamId, title: title.trim(), description: description.trim(), workflowId, workflow, staff, ownerId, images, files, chatId: seed?.chatId }))
    if (seed) learn('chatTask')
    onDone()
  }
  // a blueprint to run on, its staff from the company's last task on it
  const onFlow = (id: string, own: boolean) => {
    editDraft((d) => {
      const s = useStore.getState().world
      const last = lastStaff(s, teamId, id)
      return { workflowId: id, custom: own ? customFlow(s, id) : undefined, ...last, ownerId: d.ownerId ?? last.ownerId }
    })
  }
  // to a flow of its own, blank until a blueprint is imported; back to a blueprint, the one imported, or the last
  // one chosen
  const blank = () => editDraft(() => ({ workflowId: '', custom: customFlow(useStore.getState().world, ''), staff: {}, from: null }))
  const setMode = (mode: 'blueprint' | 'custom') => {
    const s = useStore.getState().world
    if (mode === 'custom') blank()
    else onFlow(s.workflows[draft.workflowId] ? draft.workflowId : lastFlowId(s, teamId), false)
  }
  // a step just made goes into the flow; one made with ＋ also opens on its sheet, ready to be written
  const made = ([next, id]: [Workflow, string], open = false) => {
    if (!id) return
    editCustom(() => next)
    if (open) onOpen(id)
  }
  const keep = () => {
    if (!custom) return
    act((x) => saveWorkflow(x, null, trimmedFlow(custom)))
    setSaved(custom)
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
    setAttachmentError(refused ? tr('附件每個最大 25MB，最多 6 個') : '')
    setReading(true)
    try {
      const { added, refused: tooLarge } = await readAttachments(fit)
      // Do not add late reads to a different sheet.
      if (attachmentSession.current !== session) return
      if (tooLarge) setAttachmentError(tr('附件每個最大 25MB，最多 6 個'))
      editDraft((d) => splitAttachments([...(d.images ?? []), ...(d.files ?? []), ...added].slice(0, MAX_ATTACHMENTS)))
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
            <MentionBox value={draft.description} teamId={teamId} label={tr('說明#task')} placeholder={tr('# 選檔案，可直接貼上截圖')}
              rows={3} below onChange={(description) => editDraft(() => ({ description }))} />
          </div>
        </label>
        <div className="fx-field fx-field-top" role="group" aria-labelledby="fx-images-label">
          <span id="fx-images-label">{tr('附件')}</span>
          <div className="fx-thumbs">
            {images.map((im, i) => (
              <figure key={i} className={isImage(im) ? "fx-thumb" : "fx-file-wrap"}>
                {isImage(im)
                  ? (
                    <button type="button" className="fx-thumb-open" aria-expanded={image === `newTask:${i}`} onClick={() => onImage(`newTask:${i}`, im)}>
                      <img src={shownUrl(im.url)} alt={im.name} />
                    </button>
                  )
                  : <FileAttachment file={im} />}
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
        {wf && <OwnerField teamId={teamId} draft={draft} />}
        <Switcher label={tr('流程')} value={custom ? 'custom' : 'blueprint'} options={['blueprint', 'custom'] as const}
          labelOf={(x) => (x === 'blueprint' ? tr('使用任務藍圖') : tr('自訂'))} onChange={setMode} />
        <Select label={custom ? tr('從任務藍圖匯入') : tr('任務藍圖')} value={draft.workflowId}
          // importing may also start from none: a blank flow
          options={custom ? ['', ...flowIds] : flowIds} groups={flowGroups.groups}
          groupOf={(x) => (x ? flowGroups.groupOf(x) : -1)}
          labelOf={(x) => (x ? w.workflows[x]?.name ?? x : tr('無'))}
          shownAs={(x) => w.workflows[x]?.name ?? <span className="fx-d-muted">{tr(custom ? '無' : '沒有')}</span>}
          onChange={(id) => (id ? onFlow(id, !!custom) : blank())} />
        {custom && (
          <label className="fx-field">
            <span>{tr('名稱')}</span>
            <input className="fx-control" value={custom.name} required onChange={(e) => editCustom((f) => ({ ...f, name: e.target.value }))} />
          </label>
        )}
      </div>
      {wf && (
        // a task blueprint is set apart in a dashed box, as a blueprint is on the employee form
        <div className={custom ? undefined : 'fx-bp-facts'}>
        <Section name={custom ? tr('流程') : tr('人員')}>
          {draft.from !== null && <p className="fx-d-muted">{tr('沿用 #{from} 的配置', { from: draft.from })}</p>}
          {custom ? (
            <div className="fx-d-flowedit">
              <div className="fx-flow">
                <FlowNotes wf={custom} staff={(n) => draftStaff(w, draft, n)} open={open} onOpen={onOpen} edit={{
                  canLink: (a, b) => canLink(custom, a, b),
                  link: (a, b) => editCustom((f) => link(f, a, b)),
                  unlink: (e) => editCustom((f) => unlink(f, e)),
                  branch: (from) => made(branchStep(custom, from)),
                  insert: (e) => made(insertStep(custom, e)),
                  remove: (n) => editCustom((f) => removeStep(f, n)),
                }} />
              </div>
              <button type="button" className="fx-task fx-task-new fx-flow-new fx-hit" onClick={() => made(addStep(custom), true)}>{tr('＋ 新增步驟')}</button>
              <p className="fx-d-actions">
                <button type="button" className="fx-save fx-plain" disabled={!flowReady || saved === custom} onClick={keep}>
                  {saved === custom ? tr('已存成任務藍圖') : tr('存成任務藍圖')}
                </button>
              </p>
            </div>
          ) : (
            <div className="fx-flow">
              <FlowNotes wf={wf} staff={(n) => draftStaff(w, draft, n)} open={open} onOpen={onOpen} />
            </div>
          )}
        </Section>
        </div>
      )}
      <p className="fx-d-actions">
        <button type="submit" className="fx-save" disabled={!ready}>{tr('建立任務')}</button>
        <Prereqs list={needs} />
        {unnamed ? <span className="fx-d-muted">{tr('有步驟沒有名稱')}</span> : wf && <Missing draft={draft} missing={missing.length} />}
      </p>
    </form>
  )
}

/**
 * One step of the task being written, on the sheet over it: who works it (one employee on a work step; on a
 * discussion one, or several who hold it as a meeting, the first picked chairing), and on a flow of the task's own,
 * the step itself. Every change counts at once; 完成 only puts the sheet away.
 */
function StepSheet({ node, teamId, onDone, ...h }: Head & { node: string; teamId: string; onDone: () => void }) {
  const w = useStore((s) => s.world)
  const draft = useDraft((s) => s.draft)
  const wf = draft && draftFlow(w, draft)
  const n = wf && nodeOf(wf, node)
  if (!draft || !wf || !n) return <Gone {...h} />
  const own = !draft.taskId && draft.custom ? draft.custom : null
  const crew = teamReplicas(w, teamId)
  const picked = draftStaff(w, draft, node).filter((id) => w.replicas[id])
  // in the order picked, as the first chairs a discussion
  const pick = (ids: string[]) => editDraft((d) => ({ staff: { ...d.staff, [node]: ids } }))
  return (
    <div className="fx-d-form">
      <header className="fx-d-head">
        {own ? (
          <div className="fx-step-head">
            <Heading {...h}><span className="fx-sr">{n.name || tr('這一步')}</span></Heading>
            <StepName flow={own} id={node} edit={editCustom} />
            {own.nodes.length > 1 && <DeleteTool what={tr('步驟')} onConfirm={() => { onDone(); editCustom((f) => removeStep(f, node)) }} />}
          </div>
        ) : (
          <>
            <Heading {...h}>{stepName(wf, node)}</Heading>
            <p className="fx-d-meta"><span>{wf.name}</span></p>
          </>
        )}
      </header>
      {!own && n.prompt && <p className="fx-d-text fx-d-quote">{n.prompt}</p>}
      <div className="fx-fields">
        {n.kind === 'talk'
          ? <CrewPicks label={tr('人員')} value={picked} crew={crew} max={MAX_CHAT_PEOPLE} placeholder={tr('選擇員工')} onChange={pick} />
          : <CrewSelect label={tr('人員')} value={picked[0] ?? ''} crew={crew} placeholder={tr('選擇員工')} onChange={(id) => pick([id])} />}
      </div>
      {own && <StepFields flow={own} id={node} edit={editCustom} />}
      <p className="fx-d-actions">
        <button type="button" className="fx-save" onClick={onDone}>{tr('完成#button')}</button>
      </p>
    </div>
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
  // someone already on a step comes off it: say whether they finish it or hand it over now
  const swapping = swappable(w, id, draft.staff).length > 0
  const save = (swap: boolean) => {
    if (!ready) return
    act((x) => updateTask(x, id, { title: draft.title.trim(), description: draft.description.trim(), staff: draft.staff, ownerId: draft.ownerId, swap }))
    onDone()
  }
  return (
    <form className="fx-d-form" onSubmit={(e) => { e.preventDefault(); save(false) }}>
      <header className="fx-d-head"><Heading {...h}>{tr('編輯 #{number}', { number: task.number })}</Heading></header>
      <div className="fx-fields">
        <label className="fx-field">
          <span>{tr('標題')}</span>
          <input className="fx-control" value={draft.title} onChange={(e) => editDraft(() => ({ title: e.target.value }))} required />
        </label>
        <label className="fx-field fx-field-top">
          <span>{tr('說明#task')}</span>
          <div className="fx-mention-wrap">
            <MentionBox value={draft.description} teamId={task.teamId} label={tr('說明#task')} placeholder={tr('# 選檔案')}
              rows={3} below onChange={(description) => editDraft(() => ({ description }))} />
          </div>
        </label>
        <OwnerField teamId={task.teamId} draft={draft} />
      </div>
      <Section name={tr('人員')}>
        <div className="fx-flow">
          <FlowNotes wf={task.workflow} staff={(n) => draftStaff(w, draft, n)} open={open} onOpen={onOpen}
            done={(n) => subsOf(w, id).some((s) => s.skipped && !s.cancelled && s.nodeId === n)} />
        </div>
      </Section>
      <p className="fx-d-actions">
        <button type="submit" className={swapping ? 'fx-save fx-plain' : 'fx-save'} disabled={!ready}>{swapping ? tr('儲存，下一步起生效') : tr('儲存')}</button>
        {swapping && <button type="button" className="fx-save" disabled={!ready} onClick={() => save(true)}>{tr('儲存並立刻換人')}</button>}
        <Missing draft={draft} missing={missing.length} />
      </p>
    </form>
  )
}

/** The task's owner on a task being written: who answers for the task, and who can be put on every step at once. */
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

/**
 * A file an employee handed on, as it reads, or compared with how it was when the step began, when it was there
 * then.
 */
function DocDetail({ sub: subId, path, ...h }: Head & { sub: string; path: string }) {
  const w = useStore((s) => s.world)
  const [view, setView] = useDocView()
  const note = useRef<HTMLDivElement>(null)
  const room = useRoomForSplit(note)
  const fetched = useHandedDiff(subId, path)
  const sub = w.subTasks[subId]
  const task = sub && w.tasks[sub.taskId]
  if (!sub || !task) return <Gone {...h} />
  const step = stepName(task.workflow, sub.nodeId)
  const r = sub.replicaId ? w.replicas[sub.replicaId] : undefined
  const doc = MOCK ? docOf(task, step, sub, path) : undefined
  const lines = doc ? docDiffOf(doc) : fetched
  const compare = lines?.length ? lines : null
  const shown = !compare ? 'read' : view === 'split' && !room ? 'stacked' : view
  const change = compare && tally(compare)
  return (
    <>
      {compare && <ViewSwitch view={shown} onView={setView} split={room} />}
      <header className="fx-d-head">
        <Heading {...h}>{path.split('/').pop()}</Heading>
        <p className="fx-d-meta">
          <code>{path}</code>
          <span>{step}{r ? ` · ${r.name}` : ''}</span>
          {sub.handoff && <code>{sub.handoff.commit}</code>}
          {change && <span className="fx-diff-tally"><ins>+{change.added}</ins> <del>−{change.removed}</del></span>}
        </p>
      </header>
      {/* the file itself, on a white sticky note */}
      <div ref={note} className="fx-doc-note">
        {compare && shown !== 'read' ? <DiffNote lines={compare} split={shown === 'split'} />
          : doc ? <MockDoc doc={doc} /> : <RealDoc sub={subId} path={path} />}
      </div>
    </>
  )
}

/**
 * A handed file compared with how it was when its step began; null while it is read, and when it cannot be compared
 * (new, a picture, or unreadable), as reading it then is all there is.
 */
function useHandedDiff(sub: string, path: string) {
  const [lines, setLines] = useState<DiffLine[] | null>(null)
  useEffect(() => {
    setLines(null)
    if (MOCK || /\.(png|jpe?g|gif|webp)$/i.test(path)) return
    const stop = new AbortController()
    readHandedDiff(sub, path, stop.signal).then(setLines, () => { /* reading the file says what is wrong */ })
    return () => stop.abort()
  }, [sub, path])
  return lines
}

function MockDoc({ doc }: { doc: Doc }) {
  return doc.lang === 'code' ? <pre className="fx-doc-code"><code>{doc.text}</code></pre> : <Markdown text={doc.text} file />
}

/** The file as committed: a Markdown file rendered, anything else character for character, wrapped to stay on the note. */
function RealDoc({ sub, path }: { sub: string; path: string }) {
  return /\.(png|jpe?g|gif|webp)$/i.test(path) ? <HandedImage sub={sub} path={path} /> : <HandedText sub={sub} path={path} />
}

/** A picture as committed; the backend refuses anything that is not one. */
function HandedImage({ sub, path }: { sub: string; path: string }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [sub, path])
  if (failed) return <p className="fx-d-text" role="alert">{tr('{name} 讀不到，請到專案資料夾打開', { name: path.split('/').pop() ?? path })}</p>
  return <img className="fx-d-image" src={handedImageUrl(sub, path)} alt={path} onError={() => setFailed(true)} />
}

function HandedText({ sub, path }: { sub: string; path: string }) {
  return <ReadText path={path} read={(signal) => readHandedFile(sub, path, signal)} at={`${sub}:${path}`}
    imageUrl={(p) => handedImageUrl(sub, p)} />
}

/**
 * A text file read from wherever `read` takes it, read again when `at` changes: Markdown rendered, with its HTML and its
 * own pictures (from `imageUrl`), anything else as it is.
 */
function ReadText({ path, read, at, imageUrl }: {
  path: string; read: (signal: AbortSignal) => Promise<string>; at: string; imageUrl: (path: string) => string
}) {
  const [state, setState] = useState<{ text?: string; error?: string }>({})
  useEffect(() => {
    const stop = new AbortController()
    setState({})
    read(stop.signal).then(
      (text) => setState({ text }),
      (e: Error) => { if (e.name !== 'AbortError') setState({ error: e.message }) },
    )
    return () => stop.abort()
  }, [at])
  if (state.error) return <p className="fx-d-text" role="alert">{state.error}</p>
  if (state.text === undefined) return <p className="fx-d-text">{tr('讀取中…')}</p>
  if (/\.mdx?$/i.test(path)) {
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
    return <Markdown text={state.text} project={{ dir, imageUrl }} />
  }
  return <CodeFile path={path} text={state.text} />
}

/** A file in the company's folder that a message mentions, as it is on disk now. */
function ProjectFileDetail({ teamId, path, ...h }: Head & { teamId: string; path: string }) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [teamId, path])
  const name = path.split('/').pop() ?? path
  return (
    <>
      <header className="fx-d-head">
        <Heading {...h}>{name}</Heading>
        <p className="fx-d-meta"><code>{path}</code></p>
      </header>
      <div className="fx-doc-note">
        {!MOCK && /\.(png|jpe?g|gif|webp)$/i.test(path)
          ? (failed
            ? <p className="fx-d-text" role="alert">{teamId ? tr('{name} 讀不到，請到專案資料夾打開', { name }) : tr('{name} 讀不到，請到 Finder 打開', { name })}</p>
            : <img className="fx-d-image" src={projectImageUrl(teamId, path)} alt={path} onError={() => setFailed(true)} />)
          : <ReadText path={path} read={(signal) => readProjectFile(teamId, path, signal)} at={`${teamId}:${path}`}
              imageUrl={(p) => projectImageUrl(teamId, p)} />}
      </div>
    </>
  )
}

/** A task's record: its kind, the whole of it, and the task that keeps it. */
function FactDetail({ id, ...h }: Head & { id: string }) {
  const w = useStore((s) => s.world)
  for (const task of Object.values(w.tasks)) {
    const fact = task.coordination?.facts.find((f) => f.id === id)
    if (!fact) continue
    return (
      <>
        <header className="fx-d-head">
          <Heading {...h}>{tr(FACT_KIND[fact.kind])}</Heading>
          <p className="fx-d-meta"><span><span className="fx-task-no">#{task.number}</span>{task.title}</span></p>
        </header>
        <p className="fx-d-text">{fact.text}</p>
      </>
    )
  }
  return <Gone {...h} />
}

/**
 * A skill, as a message names it or a source has it: what it is for, where it is, and its instructions. It is read
 * again whenever at, what it is read by, changes.
 */
function SkillDetail({ name, at, read, ...h }: Head & { name: string; at: string; read: (signal: AbortSignal) => Promise<SkillText> }) {
  const [skill, setSkill] = useState<{ found?: SkillText; error?: string }>({})
  useEffect(() => {
    const stop = new AbortController()
    setSkill({})
    read(stop.signal).then(
      (found) => setSkill({ found }),
      (e: Error) => { if (e.name !== 'AbortError') setSkill({ error: e.message }) },
    )
    return () => stop.abort()
  }, [at]) // eslint-disable-line react-hooks/exhaustive-deps
  const found = skill.found
  return (
    <>
      <header className="fx-d-head">
        <Heading {...h}>{name}</Heading>
        {found && <p className="fx-d-meta"><code>{found.path}</code></p>}
        {found?.description && <p className="fx-d-text">{found.description}</p>}
      </header>
      <div className="fx-doc-note">
        {skill.error ? <p className="fx-d-text" role="alert">{skill.error}</p>
          : found ? <Markdown text={found.text.replace(/^---\n[^]*?\n---\n?/, '')} file />
          : <p className="fx-d-text">{tr('讀取中…')}</p>}
      </div>
    </>
  )
}

/** A picture from a task, a chat or one about to be sent, at full width, under what it belongs to. */
function ImageDetail({ item, ...h }: Head & { item: Extract<Item, { kind: 'image' }> }) {
  const task = useStore((s) => (item.task ? s.world.tasks[item.task] : undefined))
  const chat = useStore((s) => (item.chat ? s.world.chats[item.chat] : undefined))
  const im = item.image
  return (
    <>
      <header className="fx-d-head">
        <Heading {...h}>{im.name}</Heading>
        {task && <p className="fx-d-meta"><span><span className="fx-task-no">#{task.number}</span>{task.title}</span></p>}
        {chat && <p className="fx-d-meta"><span>{chat.title || chatPreview(chat)}</span></p>}
      </header>
      <img className="fx-d-image" src={shownUrl(im.url)} alt={im.name} />
    </>
  )
}

/** The round pencil in a sheet's upper right. */
export function EditTool({ onClick, open, pressed }: { onClick: () => void; open?: boolean; pressed?: boolean }) {
  return (
    <button type="button" className="fx-tool fx-hit" onClick={onClick} aria-expanded={open} aria-pressed={pressed} aria-label={tr('編輯')} title={tr('編輯')}>
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
        <path d="M2.5 13.5l.6-3L10.6 3l2.4 2.4-7.5 7.5z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        <path d="M9 4.6l2.4 2.4" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    </button>
  )
}

/** Takes a blueprint or flow out of every list to pick from, or puts it back; what already uses it keeps it. */
export function HideTool({ hidden, onChange, className = '' }: { hidden: boolean; onChange: (hidden: boolean) => void; className?: string }) {
  const label = hidden ? tr('取消隱藏') : tr('隱藏')
  return (
    <button type="button" className={`fx-tool fx-hit fx-hide-tool ${className}`.trim()} onClick={() => onChange(!hidden)} aria-pressed={hidden} aria-label={tr('隱藏')} title={label}>
      {/* the eye as it is now: open while shown, struck through while hidden */}
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
        <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8s-2.4 4.5-6.5 4.5S1.5 8 1.5 8z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        <circle cx="8" cy="8" r="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
        {hidden && <path d="M2.5 13.5l11-11" stroke="currentColor" strokeWidth="1.5" />}
      </svg>
    </button>
  )
}

export function CopyIcon() {
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

function PinIcon({ filled }: { filled: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path d="M6 2.5h4v4l2.5 3h-9L6 6.5z" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M5 2.5h6M8 9.5V14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

/** Pins a chat to the top of its list, or unpins it; a filled pin is a pinned chat. */
export function PinTool({ chat, className = 'fx-tool fx-hit' }: { chat: Chat; className?: string }) {
  const act = useStore((s) => s.act)
  const pinned = chat.pinnedAt !== undefined
  const label = pinned ? tr('取消釘選') : tr('釘選')
  return (
    <button type="button" className={className} aria-label={label} title={label} onClick={() => act((x) => pinChat(x, chat.id, !pinned))}>
      <PinIcon filled={pinned} />
    </button>
  )
}

/**
 * A bin that asks first: the first press turns it into 確定刪除, the second deletes; looking away cancels.
 *
 * One that cannot delete now stays focusable rather than disabled, so the keyboard and a touch reach it too: it says
 * `why` under itself while pointed at or pressed, and a screen reader hears it with the button.
 */
export function DeleteTool({ what, onConfirm, disabled, why }: { what: string; onConfirm: () => void; disabled?: boolean; why?: string }) {
  const [asking, setAsking] = useState(false)
  const [telling, setTelling] = useState(false)
  const whyId = useId()
  if (disabled) {
    return (
      <span className="fx-tool-why-at">
        <button type="button" className="fx-tool fx-tool-off" aria-disabled="true" aria-label={tr('刪除')}
          aria-describedby={why ? whyId : undefined} onClick={() => setTelling((x) => !x)} onBlur={() => setTelling(false)}>
          <BinIcon />
        </button>
        {why && <span id={whyId} className={telling ? 'fx-tool-why fx-tool-why-on' : 'fx-tool-why'}>{why}</span>}
      </span>
    )
  }
  return (
    <button type="button" className={asking ? 'fx-tool fx-tool-ask fx-hit' : 'fx-tool fx-hit'}
      onClick={() => (asking ? onConfirm() : setAsking(true))} onBlur={() => setAsking(false)}
      aria-label={asking ? tr('確定刪除這個{what}', { what }) : tr('刪除')} title={asking ? undefined : tr('刪除')}>
      {asking ? tr('確定刪除') : (
        <BinIcon />
      )}
    </button>
  )
}

/**
 * Write a flow: a new one (`id` null) or one the company has. Each step is written on its own sheet over this one,
 * opened from its note (`open` is the one open). Nothing is kept until it is saved.
 */
function FlowEdit({ id, open, onOpen, onDone, ...h }: Head & {
  id: string | null
  open: string | null
  onOpen: (node: string) => void
  onDone: () => void
}) {
  const w = useStore((s) => s.world)
  const act = useStore((s) => s.act)
  const draft = useFlowDraft((s) => s.draft)
  useEffect(() => {
    const s = useStore.getState().world
    const wf = id ? s.workflows[id] : undefined
    if (id && !wf) return
    const flow = wf ? structuredClone(wf) : blankFlow()
    useFlowDraft.setState({ draft: { flow } })
    return () => useFlowDraft.setState({ draft: null })
  }, [id])
  if (id && !w.workflows[id]) return <Gone {...h} />
  if (!draft) return null
  const { flow } = draft
  const unnamed = flow.nodes.some((n) => !n.name.trim())
  const ready = flow.name.trim() && flow.nodes.length > 0 && !unnamed
  // a step just made goes into the draft; one made with ＋ also opens on its sheet, ready to be written
  const made = ([next, step]: [Workflow, string], show = false) => {
    if (!step) return
    editFlowDraft(() => ({ flow: next }))
    if (show) onOpen(step)
  }
  const add = () => made(addStep(flow), true)
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
      <header className="fx-d-head"><Heading {...h}>{id ? tr('編輯 {name}', { name: w.workflows[id].name }) : tr('新增任務藍圖')}</Heading></header>
      <div className="fx-fields">
        <label className="fx-field">
          <span>{tr('名稱')}</span>
          <input className="fx-control" value={flow.name} required
            onChange={(e) => editFlowDraft((d) => ({ flow: { ...d.flow, name: e.target.value } }))} />
        </label>
      </div>
      <div className="fx-d-flowedit fx-blueprint">
        <div className="fx-flow">
          <FlowNotes wf={flow} open={open} onOpen={onOpen} edit={{
            canLink: (a, b) => canLink(flow, a, b),
            link: (a, b) => editFlowDraft((d) => ({ flow: link(d.flow, a, b) })),
            unlink: (e) => editFlowDraft((d) => ({ flow: unlink(d.flow, e) })),
            branch: (from) => made(branchStep(flow, from)),
            insert: (e) => made(insertStep(flow, e)),
            remove: (n) => editFlowDraft((d) => ({ flow: removeStep(d.flow, n) })),
          }} />
        </div>
        <button type="button" className="fx-task fx-task-new fx-flow-new fx-hit" onClick={add}>{tr('＋ 新增步驟')}</button>
      </div>
      <p className="fx-d-actions">
        <button type="submit" className="fx-save" disabled={!ready}>{id ? tr('儲存') : tr('建立')}</button>
        {unnamed && <span className="fx-d-muted">{tr('有步驟沒有名稱')}</span>}
      </p>
    </form>
  )
}

/** A flow as it is kept: names and prompts without the spaces typed around them. */
const trimmedFlow = (flow: Workflow): Workflow => ({
  ...structuredClone(flow),
  name: flow.name.trim(),
  nodes: flow.nodes.map((n) => ({ ...structuredClone(n), name: n.name.trim(), prompt: n.prompt.trim() })),
})

/** A change to the flow being written. */
type FlowChange = (f: (wf: Workflow) => Workflow) => void

/**
 * One step of the blueprint being written, on the sheet over it: its name, how it works and where it hands on. Every
 * change goes into the blueprint's draft at once, still kept only when the blueprint is saved; 完成 puts the sheet away.
 */
function FlowStepSheet({ node, onDone, ...h }: Head & { node: string; onDone: () => void }) {
  const draft = useFlowDraft((s) => s.draft)
  const flow = draft?.flow
  const n = flow && nodeOf(flow, node)
  if (!flow || !n) return <Gone {...h} />
  const edit: FlowChange = (f) => editFlowDraft((d) => ({ flow: f(d.flow) }))
  return (
    <div className="fx-d-form fx-blueprint">
      <header className="fx-d-head">
        <div className="fx-step-head">
          <Heading {...h}><span className="fx-sr">{n.name || tr('這一步')}</span></Heading>
          <StepName flow={flow} id={node} edit={edit} />
          {flow.nodes.length > 1 && <DeleteTool what={tr('步驟')} onConfirm={() => { onDone(); edit((f) => removeStep(f, node)) }} />}
        </div>
      </header>
      <StepFields flow={flow} id={node} edit={edit} />
      <p className="fx-d-actions">
        <button type="button" className="fx-save" onClick={onDone}>{tr('完成#button')}</button>
      </p>
    </div>
  )
}

/** A change to one step's own fields. */
const putIn = (edit: FlowChange, id: string) => (x: Partial<WorkflowNode>) => edit((wf) => {
  const cur = nodeOf(wf, id)
  return cur ? putStep(wf, { ...cur, ...x }) : wf
})

/** A step's name, written in place. */
function StepName({ flow, id, edit }: { flow: Workflow; id: string; edit: FlowChange }) {
  const n = nodeOf(flow, id)
  if (!n) return null
  return (
    <input className="fx-control fx-step-name" aria-label={tr('步驟名稱')} placeholder={tr('步驟名稱')} value={n.name}
      onChange={(e) => putIn(edit, id)({ name: e.target.value })} />
  )
}

/** How a step of the flow being written works: what kind, its instructions, when it starts, and where it hands on. */
function StepFields({ flow, id, edit }: { flow: Workflow; id: string; edit: FlowChange }) {
  const n = nodeOf(flow, id)
  if (!n) return null
  const next = outEdges(flow, id).map((e) => e.to)
  const choices = nextChoices(flow, id)
  const before = inEdges(flow, id).length
  const put = putIn(edit, id)
  const toggle = (to: string) => edit((wf) => {
    const cur = nodeOf(wf, id)
    const now = outEdges(wf, id).map((e) => e.to)
    return cur ? putStep(wf, cur, now.includes(to) ? now.filter((x) => x !== to) : [...now, to]) : wf
  })
  return (
      <div className="fx-fields">
        {(
          <>
            {/* a discussion has its own fixed instructions; back to work, it starts with no instructions and keeps
                one employee */}
            <Switcher label={tr('種類')} value={n.kind === 'talk' ? 'talk' : 'work'} options={['work', 'talk'] as const} labelOf={(x) => tr(KINDS[x])}
              onChange={(x) => put(x === 'talk'
                ? { kind: 'talk', prompt: fixedSteps(useStore.getState().world.language).talkPrompt }
                : { kind: 'work', prompt: n.kind === 'task' ? n.prompt : '', replicaIds: n.replicaIds.slice(0, 1) })} />
            {n.kind !== 'talk' && (
              <label className="fx-field fx-field-top">
                <span>{tr('Prompt')}</span>
                <textarea className="fx-control" rows={2} value={n.prompt} onChange={(e) => put({ prompt: e.target.value })} />
              </label>
            )}
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
        {choices.length > 0 && (
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
  )
}

/** A step is finished once it has run and every live sub-task at it is complete. */
function stepDone(subs: SubTask[], nodeId: string) {
  const at = subs.filter((s) => s.nodeId === nodeId)
  return at.length > 0 && at.every((s) => s.status === 'complete')
}
