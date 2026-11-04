// Fake runtime: moves tasks through their workflow. Every function mutates the world in place
// (the store wraps calls in immer), so tests can use plain objects.

import { makeHandoff, makeScript, roleOf } from './content'
import { fixedSteps, installPresets, localizeFlow } from '../data/presets'
import { canReach, canSendBack, feedsOnly, inEdges, nodeOf, outEdges, startsOf } from './graph'
import { between, chance, hex, pick, uid } from './rng'
import { taskStatus } from './rollup'
import { adoptSources, covers, itemsOf } from './sources'
import type {
  Chat,
  Look,
  Attachment, Blueprint, GitSource, Locale, LogKind, MemorySource, ModelProvider, ProviderAuth, Replica, Review, Script, SubTask, TalkEnd, Task, Team, Workflow, World,
  FileInfo, SkillInfo, SkillText,
} from './types'

export * from './sources'

/** Seconds a box spends on the belt between two nodes. */
export const TRAVEL = 3
/** Seconds the owner needs to merge a task's work tree into the target branch. */
export const MERGE_TIME = 6
/** Seconds more when the merge clashes and the owner resolves the conflict first. */
export const RESOLVE_TIME = 12
/** A task's work is sent back at most this many times; after that every step hands on. */
export const MAX_SEND_BACKS = 2

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))

export const subsOf = (w: World, taskId: string) =>
  Object.values(w.subTasks).filter((s) => s.taskId === taskId)

/** Still has work to do or a handoff to make. */
export const isLive = (s: SubTask) => !s.cancelled && !(s.status === 'complete' && s.routed)

export const taskCost = (w: World, task: Task) =>
  task.costCarry + subsOf(w, task.id).reduce((sum, s) => sum + s.costUsd, 0)

export const taskTokens = (w: World, task: Task) =>
  task.tokensCarry + subsOf(w, task.id).reduce((sum, s) => sum + s.tokens, 0)

export const costLimit = (w: World, task: Task) => w.teams[task.teamId].settings.costLimitUsd + task.budgetBonus

export const statusOf = (w: World, task: Task) => taskStatus(task, subsOf(w, task.id))

function log(s: SubTask, now: number, kind: LogKind, text: string, key?: string, args?: Record<string, string | number>) {
  s.log.push({ at: now, kind, text, key, args })
}

export function remember(w: World, replicaId: string | null, text: string, source: MemorySource, taskId?: string) {
  const r = replicaId ? w.replicas[replicaId] : undefined
  if (!r || r.memory.some((m) => m.text === text)) return false
  r.memory.unshift({ id: uid(w, 'mem'), text, source, at: w.now, taskId })
  return true
}

/** Replicas currently working: on a sub-task, or merging a task. */
export function busyReplicas(w: World): Set<string> {
  const busy = new Set<string>()
  for (const s of Object.values(w.subTasks)) if (s.status === 'progressing' && s.replicaId) busy.add(s.replicaId)
  for (const t of Object.values(w.tasks)) {
    if (t.stage === 'merging' && t.merge?.startedAt !== undefined && t.merge.replicaId) busy.add(t.merge.replicaId)
  }
  return busy
}

// ---------- tasks ----------

export interface NewTask {
  teamId: string
  title: string
  description: string
  workflowId: string
  /** A flow of the task's own, written for it alone; when given, `workflowId` is ignored and the task names no blueprint. */
  workflow?: Workflow
  overrides?: Record<string, Partial<Script>>
  mergeConflict?: boolean
  /** Who works each step of this task, by node id. Steps left out keep the flow's own list. */
  staff?: Record<string, string[]>
  /** The task's owner, who answers for it; who works each step is up to `staff`. */
  ownerId?: string
  images?: Attachment[]
  files?: Attachment[]
  /** The company chat the user made it from; it shows under the chat's last message. */
  chatId?: string
}

/** A flow is shared, so a task's copy of it keeps only people from the task's own company. */
function ownStaff(w: World, teamId: string, wf: Workflow): Workflow {
  for (const n of wf.nodes) n.replicaIds = n.replicaIds.filter((r) => w.replicas[r]?.teamId === teamId)
  return wf
}

/** A new task waits in 待辦 until the user starts it with resumeTask: paused, with no pausedAt. */
export function createTask(w: World, input: NewTask): Task {
  const number = Object.values(w.tasks).filter((t) => t.teamId === input.teamId).length + 1
  const task: Task = {
    id: uid(w, 'task'),
    teamId: input.teamId,
    number,
    title: input.title,
    description: input.description,
    images: input.images ?? [],
    files: input.files ?? [],
    workflowId: input.workflow ? '' : input.workflowId,
    workflow: ownStaff(w, input.teamId, input.workflow ? { ...clone(input.workflow), id: '' } : clone(w.workflows[input.workflowId])),
    createdAt: w.now,
    stage: 'running',
    paused: true,
    pausedStatus: 'todo',
    branch: `task/${number}`,
    budgetBonus: 0,
    costCarry: 0,
    tokensCarry: 0,
    mergeConflict: input.mergeConflict ?? false,
    overrides: input.overrides,
    ownerId: input.ownerId ?? null,
  }
  for (const n of task.workflow.nodes) if (input.staff?.[n.id]) n.replicaIds = [...input.staff[n.id]]
  settleStaff(task.workflow)
  localizeFlow(task.workflow, w.language)
  w.tasks[task.id] = task
  const chat = input.chatId ? w.chats[input.chatId] : undefined
  const at = chat?.teamId === input.teamId ? chat.messages[chat.messages.length - 1] : undefined
  if (at) at.tasks = [...(at.tasks ?? []), task.id]
  start(w, task)
  return task
}

/** Start every step a task's flow starts with, each from the task's description. */
function start(w: World, task: Task) {
  for (const n of startsOf(task.workflow)) spawn(w, task, n.id, [], null, w.now)
}

/** The 整理需求 and 驗收 templates and what every 和員工討論 step is told, in Chinese, for the sample tasks. */
export const { startPrompt: START_PROMPT, endPrompt: END_PROMPT, talkPrompt: TALK_PROMPT } = fixedSteps('zh')

function spawn(
  w: World, task: Task, nodeId: string, upstreamIds: string[], parentId: string | null, arrivedAt: number, waiting = false,
  round = 0,
): SubTask {
  const node = nodeOf(task.workflow, nodeId)!
  const id = uid(w, 'sub')
  const script = makeScript(w, roleOf(node), task, { ...task.overrides?.['*'], ...task.overrides?.[nodeId] })
  const sub: SubTask = {
    id, taskId: task.id, nodeId, parentId, upstreamIds, replicaId: null, status: 'todo', cancelled: false,
    progress: 0, duration: script.duration ?? 24, createdAt: w.now, attempts: 0, costUsd: 0, tokens: 0,
    routedTo: [], routed: false, waiting, arrivedAt, log: [], script,
    ...(round ? { round } : {}),
  }
  w.subTasks[id] = sub
  if (waiting) log(sub, w.now, 'system', '等待其他上游完成', 'joinWaiting')
  else release(w, task, sub)
  return sub
}

/** Queues a sub-task. */
function release(w: World, _task: Task, sub: SubTask) {
  sub.waiting = false
  log(sub, w.now, 'system', '已排入佇列', 'queued')
}

/** Keeps the first employee of a work step, as from before a work step had one; a discussion keeps them all, who hold it as a meeting. */
export function settleStaff(wf: Workflow) {
  for (const n of wf.nodes) {
    delete (n as { assignment?: string }).assignment
    if (n.kind !== 'talk' && n.replicaIds.length > 1) n.replicaIds = n.replicaIds.slice(0, 1)
  }
  return wf
}

// ---------- tick ----------

export function tick(w: World, dt: number) {
  w.now += dt
  drift(w)
  const running = (t: Task) => t.stage === 'running' && !t.paused
  const subs = Object.values(w.subTasks).filter((s) => !s.cancelled && running(w.tasks[s.taskId]))

  for (const s of subs) if (s.status === 'progressing') advance(w, w.tasks[s.taskId], s, dt)
  for (const s of subs) if (s.talk?.replyAt !== undefined && w.now >= s.talk.replyAt) answer(w, s)
  for (const s of subs) if (!s.cancelled && s.status === 'complete' && !s.routed) route(w, w.tasks[s.taskId], s)
  for (const s of Object.values(w.subTasks)) if (s.waiting && !s.cancelled && running(w.tasks[s.taskId])) checkJoin(w, s)
  // a merge waits for its owner; it goes before new work so the owner is not handed the next step first
  for (const t of Object.values(w.tasks)) if (t.stage === 'merging') stepMerge(w, t)
  dispatch(w)
  for (const c of Object.values(w.chats)) if (c.replyAt !== undefined && w.now >= c.replyAt) answerChat(w, c)

  for (const t of Object.values(w.tasks)) {
    if (running(t)) {
      const all = subsOf(w, t.id).filter((s) => !s.cancelled)
      if (all.length && all.every((s) => !isLive(s))) {
        t.stage = 'awaitMerge'
        w.events.push({ kind: 'awaitMerge', taskId: t.id })
      }
    }
  }
}

/** Start a merge, and finish it when its time is up. */
function stepMerge(w: World, task: Task) {
  const m = task.merge!
  const target = w.teams[task.teamId]?.targetBranch ?? 'main'
  if (m.startedAt === undefined) {
    m.startedAt = w.now
    m.endsAt = w.now + MERGE_TIME + (m.conflict ? RESOLVE_TIME : 0)
    const name = m.replicaId ? w.replicas[m.replicaId]?.name : undefined
    m.log.push({ at: w.now, kind: 'system', text: `${name ? `${name} ` : ''}開始把 ${task.branch} 合併到 ${target}` })
    if (m.conflict) m.log.push({ at: w.now, kind: 'system', text: `和 ${target} 有衝突，先解衝突` })
    return
  }
  if (w.now < m.endsAt!) return
  if (m.conflict) m.log.push({ at: w.now, kind: 'system', text: '衝突已解決' })
  m.log.push({ at: w.now, kind: 'system', text: `已合併回 ${target}，移除 work tree` })
  task.stage = 'done'
  task.doneAt = w.now
}

function advance(w: World, task: Task, sub: SubTask, dt: number) {
  const before = sub.progress
  const s = sub.script
  const crossed = (p: number) => p > before && p <= sub.progress
  sub.progress = Math.min(1, before + dt / sub.duration)
  sub.costUsd += dt * (s.costRate ?? 0.015)
  sub.tokens += Math.round(dt * 400)

  for (const l of s.lines) if (crossed(l.p)) log(sub, w.now, l.kind, l.text)
  if (s.memory && crossed(s.memory.p) && remember(w, sub.replicaId, s.memory.text, 'work', task.id)) {
    log(sub, w.now, 'system', `寫入記憶：${s.memory.text}`, 'memory', { text: s.memory.text })
  }
  if (s.fail && s.fail.times > 0 && crossed(s.fail.p)) {
    s.fail.times -= 1
    sub.attempts += 1
    const max = w.teams[task.teamId].settings.retries
    if (sub.attempts <= max) {
      log(sub, w.now, 'system', `${s.fail.reason}，自動重試 ${sub.attempts}/${max}`, s.fail.reason === 'timeout' ? 'retryTimeout' : 'retryError', { n: sub.attempts, max })
      sub.progress = 0
    } else {
      openReview(w, task, sub, { kind: 'failed', reason: s.fail.reason, options: [{ id: 'retry' }, { id: 'skip' }] })
    }
    return
  }
  if (s.ask && !sub.asked && crossed(s.ask.p)) {
    sub.asked = true
    openReview(w, task, sub, {
      kind: 'question', prompt: s.ask.prompt, options: s.ask.options.map((label, i) => ({ id: `opt${i}`, label })),
    })
    return
  }
  if (taskCost(w, task) >= costLimit(w, task)) {
    for (const o of subsOf(w, task.id)) {
      if (o.id !== sub.id && o.status === 'progressing') {
        o.status = 'todo'
        log(o, w.now, 'system', '費用達到上限，暫停執行', 'budgetHold')
      }
    }
    openReview(w, task, sub, { kind: 'budget', options: [{ id: 'addBudget' }, { id: 'pauseTask' }] })
    return
  }
  if (sub.progress >= 1) {
    if (nodeOf(task.workflow, sub.nodeId)?.kind === 'talk') openTalk(w, task, sub)
    else complete(w, task, sub)
  }
}

// ---------- 使用者討論 ----------

/** Seconds the employee takes to write back in a discussion. */
export const REPLY_TIME = 4

/** A discussion step is ready: the employee, or the chair of several, opens it with their questions, and it waits on the user. */
function openTalk(w: World, task: Task, sub: SubTask) {
  sub.progress = 1
  sub.talk = { messages: [], speaker: sub.replicaId ?? undefined }
  say(w, sub, sub.script.talk?.opening ?? `關於「${task.title}」，有幾件事想和你討論。`)
  openReview(w, task, sub, { kind: 'talk', options: [] })
}

function say(w: World, sub: SubTask, text: string) {
  sub.talk!.messages.push({ at: w.now, from: 'agent', text, by: sub.talk!.speaker })
  log(sub, w.now, 'say', text)
}

/** Who hold a discussion: the one who opened it, who chairs, then the rest of its step's employees still here. Several make it a meeting. */
export function talkPeople(w: World, sub: SubTask): string[] {
  const node = nodeOf(w.tasks[sub.taskId].workflow, sub.nodeId)
  return [...new Set([sub.replicaId ?? '', ...node?.replicaIds ?? []])].filter((id) => w.replicas[id])
}

/** The reply to the user's last message, in turn from the script, and then plain acknowledgements; then the next in the round replies. */
function answer(w: World, sub: SubTask) {
  const talk = sub.talk!
  talk.replyAt = undefined
  const n = talk.messages.filter((m) => m.from === 'agent').length - 1
  const replies = sub.script.talk?.replies ?? []
  say(w, sub, replies[n] ?? '好的，記下來了。')
  const next = talk.next?.find((id) => w.replicas[id])
  talk.next = next ? talk.next!.slice(talk.next!.indexOf(next) + 1) : undefined
  if (next) {
    talk.speaker = next
    talk.replyAt = w.now + REPLY_TIME
  }
}

/** Whether a discussion is open: the user may write in it, and end it. */
export const talking = (s: SubTask) => s.review?.kind === 'talk' && !s.talk?.ended

/**
 * The user writes in an open discussion. Those it mentions answer in turn, a few seconds apart; with none, the chair
 * alone. "@All" comes as everyone mentioned, the chair last. Nothing while someone still writes.
 */
export function sayInTalk(w: World, subId: string, text: string, mentions: string[] = []) {
  const sub = w.subTasks[subId]
  text = text.trim()
  if (!sub || !talking(sub) || !text || sub.talk!.replyAt !== undefined) return
  const people = talkPeople(w, sub)
  const speakers = [...new Set(mentions)].filter((id) => people.includes(id))
  if (!speakers.length) speakers.push(people[0])
  if (!speakers[0]) return
  sub.talk!.messages.push({ at: w.now, from: 'user', text, ...mentions.length ? { mentions } : {} })
  sub.talk!.speaker = speakers[0]
  sub.talk!.next = speakers.length > 1 ? speakers.slice(1) : undefined
  sub.talk!.replyAt = w.now + REPLY_TIME
  log(sub, w.now, 'human', text)
}

/** The airport staff's fixed face. */
export const AIRPORT_STAFF_LOOK: Look = { skin: '#f0c8a0', hair: '#2f3b52', shirt: '#24579e', pants: '#2f3542', extra: 'cap', style: 7 }

/** `guests` make it a meeting, which the employee chairs. */
export interface NewChat { teamId: string; replicaId: string; guests?: string[]; mentions?: string[]; text: string; images?: Attachment[]; files?: Attachment[] }

/** A chat exists from the user's first message on; the employee answers a few seconds later. */
export function createChat(w: World, i: NewChat): Chat {
  const r = w.replicas[i.replicaId]
  const chat: Chat = { id: uid(w, 'chat'), teamId: i.teamId, replicaId: i.replicaId, name: r.name, look: r.look, model: r.model, tokens: 0, messages: [], createdAt: w.now }
  w.chats[chat.id] = chat
  invite(w, chat, i.guests ?? [])
  sayInChat(w, chat.id, i.text, i.images, i.files, i.mentions)
  return chat
}

/** How many employees a meeting holds at most: each message can ask every one of them. */
export const MAX_CHAT_PEOPLE = 6

/** Whether an employee chairs a chat or is a guest of it, whether or not they have left since. */
export const chatHas = (chat: Chat, replicaId: string) => replicaId === chat.replicaId || !!chat.guests?.some((g) => g.replicaId === replicaId)

/** Brings into a chat whoever of its company is mentioned and not in it yet, up to the most it holds. With `before`, the chat shows they joined there; those it starts with did not join. */
function invite(w: World, chat: Chat, ids: string[], before?: number) {
  for (const id of ids) {
    const r = w.replicas[id]
    if (!r || r.teamId !== chat.teamId || !chat.teamId || chatHas(chat, id) || 1 + (chat.guests?.length ?? 0) >= MAX_CHAT_PEOPLE) continue
    chat.guests = [...chat.guests ?? [], { replicaId: r.id, name: r.name, look: r.look, model: r.model }]
    if (before !== undefined) chat.joins = [...chat.joins ?? [], { before, replicaId: r.id, name: r.name }]
  }
}

/** Who reply to a message, in turn: those it mentions, in that order, or else the chair alone. "@All" comes as everyone mentioned, the chair last to sum up. Those who left are skipped; the airport staff are ''. */
export function speakersFor(w: World, chat: Chat, mentions: string[] = []): string[] {
  if (!chat.teamId) return ['']
  const wanted = mentions.length ? mentions : [chat.replicaId]
  return [...new Set(wanted)].filter((id) => w.replicas[id] && chatHas(chat, id))
}

/** Who may act outside the chat on a message, create tasks or ask the user: the one it mentions alone, or the chair. */
export const actorOf = (chat: Chat, mentions: string[] = []) => (mentions.length === 1 ? mentions[0] : chat.replicaId)

/** The actor of the round under way, from the user's last message. */
export const roundActor = (chat: Chat) => actorOf(chat, chat.messages.findLast((m) => m.from === 'user')?.mentions)

/** Brings an employee of the chat's company into it, as mentioning them would, while nobody is replying. */
export function inviteToChat(w: World, id: string, replicaId: string) {
  const chat = w.chats[id]
  if (!chat || chat.replyAt !== undefined || chat.change) return
  invite(w, chat, [replicaId], chat.messages.length)
}

/** Has a guest chair the meeting, the chair becoming a guest. */
export function setChatChair(w: World, id: string, replicaId: string) {
  const chat = w.chats[id]
  const at = chat?.guests?.findIndex((g) => g.replicaId === replicaId) ?? -1
  if (!chat || at < 0 || !w.replicas[replicaId] || chat.replyAt !== undefined || chat.change) return
  swapChair(chat, at)
}

function swapChair(chat: Chat, at: number) {
  const g = chat.guests![at]
  chat.guests![at] = { replicaId: chat.replicaId, name: chat.name, look: chat.look, model: chat.model }
  Object.assign(chat, { replicaId: g.replicaId, name: g.name, look: g.look, model: g.model })
  delete chat.effort
}

export interface NewAirportChat { model: string; effort: string; text: string; images?: Attachment[]; files?: Attachment[] }

/** The airport's chat: with the airport staff, on the model picked for it. */
export function createAirportChat(w: World, i: NewAirportChat): Chat {
  const chat: Chat = { id: uid(w, 'chat'), teamId: '', replicaId: '', name: '', look: AIRPORT_STAFF_LOOK, model: i.model, effort: i.effort, tokens: 0, messages: [], createdAt: w.now }
  w.chats[chat.id] = chat
  sayInChat(w, chat.id, i.text, i.images, i.files)
  return chat
}

/** What an airport chat's next reply runs on. */
export function setChatMind(w: World, id: string, model: string, effort: string) {
  const chat = w.chats[id]
  if (!chat || chat.teamId || chat.replyAt !== undefined) return
  chat.model = model
  chat.effort = effort
}

/** Names a chat; an empty name goes back to showing its first message. */
export function renameChat(w: World, id: string, title: string) {
  const chat = w.chats[id]
  if (!chat) return
  const name = title.split(/\s+/).filter(Boolean).join(' ').slice(0, 80)
  if (name) chat.title = name
  else delete chat.title
}

/** Pins a chat to the top of its list, or unpins it; pinning one already pinned keeps when it was pinned. */
export function pinChat(w: World, id: string, pinned: boolean) {
  const chat = w.chats[id]
  if (!chat) return
  if (!pinned) delete chat.pinnedAt
  else chat.pinnedAt ??= w.now
}

/** The employee of a company's chat has left. The airport staff never do. */
const chatLeft = (w: World, chat: Chat) => !!chat.teamId && !w.replicas[chat.replicaId]

/** The user says something, to those mentioned, who join if they are not in the chat yet; with nobody mentioned, to everyone in it. */
export function sayInChat(w: World, id: string, text: string, images: Attachment[] = [], files: Attachment[] = [], mentions: string[] = []) {
  const chat = w.chats[id]
  text = text.trim()
  if (!chat || (!text && !images.length && !files.length) || chatLeft(w, chat)) return
  if (chat.replyAt !== undefined) {
    chat.queue = [...chat.queue ?? [], { id: uid(w, 'queued'), at: w.now, text, ...(images.length ? { images } : {}), ...(files.length ? { files } : {}), ...(mentions.length ? { mentions } : {}) }]
    return
  }
  hearInChat(w, chat, text, images, files, mentions)
}

function hearInChat(w: World, chat: Chat, text: string, images: Attachment[] = [], files: Attachment[] = [], mentions: string[] = []) {
  // after the message that mentions them; those the first message mentions start the chat, so did not join
  invite(w, chat, mentions, chat.messages.length ? chat.messages.length + 1 : undefined)
  const [first, ...rest] = speakersFor(w, chat, mentions)
  if (first === undefined) return
  delete chat.question
  delete chat.change
  chat.messages.push({ at: w.now, from: 'user', text, ...(images.length ? { images } : {}), ...(files.length ? { files } : {}), ...(mentions.length ? { mentions } : {}) })
  chat.replyAt = w.now + REPLY_TIME
  chat.speaker = first
  chat.next = rest
}

/** The user's answer on a chat's card. The simulator keeps no blueprints' versions: it only moves the chat on. */
export function resolveChatChange(w: World, id: string, approve: boolean) {
  const chat = w.chats[id]
  if (!chat?.change) return
  delete chat.change
  chat.messages.push({ at: w.now, from: 'tool', text: approve ? '同意修改' : '拒絕修改', by: chat.speaker })
  chat.replyAt = w.now + REPLY_TIME
}

export function replicaSkills(w: World, replicaId: string): SkillInfo[] {
  const names = blueprintSkills(w, w.replicas[replicaId]?.blueprintId ?? '').flatMap((names) => names ?? [])
  return [...new Set(names)].map((name) => ({ name, description: '' }))
}

/**
 * The prototype reads no files: a pack of a source brings what the source is made up to have, and one that takes
 * every skill of a place written into it a few made up.
 */
export function blueprintSkills(w: World, id: string): (string[] | null)[] {
  return (w.blueprints[id]?.skills ?? []).map((p) => {
    if (p.sourceId) {
      const s = w.sources[p.sourceId]
      return s ? itemsOf(s).filter((it) => covers(p, it)).map((it) => it.name) : null
    }
    return (p.include ?? ['code-review', 'tdd', 'summarize', 'handoff']).filter((name) => !p.exclude.includes(name))
  })
}

const MOCK_FILES: FileInfo[] = [
  { path: 'docs', dir: true }, { path: 'src', dir: true }, { path: 'README.md', dir: false }, { path: 'my notes.txt', dir: false },
  { path: 'docs/design.md', dir: false }, { path: 'src/app.ts', dir: false }, { path: 'src/app.test.ts', dir: false },
]

/** The prototype reads no files: one a mention opens says what it is. */
export function projectFile(path: string): string {
  if (!MOCK_FILES.some((f) => f.path === path && !f.dir)) throw new Error(`專案資料夾裡沒有 ${path}`)
  return /\.mdx?$/i.test(path) ? `# ${path}\n\n原型不讀檔案，這裡只是示意。` : `// ${path}\n`
}

/** The blueprint the airport staff work by. */
export const AIRPORT_BLUEPRINT_ID = 'preset-airport'

/** The airport staff's skills, made up as their packs are. */
export function airportSkills(w: World): SkillInfo[] {
  const names = blueprintSkills(w, AIRPORT_BLUEPRINT_ID).flatMap((names) => names ?? [])
  return [...new Set(names)].map((name) => ({ name, description: '' }))
}

/** A skill of someone in the chat, made up as its pack is. */
export function chatSkill(w: World, chatId: string, name: string): SkillText {
  const chat = w.chats[chatId]
  const ids = chat ? [chat.replicaId, ...(chat.guests ?? []).map((g) => g.replicaId)] : []
  const has = chat && !chat.teamId
    ? airportSkills(w).some((s) => s.name === name)
    : ids.some((id) => blueprintSkills(w, w.replicas[id]?.blueprintId ?? '').some((names) => names?.includes(name)))
  if (!has) {
    throw new Error(`找不到技能 ${name}`)
  }
  return { name, description: '', path: `skills/${name}/SKILL.md`, text: `# ${name}\n\n原型不讀檔案，這裡只是示意。` }
}

export function searchFiles(query: string): FileInfo[] {
  const at = query.lastIndexOf('/')
  const folder = query.slice(0, at + 1)
  const q = query.toLowerCase()
  return MOCK_FILES.filter((f) => (query && at < 0
    ? f.path.toLowerCase().includes(q)
    : f.path.startsWith(folder) && !f.path.slice(folder.length).includes('/') && f.path.toLowerCase().startsWith(q)))
}

/** The failed reply, the chat's last message, is tried again by whoever wrote it. */
export function retryChat(w: World, id: string) {
  const chat = w.chats[id]
  const last = chat?.messages.at(-1)
  if (!chat || !last?.failed || chat.replyAt !== undefined || chatLeft(w, chat)) return
  chat.messages.pop()
  chat.speaker = last.by ?? chat.replicaId
  delete chat.next
  chat.replyAt = w.now + REPLY_TIME
}

/** Stops the reply under way, and the rest of the round. */
export function stopChat(w: World, id: string) {
  if (!w.chats[id]) return
  delete w.chats[id].replyAt
  delete w.chats[id].next
}

/** A queued message goes ahead of the rest; with no reply being written it goes now. The simulator has no tool calls to wait on. */
export function steerChat(w: World, id: string, queued: string) {
  const chat = w.chats[id]
  const q = chat?.queue?.find((x) => x.id === queued)
  if (!chat || !q || chatLeft(w, chat)) return
  const rest = chat.queue!.filter((x) => x !== q)
  const steered = { ...q, steer: true }
  if (chat.replyAt === undefined) {
    chat.queue = [steered, ...rest]
    sendQueued(w, chat)
    return
  }
  const at = rest.filter((x) => x.steer).length
  chat.queue = [...rest.slice(0, at), steered, ...rest.slice(at)]
}

/** Takes a message out of the queue, for the user to change it. */
export function unqueueChat(w: World, id: string, queued: string) {
  const chat = w.chats[id]
  if (chat?.queue) chat.queue = chat.queue.filter((x) => x.id !== queued)
}

function sendQueued(w: World, chat: Chat) {
  const [next, ...rest] = chat.queue ?? []
  if (!next || chat.replyAt !== undefined || chatLeft(w, chat)) return
  chat.queue = rest
  hearInChat(w, chat, next.text, next.images, next.files, next.mentions)
}

/** Takes back one of the user's messages and all that came after it. */
export function rewindChat(w: World, id: string, index: number) {
  const chat = w.chats[id]
  if (chat?.messages[index]?.from !== 'user') return
  chat.messages.length = index
  for (const h of [...chat.handoffs ?? [], ...chat.joins ?? []]) h.before = Math.min(h.before, index)
  delete chat.replyAt
  delete chat.next
  delete chat.question
  delete chat.change
}

/** Whether a chat can be handed off at a message: the user's, or the employee's that ends a reply, since a reply is not split; so not within a reply still being written. */
export function canHandOff(messages: Chat['messages'], index: number, replying = false) {
  const m = messages[index]
  if (m?.from === 'user') return true
  if (replying && !messages.slice(index + 1).some((x) => x.from === 'user')) return false
  return m?.from === 'agent' && messages.slice(index + 1).find((x) => x.from !== 'tool')?.from !== 'agent'
}

/** Copies a chat up to a message into a new chat, with the employee it had or another of the company who takes over. Nobody replies until the user says something in it. */
export function handOffChat(w: World, id: string, index: number, replicaId: string): Chat | undefined {
  const chat = w.chats[id]
  const m = chat?.messages[index]
  if (!m || m.from === 'tool') return undefined
  const taker = w.replicas[replicaId]
  if (chat.teamId ? taker?.teamId !== chat.teamId : replicaId !== '') return undefined
  if (chat.replyAt !== undefined && !chat.messages.slice(index).some((x) => x.from === 'user')) return undefined
  const next = m.from === 'user' ? -1 : chat.messages.findIndex((x, i) => i > index && x.from === 'user')
  const keep = m.from === 'user' ? index + 1 : next < 0 ? chat.messages.length : next
  const fork: Chat = { ...chat, id: uid(w, 'chat'), messages: chat.messages.slice(0, keep).map((x) => ({ ...x })), handoffs: chat.handoffs?.map((h) => ({ ...h })), guests: chat.guests?.map((g) => ({ ...g })), tokens: 0, createdAt: w.now }
  if (taker && replicaId !== chat.replicaId) {
    // a meeting handed to one of its own or anyone else goes on with them alone
    delete fork.guests
    // they take over from the user's message, or after the reply it ends with
    fork.handoffs = [...fork.handoffs ?? [], { before: m.from === 'user' ? index : keep, replicaId: chat.replicaId, name: chat.name }]
    Object.assign(fork, { replicaId, name: taker.name, look: taker.look, model: taker.model })
    delete fork.effort
  }
  if (!fork.handoffs) delete fork.handoffs
  // who joined after where it is copied from did so in the original alone
  fork.joins = chat.joins?.filter((j) => j.before <= keep).map((j) => ({ ...j }))
  if (!fork.joins?.length) delete fork.joins
  if (keep < chat.messages.length) delete fork.question
  delete fork.change // a copy cannot agree for the original
  delete fork.unread
  delete fork.replyAt
  delete fork.next
  delete fork.queue
  w.chats[fork.id] = fork
  return fork
}

export function readChat(w: World, id: string) {
  if (w.chats[id]) delete w.chats[id].unread
}

export function deleteChat(w: World, id: string) {
  delete w.chats[id]
}

function answerChat(w: World, chat: Chat) {
  delete chat.replyAt
  chat.unread = true
  chat.tokens += 1200
  const by = chat.speaker ? { by: chat.speaker } : {}
  const asked = chat.messages.findLast((m) => m.from === 'user')?.text ?? ''
  // a question gets one back from whoever may ask this round, to show what an employee asking looks like
  if (/[?？]$/.test(asked) && (chat.speaker ?? '') === roundActor(chat)) {
    chat.messages.push({ at: w.now, from: 'agent', text: '你想先做哪一個？', ...by })
    chat.question = { options: ['先做前端', '先做後端'] }
  } else chat.messages.push({ at: w.now, from: 'agent', text: '收到。這是模擬的回覆，要實際對話請接上後端。', ...by })
  // the next one in the round replies, unless the chat now waits on the user
  const next = (chat.next ?? []).filter((id) => w.replicas[id])
  if (next.length && !chat.question) {
    chat.speaker = next[0]
    chat.next = next.slice(1)
    chat.replyAt = w.now + REPLY_TIME
    return
  }
  delete chat.next
  sendQueued(w, chat)
}

/** The user's words, as a task. The real one is written by the model. */
export function chatTaskDraft(w: World, id: string) {
  const said = (w.chats[id]?.messages ?? []).filter((m) => m.from === 'user').map((m) => m.text)
  return { title: (said[0] ?? '').split('\n')[0].slice(0, 40), description: said.join('\n\n') }
}

/**
 * The user ends a discussion: `continue` hands on what was settled (to `to` when the step picks one of
 * several next steps), `back` sends the work back to the steps before it with `reason`, and `stop` cancels
 * the task. The employee keeps what the user said.
 */
export function endTalk(w: World, subId: string, end: TalkEnd) {
  const sub = w.subTasks[subId]
  if (!sub || !talking(sub)) return
  const task = w.tasks[sub.taskId]
  const wf = task.workflow
  const node = nodeOf(wf, sub.nodeId)!
  const said = sub.talk!.messages.filter((m) => m.from === 'user').map((m) => m.text)
  if (end.kind === 'continue' && node.handoff === 'pickOne' && outEdges(wf, node.id).length > 1 && !outEdges(wf, node.id).some((e) => e.to === end.to)) return
  if (end.kind === 'back' && (!end.reason.trim() || !sub.upstreamIds.length)) return
  sub.talk!.ended = end.kind
  sub.talk!.replyAt = undefined
  sub.talk!.next = undefined
  sub.review = undefined

  if (end.kind === 'stop') {
    log(sub, w.now, 'human', '結束討論：停止任務')
    sub.status = 'complete'
    sub.endedAt = w.now
    stopTask(w, task.id)
    return
  }
  sub.status = 'complete'
  sub.endedAt = w.now
  sub.handoff = makeHandoff(w, roleOf(node), task, node)
  sub.handoff.agent.decisions = said.map((x) => `使用者：${x}`)
  sub.handoff.human.did = said.length ? said.map((x) => `使用者：${x}`) : ['使用者沒有補充，照原計畫進行']
  if (end.kind === 'back') {
    const reason = end.reason.trim()
    log(sub, w.now, 'human', `結束討論：退回（${reason}）`)
    sendBack(w, task, sub, [sub], reason)
    return
  }
  const to = end.to ? nodeOf(wf, end.to)?.name : undefined
  log(sub, w.now, 'human', to ? `結束討論：繼續，交給 ${to}` : '結束討論：繼續')
  if (end.to) {
    sub.routedTo = [end.to]
    sub.handoff.agent.next = { nodeId: end.to, reason: '使用者在討論後指定' }
  }
  log(sub, w.now, 'system', `完成，commit ${sub.handoff.commit}`, 'done', { commit: sub.handoff.commit })
}

function complete(w: World, task: Task, sub: SubTask) {
  const node = nodeOf(task.workflow, sub.nodeId)!
  sub.status = 'complete'
  sub.progress = 1
  sub.endedAt = w.now
  if (sub.script.retro && remember(w, sub.replicaId, sub.script.retro, 'retro', task.id)) {
    log(sub, w.now, 'system', `回顧並寫入記憶：${sub.script.retro}`, 'retro', { text: sub.script.retro })
  }
  sub.handoff = makeHandoff(w, roleOf(node), task, node)
  // every step commits to the one work tree: a commit landing there while this one worked has to be taken in
  const landed = subsOf(w, task.id).filter((o) =>
    o.id !== sub.id && !o.cancelled && !o.skipped && o.handoff?.commit && (o.endedAt ?? -1) > (sub.startedAt ?? w.now))
  if (landed.length) {
    const names = [...new Set(landed.map((o) => nodeOf(task.workflow, o.nodeId)?.name ?? o.nodeId))].join('、')
    log(sub, w.now, 'system', `commit 衝突：先合進 ${names} 的 commit，解完衝突再 commit`)
  }
  log(sub, w.now, 'system', `完成，commit ${sub.handoff.commit}`, 'done', { commit: sub.handoff.commit })
}

function route(w: World, task: Task, sub: SubTask) {
  if (sub.group && sub.group !== sub.id) return // the lead routes for the whole group
  const members = sub.group ? subsOf(w, task.id).filter((s) => s.group === sub.group && !s.cancelled) : [sub]
  if (members.some((m) => m.status !== 'complete')) return

  const wf = task.workflow
  const node = nodeOf(wf, sub.nodeId)!
  const outs = outEdges(wf, node.id)
  if (sendsBack(w, task, sub)) {
    sendBack(w, task, sub, members, sub.script.sendBack?.reason ?? '')
    return
  }
  let targets = sub.routedTo
  if (!targets.length && outs.length) {
    if (node.handoff === 'pickOne' && outs.length > 1) {
      const r = sub.script.route
      if (r === 'unsure' || r === undefined) {
        openReview(w, task, sub, {
          kind: 'pickRoute',
          options: outs.map((e) => ({ id: e.to, label: nodeOf(wf, e.to)?.name ?? e.to, detail: e.condition })),
        })
        return
      }
      const edge = outs[r % outs.length]
      targets = [edge.to]
      if (sub.handoff) sub.handoff.agent.next = { nodeId: edge.to, reason: edge.condition }
    } else {
      targets = outs.map((e) => e.to)
    }
  }
  sub.routedTo = targets
  for (const m of members) m.routed = true
  for (const t of targets) arrive(w, task, t, members)
}

/**
 * Whether a finished run sends the work back instead of handing it on. A step whose send-back switch is on may,
 * when canSendBack allows it; with the switch unset, a last step (a review that does not pass) and a step that was
 * itself sent back may. Never a starting step, and a task at most `MAX_SEND_BACKS` times; each send-back halves the
 * odds of the next.
 */
function sendsBack(w: World, task: Task, sub: SubTask) {
  const wf = task.workflow
  const node = nodeOf(wf, sub.nodeId)
  if (!node || node.kind !== 'work' || sub.sentBack || sub.skipped || !sub.upstreamIds.length) return false
  const last = outEdges(wf, node.id).length === 0
  if (node.sendBack !== undefined ? !node.sendBack || !canSendBack(wf, node.id) : !last && !sub.rework) return false
  const rounds = subsOf(w, task.id).filter((s) => s.sentBack && (!s.group || s.group === s.id)).length
  if (rounds >= MAX_SEND_BACKS) return false
  return (sub.script.sendBack?.roll ?? 1) < (last ? 0.3 : 0.25) / 2 ** rounds
}

/**
 * Send the work back to every step that fed this run: each runs again, by the same employee when it can,
 * and then hands on as it did before; one sent back may in turn send it further back.
 */
function sendBack(w: World, task: Task, sub: SubTask, members: SubTask[], reason: string) {
  const wf = task.workflow
  // one earlier run per step, the lead of a group
  const before = new Map<string, SubTask>()
  for (const id of sub.upstreamIds) {
    const u = w.subTasks[id]
    if (u && !u.cancelled && (!u.group || u.group === u.id) && !before.has(u.nodeId)) before.set(u.nodeId, u)
  }
  const to = [...before.keys()]
  const names = to.map((n) => nodeOf(wf, n)?.name ?? n).join('、')
  for (const m of members) {
    m.routed = true
    m.sentBack = { to, reason }
    if (m.handoff) m.handoff.human.headline = `退回 ${names}：${reason}`
    log(m, w.now, 'system', `退回 ${names} 重做：${reason}`, 'sentBack', { nodes: names, reason })
  }
  const round = (sub.round ?? 0) + 1
  const from = nodeOf(wf, sub.nodeId)?.name ?? ''
  for (const u of before.values()) {
    const redo = spawn(w, task, u.nodeId, [...u.upstreamIds], sub.id, w.now, false, round)
    if (u.replicaId && w.replicas[u.replicaId]) redo.replicaId = u.replicaId
    redo.rework = { from: sub.id, reason }
    // hand on the way it did the first time, without asking again
    redo.routedTo = [...u.routedTo]
    log(redo, w.now, 'system', `${from} 退回重做：${reason}`, 'reworkFrom', { node: from, reason })
  }
}

function arrive(w: World, task: Task, nodeId: string, from: SubTask[]) {
  const wf = task.workflow
  const fromIds = from.map((s) => s.id)
  const lead = from[0]
  const round = Math.max(0, ...from.map((s) => s.round ?? 0))
  if (inEdges(wf, nodeId).length <= 1) {
    spawn(w, task, nodeId, fromIds, lead.id, w.now, false, round)
    return
  }
  const node = nodeOf(wf, nodeId)!
  // a join gathers the arrivals of one round; work sent back arrives again in a later one
  const existing = subsOf(w, task.id).find((s) => s.nodeId === nodeId && !s.cancelled && (!s.group || s.group === s.id) && (s.round ?? 0) === round)
  if (node.join === 'any') {
    if (existing) return // the join already started with the first arrival
    const started = spawn(w, task, nodeId, fromIds, lead.id, w.now, false, round)
    for (const o of subsOf(w, task.id)) {
      if (isLive(o) && o.id !== started.id && o.group !== started.id && !fromIds.includes(o.id) && feedsOnly(wf, o.nodeId, nodeId)) {
        cancelSub(w, o, '匯合節點已開始，取消這個分支', 'joinCancelled')
      }
    }
    return
  }
  if (existing) {
    existing.upstreamIds.push(...fromIds)
    existing.parentId = commonAncestor(w, existing.upstreamIds)
    existing.arrivedAt = w.now
    log(existing, w.now, 'system', `收到 ${nodeOf(wf, lead.nodeId)?.name} 的交接`, 'joinArrived', { node: nodeOf(wf, lead.nodeId)?.name ?? '' })
  } else {
    const s = spawn(w, task, nodeId, fromIds, lead.id, w.now, true, round)
    s.parentId = commonAncestor(w, fromIds)
  }
}

/** A waiting join starts once no live sub-task can still reach it. */
function checkJoin(w: World, sub: SubTask) {
  const task = w.tasks[sub.taskId]
  const pending = subsOf(w, task.id).some(
    (o) => isLive(o) && o.nodeId !== sub.nodeId && canReach(task.workflow, o.nodeId, sub.nodeId),
  )
  if (pending) return
  log(sub, w.now, 'system', '所有會執行到的上游都已完成', 'joinReady')
  release(w, task, sub)
}

/** Join sub-tasks hang under the nearest sub-task shared by all their upstreams. */
export function commonAncestor(w: World, ids: string[]): string | null {
  const chain = (id: string) => {
    const out: string[] = []
    for (let cur: string | null = id; cur; cur = w.subTasks[cur]?.parentId ?? null) out.push(cur)
    return out
  }
  const chains = ids.map(chain)
  return chains[0].find((id) => chains.every((c) => c.includes(id))) ?? null
}

function cancelSub(w: World, sub: SubTask, text: string, key: string) {
  for (const s of subsOf(w, sub.taskId)) {
    if (s.id === sub.id || (sub.group && s.group === sub.group)) {
      s.cancelled = true
      s.review = undefined
      log(s, w.now, 'system', text, key)
    }
  }
}

function dispatch(w: World) {
  const ready = Object.values(w.subTasks)
    .filter((s) => {
      const t = w.tasks[s.taskId]
      return s.status === 'todo' && !s.cancelled && !s.waiting && t.stage === 'running' && !t.paused &&
        w.now >= s.arrivedAt + TRAVEL && taskCost(w, t) < costLimit(w, t)
    })
    .sort((a, b) => a.createdAt - b.createdAt)
  for (const s of ready) {
    const node = nodeOf(w.tasks[s.taskId].workflow, s.nodeId)
    // the step's employee; on a discussion held by several, the first, who chairs it
    const id = s.replicaId ?? node?.replicaIds.find((r) => w.replicas[r]) ?? null
    if (!id || !w.replicas[id]) continue
    s.replicaId = id
    s.status = 'progressing'
    log(s, w.now, 'system', `${w.replicas[id].name} 開始工作`, 'start', { name: w.replicas[id].name })
    const task = w.tasks[s.taskId]
    // the task's first run makes the work tree every later step commits to
    if (s.startedAt === undefined && !subsOf(w, task.id).some((o) => o.startedAt !== undefined)) {
      log(s, w.now, 'system', `建立 work tree，分支 ${task.branch}（從 ${w.teams[task.teamId]?.targetBranch ?? 'main'}）`)
    }
    s.startedAt ??= w.now
  }
}

function openReview(w: World, task: Task, sub: SubTask, r: Omit<Review, 'from' | 'at'>) {
  sub.review = { ...r, from: sub.status, at: w.now }
  sub.status = 'review'
  log(sub, w.now, 'system', '等待使用者審核', `review.${r.kind}`)
  w.events.push({ kind: 'review', taskId: task.id, subId: sub.id })
}

// ---------- user actions ----------

/**
 * The user's reply to a sub-task waiting on them: one of its options, with a note. A question can also be
 * answered in words alone (`optionId` empty); the other kinds need an option.
 */
export function resolveReview(w: World, subId: string, optionId: string, note = '') {
  const sub = w.subTasks[subId]
  const r = sub?.review
  if (!r || r.kind === 'talk') return
  note = note.trim()
  const option = r.options.find((o) => o.id === optionId)
  if (!option && !(r.kind === 'question' && !optionId && note)) return
  const task = w.tasks[sub.taskId]
  const label = option ? option.label ?? optionId : note
  sub.review = undefined
  if (!option) log(sub, w.now, 'human', note)
  else log(sub, w.now, 'human', note ? `${label}：${note}` : label, option.label ? undefined : `option.${optionId}`, { note })

  switch (r.kind) {
    case 'question':
    case 'change':
      sub.status = 'todo'
      break
    case 'pickRoute': {
      sub.status = 'complete'
      sub.routedTo = [optionId]
      if (sub.handoff) sub.handoff.agent.next = { nodeId: optionId, reason: note || '使用者指定' }
      break
    }
    case 'failed':
      if (optionId === 'skip') {
        sub.status = 'complete'
        sub.skipped = true
        sub.endedAt = w.now
        sub.handoff = {
          commit: '',
          agent: { goal: task.title, done: [], outputs: [], decisions: ['使用者略過此節點'], open: ['此節點沒有產出'] },
          human: { headline: '此節點已略過，沒有產出。', did: [], outputs: [] },
        }
      } else {
        sub.status = 'todo'
        sub.attempts = 0
        sub.progress = 0
      }
      break
    case 'budget':
      sub.status = 'todo'
      if (optionId === 'addBudget') task.budgetBonus += w.teams[task.teamId].settings.costLimitUsd * 0.5
      else pauseTask(w, task.id)
      break
  }
  if (task.paused) task.pausedStatus = statusOf(w, task) === 'review' ? 'review' : 'progressing'
}

export function pauseTask(w: World, taskId: string) {
  const task = w.tasks[taskId]
  if (task.stage !== 'running' || task.paused) return
  task.pausedStatus = statusOf(w, task)
  task.paused = true
  task.pausedAt = w.now
  for (const s of subsOf(w, taskId)) {
    if (s.status === 'progressing') {
      s.status = 'todo'
      log(s, w.now, 'system', '任務已暫停，中斷工作', 'paused')
    }
  }
}

/** A task made and not yet started: paused with no pausedAt. It shows as 待辦, not 已暫停. */
export function notStarted(task: Task): boolean {
  return task.paused && task.pausedAt == null
}

export function resumeTask(w: World, taskId: string) {
  const task = w.tasks[taskId]
  if (!task.paused) return
  task.paused = false
  task.pausedAt = undefined
  task.pausedStatus = undefined
}

export function cancelTask(w: World, taskId: string) {
  if (!w.tasks[taskId]?.paused) return
  stopTask(w, taskId)
}

/** Cancel a task outright, whether it is paused or not. */
function stopTask(w: World, taskId: string) {
  const task = w.tasks[taskId]
  task.stage = 'cancelled'
  task.doneAt = w.now
  for (const s of subsOf(w, taskId)) {
    if (isLive(s)) {
      s.cancelled = true
      s.review = undefined
      log(s, w.now, 'system', '任務已取消', 'cancelled')
    }
  }
}

/** Discard all progress and run the task again on another workflow. */
export function changeWorkflow(w: World, taskId: string, workflowId: string) {
  const task = w.tasks[taskId]
  if (!task.paused) return
  task.costCarry = taskCost(w, task)
  task.tokensCarry = taskTokens(w, task)
  for (const s of subsOf(w, taskId)) delete w.subTasks[s.id]
  task.workflowId = workflowId
  task.workflow = ownStaff(w, task.teamId, clone(w.workflows[workflowId]))
  localizeFlow(task.workflow, w.language)
  task.paused = false
  task.pausedAt = undefined
  task.pausedStatus = undefined
  start(w, task)
}

/** Remove a task for good, with its sub-tasks and anything still waiting on it. */
export function deleteTask(w: World, taskId: string) {
  if (!w.tasks[taskId]) return
  for (const s of subsOf(w, taskId)) delete w.subTasks[s.id]
  delete w.tasks[taskId]
  w.events = w.events.filter((e) => !('taskId' in e) || e.taskId !== taskId)
}

/**
 * The run a task ended on: of the runs of its last steps, the newest, the lead of a group. A last step something fed
 * goes before one that started the task, which has nothing to send back to.
 */
export function lastReview(w: World, task: Task): SubTask | undefined {
  return subsOf(w, task.id)
    .filter((s) => !s.cancelled && (!s.group || s.group === s.id) && s.status === 'complete' && !outEdges(task.workflow, s.nodeId).length)
    .sort((a, b) => Number(!!b.upstreamIds.length) - Number(!!a.upstreamIds.length) || (b.endedAt ?? 0) - (a.endedAt ?? 0))[0]
}

/**
 * The user merges a task that waits for it: the owner (or, with none, whoever did the last step) merges the work
 * tree into the target branch, resolving any conflict first, as soon as they are free.
 */
export function mergeTask(w: World, taskId: string) {
  const task = w.tasks[taskId]
  if (task?.stage !== 'awaitMerge') return
  const by = (task.ownerId && w.replicas[task.ownerId] ? task.ownerId : lastReview(w, task)?.replicaId) ?? null
  task.stage = 'merging'
  task.merge = { replicaId: by, conflict: task.mergeConflict, log: [{ at: w.now, kind: 'human', text: '合併' }] }
}

/**
 * The user sends a task that waits to be merged back, with `feedback`: the steps before the last step it ended
 * on (lastReview) run again on it, by the same people, and hand on to a new run of that step as before.
 */
export function returnTask(w: World, taskId: string, feedback: string) {
  const task = w.tasks[taskId]
  const review = task?.stage === 'awaitMerge' ? lastReview(w, task) : undefined
  const reason = feedback.trim()
  if (!review || !reason || !review.upstreamIds.length) return
  log(review, w.now, 'human', `退回：${reason}`)
  const members = review.group ? subsOf(w, task.id).filter((s) => s.group === review.group && !s.cancelled) : [review]
  task.stage = 'running'
  sendBack(w, task, review, members, reason)
}

// ---------- team, replicas, blueprints ----------

export const SKINS = ['#f2c9a0', '#e0ac7e', '#c68a5a', '#8d5a3b', '#f6d7b8', '#a86d48', '#6b4330', '#ecc5a5']
/** Natural shades first, then a few dyed ones. */
export const HAIRS = ['#2b1d14', '#5a3a22', '#c99a4a', '#1c1c1c', '#8a3b2a', '#d9d4c7', '#e8c872', '#3f5fa8', '#d97aa8', '#5a9a8a']

/** A steady number for an id (FNV-1a), the same the figure uses when a look has no `style`. */
const seedOfId = (id: string) => [...id].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619), 2166136261) >>> 0

/** How a provider is signed in to, as given: the whole API key, or a subscription's sign-in. */
export type ProviderLogin = { kind: 'apiKey'; apiKey: string } | { kind: 'subscription' }

/** Only the key's last four characters are kept, to tell keys apart. A subscription is saved once signed in. */
const authOf = (l: ProviderLogin): ProviderAuth =>
  l.kind === 'apiKey' ? { kind: 'apiKey', keyHint: l.apiKey.trim().slice(-4) } : { kind: 'subscription', signedIn: true }

/** Add a model provider, with the models it lists; names are trimmed and each model kept once. */
export function addProvider(w: World, input: Pick<ModelProvider, 'name' | 'kind' | 'baseUrl' | 'models' | 'thinking'> & { login: ProviderLogin }): ModelProvider {
  const id = uid(w, 'mp')
  const auth = authOf(input.login)
  w.providers[id] = {
    id, name: input.name.trim(), kind: input.kind, auth,
    baseUrl: auth.kind === 'subscription' ? '' : input.baseUrl.trim(),
    models: [...new Set(input.models.map((m) => m.trim()).filter(Boolean))],
    thinking: input.thinking,
  }
  return w.providers[id]
}

/**
 * Change a provider's name, address or sign-in; its kind, and so its models, stay. A null login keeps
 * the one it has, as does an empty key for a provider already on a key.
 */
export function updateProvider(w: World, id: string, input: { name: string; baseUrl: string; login: ProviderLogin | null }) {
  const p = w.providers[id]
  if (!p) return
  const keep = !input.login || (input.login.kind === 'apiKey' && !input.login.apiKey.trim() && p.auth.kind === 'apiKey')
  if (!keep) p.auth = authOf(input.login!)
  p.name = input.name.trim()
  p.baseUrl = p.auth.kind === 'subscription' ? '' : input.baseUrl.trim()
}

/** Employees, in any company, running on a model the provider offers. */
export const providerUsers = (w: World, id: string) => {
  const models = w.providers[id]?.models ?? []
  return Object.values(w.replicas).filter((r) => models.includes(r.model))
}

/** Remove a provider no one runs on; false (and nothing removed) while anyone still does. */
export function deleteProvider(w: World, id: string): boolean {
  if (!w.providers[id] || providerUsers(w, id).length) return false
  delete w.providers[id]
  return true
}

/** What a new employee runs on unless another model is picked; blueprints leave the model to the employee. */
export const DEFAULT_MODEL = 'claude-sonnet-5'

/** An employee's own settings, as their sheet fills them in: what they work by in place of a blueprint. */
export type OwnSettings = Pick<Blueprint, 'source' | 'prompt' | 'comment' | 'skills' | 'tools' | 'from'>

/** Give r settings of their own, or rewrite theirs; they go by r's name and look and never update themselves. */
function ownBlueprint(w: World, r: Replica, own: OwnSettings) {
  const old = w.blueprints[r.blueprintId]
  const id = old?.owner === r.id ? old.id : uid(w, 'bp')
  w.blueprints[id] = { ...own, id, name: r.name, look: r.look, owner: r.id }
  r.blueprintId = id
  adoptSources(w)
}

/** r's own settings go with them. */
function dropOwnBlueprint(w: World, r: Replica) {
  if (w.blueprints[r.blueprintId]?.owner === r.id) delete w.blueprints[r.blueprintId]
}

/** Change an employee; `own` gives them settings of their own, and a new `blueprintId` instead lets theirs go. */
export function updateReplica(w: World, id: string, p: Pick<Replica, 'name' | 'blueprintId' | 'model' | 'effort' | 'look'>, own?: OwnSettings) {
  const r = w.replicas[id]
  if (!r) return
  if (!own && p.blueprintId !== r.blueprintId) dropOwnBlueprint(w, r)
  Object.assign(r, own ? { ...p, blueprintId: r.blueprintId } : p)
  const mine = w.blueprints[r.blueprintId]
  if (own) ownBlueprint(w, r, own)
  else if (mine?.owner === r.id) Object.assign(mine, { name: r.name, look: r.look })
}

export function hire(
  w: World, teamId: string, blueprintId: string, name: string, look?: Replica['look'],
  mind: Partial<Pick<Replica, 'model' | 'effort'>> = {}, own?: OwnSettings,
): Replica {
  const id = uid(w, 'rep')
  const r: Replica = {
    id,
    teamId,
    blueprintId,
    name,
    // their own cut and clothes, from their id: the blueprint's style draws the blueprint's icon, not them
    look: look ?? { ...(w.blueprints[blueprintId]?.look ?? AIRPORT_STAFF_LOOK), skin: pick(w, SKINS), hair: pick(w, HAIRS), style: seedOfId(id) },
    model: mind.model ?? DEFAULT_MODEL,
    effort: mind.effort ?? 'default',
    memory: [],
    hiredAt: w.now,
  }
  w.replicas[r.id] = r
  if (own) ownBlueprint(w, r, own)
  return r
}

/**
 * Let an employee go, handing everything they still have to `heirId` first: the tasks they own, the steps
 * they are staffed on, and every unfinished sub-task. A job they were in the middle of keeps its progress
 * and waits for the heir to be free, so the heir still works one thing at a time.
 */
export function fire(w: World, id: string, heirId: string) {
  const r = w.replicas[id]
  if (!r || id === heirId || !w.replicas[heirId]) return
  const swap = (ids: string[]) => [...new Set(ids.map((x) => (x === id ? heirId : x)))]
  for (const wf of Object.values(w.workflows)) for (const n of wf.nodes) n.replicaIds = swap(n.replicaIds)
  for (const task of Object.values(w.tasks)) {
    if (task.stage === 'done' || task.stage === 'cancelled') continue
    for (const n of task.workflow.nodes) n.replicaIds = swap(n.replicaIds)
    if (task.ownerId === id) task.ownerId = heirId
    const m = task.merge
    if (m?.replicaId === id) {
      m.replicaId = heirId
      // a merge under way starts over with the heir
      if (m.startedAt !== undefined && task.stage === 'merging') m.startedAt = m.endsAt = undefined
    }
  }
  const heir = w.replicas[heirId].name
  for (const s of Object.values(w.subTasks)) {
    if (s.replicaId !== id || s.cancelled || s.status === 'complete') continue
    s.replicaId = heirId
    if (s.status === 'progressing') s.status = 'todo'
    log(s, w.now, 'system', `${r.name} 離職，交給 ${heir}`, 'handover', { from: r.name, to: heir })
  }
  endChatsOf(w, id)
  dropOwnBlueprint(w, r)
  delete w.replicas[id]
}

/** An employee leaves their chats: a reply of theirs stops, and a meeting they chaired goes on with the first guest still there. */
function endChatsOf(w: World, id: string) {
  for (const chat of Object.values(w.chats)) {
    if (chat.next) chat.next = chat.next.filter((x) => x !== id)
    if (chat.speaker === id || (chat.replicaId === id && !chat.speaker)) delete chat.change
    if ((chat.speaker === id || chat.replicaId === id) && chat.replyAt !== undefined) {
      delete chat.replyAt
      delete chat.next
    }
    const heir = chat.replicaId === id ? chat.guests?.findIndex((g) => g.replicaId !== id && w.replicas[g.replicaId]) ?? -1 : -1
    if (heir >= 0) swapChair(chat, heir)
  }
}

/** Employees made from a blueprint, in every company. */
export const blueprintUsers = (w: World, id: string) => Object.values(w.replicas).filter((r) => r.blueprintId === id)

/** Remove a blueprint no one is made from; false (and nothing removed) while anyone still is. */
export function deleteBlueprint(w: World, id: string): boolean {
  if (!w.blueprints[id] || blueprintUsers(w, id).length) return false
  delete w.blueprints[id]
  return true
}

/** Every Git source a blueprint reads: its own, then those of its skill packs. */
export function gitSources(bp: Blueprint): GitSource[] {
  return [bp.source, ...bp.skills.map((p) => p.source)].filter((s): s is GitSource => s?.kind === 'git')
}

/** Why an update can fail, besides a missing upstream. */
const UPDATE_ERRORS = ['驗證失敗，沒有讀取權限', '新版本缺少 SKILL.md', '下載逾時']

/**
 * Move a Git source to its newest version. It fails when the upstream can't be found, and now and then for
 * other reasons; a failed update keeps the version in use. Either way the attempt is recorded.
 */
export function updateSource(w: World, s: GitSource) {
  const error = !s.upstream ? '找不到上游' : chance(w, 0.25) ? pick(w, UPDATE_ERRORS) : undefined
  s.update = error ? { at: w.now, ok: false, error } : { at: w.now, ok: true }
  if (error) return
  s.commit = s.latest
  s.ref = s.latestRef
}

/** Update every source of a blueprint that is behind or can't be reached. */
export function updateBlueprint(w: World, id: string) {
  const bp = w.blueprints[id]
  if (!bp) return
  for (const s of gitSources(bp)) if (!s.upstream || s.commit !== s.latest) updateSource(w, s)
}

const bump = (ref: string) => {
  const m = ref.match(/^v(\d+)\.(\d+)\.(\d+)$/)
  return m ? `v${m[1]}.${Number(m[2]) + 1}.0` : ref
}

/**
 * Now and then one of the Git repos a blueprint reads (its own or a skill pack's) gets a new upstream
 * version, left for the user to apply. Repos whose upstream is gone get none.
 */
function drift(w: World) {
  if (w.now < w.nextDriftAt) return
  w.nextDriftAt = w.now + between(w, 90, 160)
  const kept = Object.values(w.sources ?? {}).filter((s) => s.kind === 'git' && s.upstream)
  if (kept.length && chance(w, 0.5)) {
    // a source kept apart: those that apply updates themselves move at once
    const s = pick(w, kept)
    s.latest = hex(w)
    if (s.autoApply) s.commit = s.latest
    return
  }
  const all = Object.values(w.blueprints).flatMap((bp) => gitSources(bp).filter((s) => s.upstream).map((s) => ({ bp, s })))
  if (!all.length) return
  const { bp, s } = pick(w, all)
  s.latest = hex(w)
  s.latestRef = bump(s.latestRef)
  w.events.push({ kind: 'blueprintUpdated', blueprintId: bp.id, commit: s.latest })
}

/** What every flow starts as: one blank step, named `name`. `id` names the node. */
export function blankSteps(id: (prefix: string) => string, name: string): Pick<Workflow, 'nodes' | 'edges'> {
  return {
    nodes: [{ id: id('n'), kind: 'work', name, prompt: '', replicaIds: [], handoff: 'all', join: 'all', pos: { x: 0, y: 0 } }],
    edges: [],
  }
}

export function newWorkflow(w: World, name: string): Workflow {
  const wf: Workflow = { id: uid(w, 'wf'), name, ...blankSteps((p) => uid(w, p), w.language === 'en' ? 'New step 1' : '新步驟1') }
  w.workflows[wf.id] = wf
  return wf
}

/** A copy of a flow, named after it with the first free `-1`, `-2`…; no company defaults to it. */
export function duplicateWorkflow(w: World, wfId: string): Workflow | undefined {
  const from = w.workflows[wfId]
  if (!from) return
  const taken = new Set(Object.values(w.workflows).map((x) => x.name))
  let n = 1
  while (taken.has(`${from.name}-${n}`)) n++
  const wf: Workflow = { ...clone(from), id: uid(w, 'wf'), name: `${from.name}-${n}` }
  w.workflows[wf.id] = wf
  return wf
}

/** Remove a flow. Tasks keep the copy they were started with, so they run on. */
export function deleteWorkflow(w: World, wfId: string) {
  delete w.workflows[wfId]
}

export function createTeam(
  w: World, input: { name: string; folder: string; targetBranch: string; branches: string[]; initializedGit: boolean },
): Team {
  const id = uid(w, 'team')
  const team: Team = {
    id, ...input, prompt: '', createdAt: w.now,
    settings: { timeoutMin: 30, costLimitUsd: 3, retries: 1 },
  }
  w.teams[id] = team
  return team
}

/**
 * Close a company: it goes with everyone who works there, and all its tasks and their sub-tasks.
 * Blueprints and flows are shared and stay. The prototype has no real folders, so `removeFiles` deletes nothing here.
 */
export function deleteTeam(w: World, teamId: string, _opts: { removeFiles: boolean } = { removeFiles: false }) {
  if (!w.teams[teamId]) return
  const tasks = new Set(Object.values(w.tasks).filter((t) => t.teamId === teamId).map((t) => t.id))
  for (const s of Object.values(w.subTasks)) if (tasks.has(s.taskId)) delete w.subTasks[s.id]
  for (const id of tasks) delete w.tasks[id]
  for (const r of Object.values(w.replicas)) {
    if (r.teamId !== teamId) continue
    dropOwnBlueprint(w, r)
    delete w.replicas[r.id]
  }
  for (const c of Object.values(w.chats)) if (c.teamId === teamId) delete w.chats[c.id]
  w.events = w.events.filter((e) => !('taskId' in e) || !tasks.has(e.taskId))
  delete w.teams[teamId]
}

export function setLanguage(w: World, language: Locale) {
  w.language = language
  installPresets(w)
  for (const t of Object.values(w.tasks)) localizeFlow(t.workflow, language)
}
