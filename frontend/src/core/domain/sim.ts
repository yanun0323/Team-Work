// Fake runtime: moves tasks through their workflow. Every function mutates the world in place
// (the store wraps calls in immer), so tests can use plain objects.

import { makeHandoff, makeScript, roleOf } from './content'
import { mockText } from '../data/mockText'
import { installPresets, localizeFlow } from '../data/presets'
import { canReach, canSendBack, feedsOnly, inEdges, nodeOf, outEdges, reshaped, startsOf } from './graph'
import { between, chance, hex, pick, uid } from './rng'
import { taskStatus } from './rollup'
import { currentRun, isOwnerTask, ownerStatus, resumeBlock } from './owner'
import { adoptSources, covers, itemsOf } from './sources'
import { STAFFING_ID, worksIn } from './types'
import type {
  Chat,
  Look, Meeting,
  Attachment, Blueprint, GitSource, Locale, LogKind, MemorySource, ModelProvider, ProviderAuth, Replica, Review, Script, SubTask, TalkEnd, Task, Team, Workflow, World,
  FileInfo, SkillInfo, SkillText, TaskActivity, TaskCoordination, TaskOperation,
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

/** What a task has cost: its steps, runs dropped before, and on a task its owner runs, the owner's own thinking. */
export const taskCost = (w: World, task: Task) =>
  task.costCarry + (task.coordination?.ownerCostUsd ?? 0) + subsOf(w, task.id).reduce((sum, s) => sum + s.costUsd, 0)

export const taskTokens = (w: World, task: Task) =>
  task.tokensCarry + (task.coordination?.ownerTokens ?? 0) + subsOf(w, task.id).reduce((sum, s) => sum + s.tokens, 0)

/**
 * How far a task has got, for its card: the steps at work now in flow order, and how many of the flow's steps
 * are done. None before it starts or once it is over. On a task its owner runs a step is done only once the owner
 * accepted its current run, as the backend counts it (owner_run.go). Branches never taken still count in the total,
 * so a task waiting to merge shows every step done.
 */
export function progressOf(w: World, task: Task): { now: string[]; done: number; total: number } | undefined {
  const order = task.workflow.nodes.map((n) => n.id)
  if (!order.length || notStarted(task) || task.stage === 'done' || task.stage === 'cancelled') return undefined
  if (task.stage === 'awaitMerge' || task.stage === 'merging') return { now: [], done: order.length, total: order.length }
  const owner = isOwnerTask(task)
  const subs = subsOf(w, task.id).filter((s) => (owner ? currentRun(s) : !s.cancelled) && order.includes(s.nodeId))
  const done = new Set(subs.filter((s) => s.status === 'complete'
    && (!owner || (s.ownerReview === 'accepted' && s.validity !== 'needsRevalidation'))).map((s) => s.nodeId))
  // dispatched and not yet finished, short of a join still collecting what feeds it
  const now = new Set(subs.filter((s) => s.status !== 'complete' && !s.waiting).map((s) => s.nodeId))
  return { now: order.filter((id) => now.has(id)), done: done.size, total: order.length }
}

export const costLimit = (w: World, task: Task) => w.teams[task.teamId].settings.costLimitUsd + task.budgetBonus

export const statusOf = (w: World, task: Task) => (isOwnerTask(task) ? ownerStatus(task, subsOf(w, task.id)) : taskStatus(task, subsOf(w, task.id)))

/** The sample world's own words, in its language: what the simulator writes that no key translates. {holes} take args. */
const say2 = (w: World, zh: string, en: string, args?: Record<string, string>) =>
  mockText(w.language, zh, en).replace(/\{(\w+)\}/g, (hole, k: string) => args?.[k] ?? hole)
/** Names in a sentence of the sample world's language. */
const listIn = (w: World, names: string[]) => names.join(w.language === 'en' || w.language === 'ko' ? ', ' : '、')

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
  /** Run by its owner, as every new task is; the simulator's own tests leave it out to run a flow by itself. */
  orchestration?: 'owner'
}

/** A flow is shared, so a task's copy of it keeps only people from the task's own company. */
function ownStaff(w: World, teamId: string, wf: Workflow): Workflow {
  for (const n of wf.nodes) n.replicaIds = n.replicaIds.filter((r) => worksIn(w.replicas[r], teamId))
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
  if (input.orchestration === 'owner') {
    // nothing runs until the user starts it; then the owner dispatches the first steps
    task.orchestration = 'owner'
    task.coordination = newCoordination(task)
    return task
  }
  start(w, task)
  return task
}

/** Start every step a task's flow starts with, each from the task's description. */
function start(w: World, task: Task) {
  for (const n of startsOf(task.workflow)) spawn(w, task, n.id, [], null, w.now)
}

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

  for (const s of subs) if (s.status === 'progressing' && !s.meeting) advance(w, w.tasks[s.taskId], s, dt)
  for (const s of subs) if (s.talk?.replyAt !== undefined && w.now >= s.talk.replyAt) answer(w, s)
  // an owner decides where finished work goes; only a flow running itself routes it
  for (const s of subs) if (!s.cancelled && s.status === 'complete' && !s.routed && !isOwnerTask(w.tasks[s.taskId])) route(w, w.tasks[s.taskId], s)
  for (const s of Object.values(w.subTasks)) if (s.waiting && !s.cancelled && running(w.tasks[s.taskId])) checkJoin(w, s)
  // a merge waits for its owner; it goes before new work so the owner is not handed the next step first
  for (const t of Object.values(w.tasks)) if (t.stage === 'merging') stepMerge(w, t)
  dispatch(w)
  for (const c of Object.values(w.chats)) if (c.replyAt !== undefined && w.now >= c.replyAt) answerChat(w, c)

  for (const t of Object.values(w.tasks)) if (isOwnerTask(t) && running(t)) meetingTick(w, t)
  for (const t of Object.values(w.tasks)) if (isOwnerTask(t)) ownerTick(w, t)
  for (const t of Object.values(w.tasks)) {
    if (running(t) && !isOwnerTask(t)) {
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
    m.log.push({ at: w.now, kind: 'system', text: `${name ? `${name} ` : ''}${say2(w, '開始把 {branch} 合併到 {target}', 'Merging {branch} into {target}', { branch: task.branch, target })}` })
    if (m.conflict) m.log.push({ at: w.now, kind: 'system', text: say2(w, '和 {target} 有衝突，先解衝突', 'Conflicts with {target}; resolving them first', { target }) })
    return
  }
  if (w.now < m.endsAt!) return
  if (m.conflict) m.log.push({ at: w.now, kind: 'system', text: say2(w, '衝突已解決', 'Conflicts resolved') })
  m.log.push({ at: w.now, kind: 'system', text: say2(w, '已合併回 {target}，移除 work tree', 'Merged into {target}; work tree removed', { target }) })
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
    // under an owner a meeting runs among its people; the user asks the owner instead of joining it
    if (nodeOf(task.workflow, sub.nodeId)?.kind === 'talk' && !isOwnerTask(task)) openTalk(w, task, sub)
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
  say(w, sub, sub.script.talk?.opening ?? say2(w, '關於「{t}」，有幾件事想和你討論。', 'A few things to talk over with you about "{t}".', { t: task.title }))
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
  say(w, sub, replies[n] ?? say2(w, '好的，記下來了。', 'OK, noted.'))
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
    if (!r || !worksIn(r, chat.teamId) || chatHas(chat, id) || 1 + (chat.guests?.length ?? 0) >= MAX_CHAT_PEOPLE) continue
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
export const roundActor = (chat: Chat) => actorOf(chat, chat.history ? chat.history.mentions : chat.messages.findLast((m) => m.from === 'user')?.mentions)

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
  chat.messages.push({ at: w.now, from: 'tool', text: approve ? say2(w, '同意修改', 'Change approved') : say2(w, '拒絕修改', 'Change refused'), by: chat.speaker })
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
  { path: 'docs', dir: true }, { path: 'node_modules', dir: true, ignored: true }, { path: 'src', dir: true },
  { path: '.gitignore', dir: false }, { path: 'package.json', dir: false }, { path: 'README.md', dir: false }, { path: 'my notes.txt', dir: false },
  { path: 'docs/design.md', dir: false }, { path: 'src/components', dir: true }, { path: 'src/app.ts', dir: false }, { path: 'src/app.test.ts', dir: false },
  { path: 'src/components/Menu.tsx', dir: false }, { path: 'src/components/Menu.test.tsx', dir: false },
]

/** What the sample project's files hold. */
const MOCK_TEXT: Record<string, string> = {
  '.gitignore': 'node_modules/\ndist/\n.env\n',
  'package.json': '{\n  "name": "acme-shop",\n  "private": true,\n  "scripts": {\n    "dev": "vite",\n    "test": "vitest run"\n  }\n}\n',
  'README.md': '# Acme Shop\n\nThe online store.\n\n## Run\n\n```sh\nnpm install\nnpm run dev\n```\n',
  'my notes.txt': 'Check the banner on mobile.\n',
  'docs/design.md': '# Design\n\nThe menu opens from the top bar and closes on Escape.\n',
  'src/app.ts': "import { Menu } from './components/Menu'\n\nexport function start(root: HTMLElement) {\n  root.append(Menu({ items: ['Home', 'Shop', 'Cart'] }))\n}\n",
  'src/app.test.ts': "import { expect, it } from 'vitest'\nimport { start } from './app'\n\nit('shows the menu', () => {\n  const root = document.createElement('div')\n  start(root)\n  expect(root.textContent).toContain('Shop')\n})\n",
  'src/components/Menu.tsx': "export interface MenuProps {\n  items: string[]\n}\n\nexport function Menu({ items }: MenuProps) {\n  const nav = document.createElement('nav')\n  for (const item of items) {\n    const link = document.createElement('a')\n    link.textContent = item\n    nav.append(link)\n  }\n  return nav\n}\n",
  'src/components/Menu.test.tsx': "import { expect, it } from 'vitest'\nimport { Menu } from './Menu'\n\nit('lists every item', () => {\n  expect(Menu({ items: ['a', 'b'] }).children).toHaveLength(2)\n})\n",
}

/** The prototype's project: what a file holds, or an error for one it does not have. */
export function projectFile(path: string): string {
  if (!MOCK_FILES.some((f) => f.path === path && !f.dir)) throw new Error(`專案資料夾裡沒有 ${path}`)
  return MOCK_TEXT[path] ?? ''
}

/** One level of the prototype's project, as the backend lists it: folders first, then by name, case aside. */
export function projectTree(path: string): { entries: { name: string; path: string; kind: 'dir' | 'file'; ignored?: boolean }[]; truncated: boolean } {
  if (path && !MOCK_FILES.some((f) => f.path === path && f.dir)) throw new Error(`專案資料夾裡沒有 ${path}`)
  const prefix = path ? `${path}/` : ''
  const entries = MOCK_FILES
    .filter((f) => f.path.startsWith(prefix) && !f.path.slice(prefix.length).includes('/'))
    .map((f) => ({ name: f.path.slice(prefix.length), path: f.path, kind: f.dir ? 'dir' as const : 'file' as const, ...(f.ignored && { ignored: true }) }))
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
  return { entries, truncated: false }
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

/** One of a source's skills, by its path among the source's items. */
export function sourceSkill(w: World, sourceId: string, path: string): SkillText {
  const s = w.sources[sourceId]
  const it = s && itemsOf(s).find((x) => x.path === path)
  if (!it) throw new Error(`找不到技能 ${path}`)
  return { name: it.name, description: it.description, path: `${path}/SKILL.md`, text: `# ${it.name}\n\n原型不讀檔案，這裡只是示意。` }
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

/** What a copy handed off from a chat is named: its name, or the first message it shows without one, after a mark in the sample world's language; a name already marked is not marked again, and it is cut to what the user may give. */
function handOffTitle(w: World, chat: Chat) {
  let base = chat.title || (chat.messages[0]?.text ?? '').split(/\s+/).filter(Boolean).join(' ') || chat.id
  const prefix = say2(w, '交接：{name}', 'Handoff: {name}', { name: '' })
  if (base.startsWith(prefix)) base = base.slice(prefix.length)
  const room = 80 - [...prefix].length - 1
  if ([...base].length > room) base = [...base].slice(0, room).join('') + '…'
  return prefix + base
}

/** Copies a chat up to a message into a new chat, with the employee it had or another of the company who takes over. Nobody replies until the user says something in it. */
export function handOffChat(w: World, id: string, index: number, replicaId: string): Chat | undefined {
  const chat = w.chats[id]
  const m = chat?.messages[index]
  if (!m || m.from === 'tool') return undefined
  const taker = w.replicas[replicaId]
  if (chat.teamId ? !worksIn(taker, chat.teamId) : replicaId !== '') return undefined
  if (chat.replyAt !== undefined && !chat.messages.slice(index).some((x) => x.from === 'user')) return undefined
  const next = m.from === 'user' ? -1 : chat.messages.findIndex((x, i) => i > index && x.from === 'user')
  const keep = m.from === 'user' ? index + 1 : next < 0 ? chat.messages.length : next
  const fork: Chat = { ...chat, id: uid(w, 'chat'), messages: chat.messages.slice(0, keep).map((x) => ({ ...x })), handoffs: chat.handoffs?.map((h) => ({ ...h })), title: handOffTitle(w, chat), tokens: 0, createdAt: w.now }
  // it keeps the name marked as handed off, but not the pin
  delete fork.pinnedAt
  // a meeting handed to anyone, its chair too, goes on with them alone
  delete fork.guests
  // they take over from the user's message, or after the reply it ends with; handed to the same employee it is still marked, so the copy shows where it came from
  fork.handoffs = [...fork.handoffs ?? [], { before: m.from === 'user' ? index : keep, replicaId: chat.replicaId, name: chat.name, chatId: chat.id }]
  if (taker && replicaId !== chat.replicaId) {
    Object.assign(fork, { replicaId, name: taker.name, look: taker.look, model: taker.model })
    delete fork.effort
  }
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

/** Sets the question waiting on the user aside, unanswered, without waking the employee. */
export function skipChatQuestion(w: World, id: string) {
  const chat = w.chats[id]
  if (chat && chat.replyAt === undefined) delete chat.question
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
    chat.messages.push({ at: w.now, from: 'agent', text: say2(w, '你想先做哪一個？', 'Which do you want first?'), ...by })
    chat.question = { options: [say2(w, '先做前端', 'The frontend first'), say2(w, '先做後端', 'The backend first')] }
  } else chat.messages.push({ at: w.now, from: 'agent', text: say2(w, '收到。這是模擬的回覆，要實際對話請接上後端。', 'Got it. This is a simulated reply; connect the backend for a real chat.'), ...by })
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
    log(sub, w.now, 'human', say2(w, '結束討論：停止任務', 'Ended the discussion: stopped the task'))
    sub.status = 'complete'
    sub.endedAt = w.now
    stopTask(w, task.id)
    return
  }
  sub.status = 'complete'
  sub.endedAt = w.now
  sub.handoff = makeHandoff(w, roleOf(node), task, node)
  const user = say2(w, '使用者：', 'User: ')
  sub.handoff.agent.decisions = said.map((x) => `${user}${x}`)
  sub.handoff.human.did = said.length ? said.map((x) => `${user}${x}`) : [say2(w, '使用者沒有補充，照原計畫進行', 'The user added nothing; going ahead as planned')]
  if (end.kind === 'back') {
    const reason = end.reason.trim()
    log(sub, w.now, 'human', say2(w, '結束討論：退回（{reason}）', 'Ended the discussion: sent back ({reason})', { reason }))
    sendBack(w, task, sub, [sub], reason)
    return
  }
  const to = end.to ? nodeOf(wf, end.to)?.name : undefined
  log(sub, w.now, 'human', to ? say2(w, '結束討論：繼續，交給 {to}', 'Ended the discussion: continue, to {to}', { to }) : say2(w, '結束討論：繼續', 'Ended the discussion: continue'))
  if (end.to) {
    sub.routedTo = [end.to]
    sub.handoff.agent.next = { nodeId: end.to, reason: say2(w, '使用者在討論後指定', 'Picked by the user after the discussion') }
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
    const names = [...new Set(landed.map((o) => nodeOf(task.workflow, o.nodeId)?.name ?? o.nodeId))]
    log(sub, w.now, 'system', say2(w, 'commit 衝突：先合進 {names} 的 commit，解完衝突再 commit', 'Commit conflict: took in the commits of {names} first, then committed after resolving it', { names: listIn(w, names) }))
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
 * Whether a finished run sends the work back instead of handing it on: any step canSendBack allows, a task at most
 * `MAX_SEND_BACKS` times; each send-back halves the odds of the next.
 */
function sendsBack(w: World, task: Task, sub: SubTask) {
  const wf = task.workflow
  const node = nodeOf(wf, sub.nodeId)
  if (!node || node.kind !== 'work' || sub.sentBack || sub.skipped || !sub.upstreamIds.length) return false
  const last = outEdges(wf, node.id).length === 0
  if (!canSendBack(wf, node.id)) return false
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
  const names = listIn(w, to.map((n) => nodeOf(wf, n)?.name ?? n))
  for (const m of members) {
    m.routed = true
    m.sentBack = { to, reason }
    if (m.handoff) m.handoff.human.headline = say2(w, '退回 {names}：{reason}', 'Sent back to {names}: {reason}', { names, reason })
    log(m, w.now, 'system', `退回 ${names} 重做：${reason}`, 'sentBack', { nodes: names, reason })
  }
  const round = (sub.round ?? 0) + 1
  const from = nodeOf(wf, sub.nodeId)?.name ?? ''
  for (const u of before.values()) {
    const redo = spawn(w, task, u.nodeId, [...u.upstreamIds], sub.id, w.now, false, round)
    // the same employee while they still work the step; otherwise whoever works it now
    if (u.replicaId && w.replicas[u.replicaId] && nodeOf(wf, u.nodeId)?.replicaIds.includes(u.replicaId)) redo.replicaId = u.replicaId
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
      log(s, w.now, 'system', say2(w, '建立 work tree，分支 {branch}（從 {from}）', 'Created a work tree on branch {branch} (from {from})', { branch: task.branch, from: w.teams[task.teamId]?.targetBranch ?? 'main' }))
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
      if (sub.handoff) sub.handoff.agent.next = { nodeId: optionId, reason: note || say2(w, '使用者指定', 'Picked by the user') }
      break
    }
    case 'failed':
      if (optionId === 'skip') {
        sub.status = 'complete'
        sub.skipped = true
        sub.endedAt = w.now
        sub.handoff = {
          commit: '',
          agent: { goal: task.title, done: [], outputs: [], decisions: [say2(w, '使用者略過此節點', 'The user skipped this step')], open: [say2(w, '此節點沒有產出', 'This step has no output')] },
          human: { headline: say2(w, '此節點已略過，沒有產出。', 'This step was skipped and has no output.'), did: [], outputs: [] },
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

/** A task made and not yet started: paused with no pausedAt, or one its owner runs that the user has not started. It shows as 待辦, not 已暫停. */
export function notStarted(task: Task): boolean {
  if (isOwnerTask(task)) return task.coordination?.startedAt === undefined
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
  if (w.mockActivity) delete w.mockActivity[taskId]
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
  task.merge = { replicaId: by, conflict: task.mergeConflict, log: [{ at: w.now, kind: 'human', text: say2(w, '合併', 'Merge') }] }
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
  log(review, w.now, 'human', say2(w, '退回：{reason}', 'Sent back: {reason}', { reason }))
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
export function addProvider(w: World, input: Pick<ModelProvider, 'name' | 'kind' | 'baseUrl' | 'models' | 'thinking' | 'contextWindow'> & { login: ProviderLogin }): ModelProvider {
  const id = uid(w, 'mp')
  const auth = authOf(input.login)
  w.providers[id] = {
    id, name: input.name.trim(), kind: input.kind, auth,
    baseUrl: auth.kind === 'subscription' ? '' : input.baseUrl.trim(),
    models: [...new Set(input.models.map((m) => m.trim()).filter(Boolean))],
    thinking: input.thinking,
    ...(fixedContext(input.kind) || !input.contextWindow ? {} : { contextWindow: input.contextWindow }),
  }
  return w.providers[id]
}

/** Whether a provider's kind decides how many tokens its models read, leaving none to set. */
export const fixedContext = (kind: ModelProvider['kind']) => kind === 'anthropic' || kind === 'openai'

/**
 * Change a provider's name, address or sign-in; its kind, and so its models, stay. A null login keeps
 * the one it has, as does an empty key for a provider already on a key.
 */
export function updateProvider(w: World, id: string, input: { name: string; baseUrl: string; login: ProviderLogin | null; contextWindow?: number }) {
  const p = w.providers[id]
  if (!p) return
  const keep = !input.login || (input.login.kind === 'apiKey' && !input.login.apiKey.trim() && p.auth.kind === 'apiKey')
  if (!keep) p.auth = authOf(input.login!)
  p.name = input.name.trim()
  p.baseUrl = p.auth.kind === 'subscription' ? '' : input.baseUrl.trim()
  if (input.contextWindow !== undefined && !fixedContext(p.kind)) p.contextWindow = input.contextWindow || undefined
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

/** A task's unfinished sub-tasks begun by someone no longer on their step in `staff`, which has someone for it. */
export function swappable(w: World, taskId: string, staff: Record<string, string[]>): SubTask[] {
  return subsOf(w, taskId).filter((s) => {
    const ids = staff[s.nodeId]
    return ids && s.replicaId && !s.cancelled && s.status !== 'complete' && !ids.includes(s.replicaId) && ids.some((id) => w.replicas[id])
  })
}

/** Hands each of `swappable` to its step's first employee, who goes on from where it stopped, as when someone leaves. */
export function swapStaff(w: World, taskId: string, staff: Record<string, string[]>) {
  for (const s of swappable(w, taskId, staff)) {
    const to = w.replicas[staff[s.nodeId].find((id) => w.replicas[id])!]
    const from = w.replicas[s.replicaId!]?.name ?? ''
    s.replicaId = to.id
    if (s.status === 'progressing') s.status = 'todo'
    log(s, w.now, 'system', `${from} 換成 ${to.name}`, 'swapped', { from, to: to.name })
  }
}

/** What the user changes of a task on its edit sheet; `workflow` replaces its own flow, `planVersion` is the plan they saw. */
export interface TaskEdit {
  title: string
  description: string
  staff: Record<string, string[]>
  ownerId: string | null
  swap?: boolean
  workflow?: Workflow
  planVersion?: number
  controlVersion?: number
}

/** The steps of a task that ever ran: they stay in its flow. */
export const ranSteps = (w: World, taskId: string) => new Set(subsOf(w, taskId).map((s) => s.nodeId))

/** Whether a task's flow can still change: one its owner runs, until it is merged or cancelled. An older one's flow routes the work itself. */
export const flowEditable = (task: Task) => isOwnerTask(task) && (task.stage === 'running' || task.stage === 'awaitMerge')

/** What a new plan does to the old one, by step names, as the task's conversation lists it. */
function planChange(w: World, taskId: string, from: Workflow, to: Workflow) {
  const ran = ranSteps(w, taskId)
  const names = (ids: string[]) => (ids.length ? ids.map((id) => w.replicas[id]?.name ?? id).join('、') : '-')
  const gone = from.nodes.filter((n) => !nodeOf(to, n.id))
  const kept = gone.find((n) => ran.has(n.id))
  if (kept) throw new TaskRefusal(say2(w, '已執行過的步驟「{name}」不能移除', 'The step "{name}" already ran and cannot be removed', { name: kept.name }), 'conflict')
  const edge = (wf: Workflow, e: { from: string; to: string }) => `${nodeOf(wf, e.from)?.name ?? e.from} → ${nodeOf(wf, e.to)?.name ?? e.to}`
  const has = (wf: Workflow, e: { from: string; to: string }) => wf.edges.some((x) => x.from === e.from && x.to === e.to)
  const added: string[] = [], changed: string[] = [], restaffed: string[] = []
  for (const n of to.nodes) {
    const old = nodeOf(from, n.id)
    if (!old) { added.push(n.name); continue }
    if (old.replicaIds.join() !== n.replicaIds.join()) restaffed.push(`${n.name}：${names(old.replicaIds)} → ${names(n.replicaIds)}`)
    if (old.name !== n.name || old.prompt !== n.prompt || old.kind !== n.kind || old.handoff !== n.handoff || old.join !== n.join) changed.push(n.name)
  }
  return {
    added: added.join('、'), removed: gone.map((n) => n.name).join('、'), changed: changed.join('、'), restaffed: restaffed.join('；'),
    linked: to.edges.filter((e) => !has(from, e)).map((e) => edge(to, e)).join('、'),
    unlinked: from.edges.filter((e) => !has(to, e)).map((e) => edge(from, e)).join('、'),
  }
}

/** The parts of a change of the plan, in the order the conversation lists them. */
const PLAN_LINES = [['added', '新增', 'Added'], ['removed', '刪除', 'Removed'], ['changed', '修改', 'Changed'], ['restaffed', '改派', 'Reassigned'],
  ['linked', '新增依賴', 'New dependencies'], ['unlinked', '移除依賴', 'Removed dependencies']] as const

/**
 * The user changes a task, as the backend does: everything is checked before anything changes. A flow the user wrote
 * keeps every step that ran, and a task no longer on its blueprint's flow is named apart from it. On a task its owner
 * runs, the change is a new version of the plan, listed in the conversation; a changed flow takes a task waiting to be
 * merged back to work.
 */
export function updateTask(w: World, id: string, p: TaskEdit) {
  const t = w.tasks[id]
  if (!t) throw new TaskRefusal(say2(w, '找不到這個任務', 'Task not found'), 'not_found')
  const c = isOwnerTask(t) ? t.coordination : undefined
  if (c && (p.planVersion !== undefined && p.planVersion !== c.planVersion || p.controlVersion !== undefined && p.controlVersion !== c.controlVersion)) {
    throw new TaskRefusal(say2(w, '任務已更新，請確認最新狀態再操作', 'The task was updated; check where it is now and try again'), 'conflict')
  }
  let next = clone(t.workflow)
  if (p.workflow) {
    if (!flowEditable(t)) {
      throw new TaskRefusal(isOwnerTask(t)
        ? say2(w, '這個任務現在不能修改流程', 'This task\'s flow cannot be changed now')
        : say2(w, '舊制任務不能修改流程', 'A task run the older way cannot change its flow'), 'conflict')
    }
    next = { ...clone(p.workflow), id: t.workflow.id, name: t.workflow.name }
    if (next.nodes.some((n) => !n.name.trim())) throw new TaskRefusal(say2(w, '節點要有名稱', 'A node needs a name'), 'invalid_request')
    for (const n of next.nodes) n.name = n.name.trim()
    if (next.edges.some((e) => canReach(next, e.to, e.from))) throw new TaskRefusal(say2(w, '任務藍圖不能有迴圈', 'A workflow cannot loop'), 'invalid_request')
  }
  for (const n of next.nodes) if (p.staff[n.id]) n.replicaIds = [...p.staff[n.id]]
  const crowded = next.nodes.find((n) => n.kind !== 'talk' && n.replicaIds.length > 1)
  if (crowded) throw new TaskRefusal(say2(w, '工作步驟「{name}」只能有一位員工', 'The work step "{name}" can have only one employee', { name: crowded.name }), 'invalid_request')
  const empty = next.nodes.find((n) => (p.workflow || p.staff[n.id]) && !n.replicaIds.some((r) => w.replicas[r]))
  if (empty) throw new TaskRefusal(say2(w, '節點「{name}」沒有指派員工', 'Nobody works the node "{name}"', { name: empty.name }), 'invalid_request')
  const change = p.workflow ? planChange(w, id, t.workflow, next) : undefined
  const flowChanged = !!p.workflow && reshaped(t.workflow, next)
  const before = clone(t)
  t.title = p.title
  t.description = p.description
  t.ownerId = p.ownerId
  t.workflow = next
  if (flowChanged && t.workflowId) {
    t.workflowId = ''
    t.workflow.id = ''
    t.workflow.name = say2(w, '{name}（自訂）', '{name} (custom)', { name: t.workflow.name })
  }
  if (!c) {
    if (p.swap) swapStaff(w, id, p.staff)
    return
  }
  for (const r of [t.ownerId, ...t.workflow.nodes.flatMap((n) => n.replicaIds)]) if (r && !c.authorization.replicaIds.includes(r)) c.authorization.replicaIds.push(r)
  const restaffed = change ? !!change.restaffed : before.workflow.nodes.some((n) => n.replicaIds.join() !== nodeOf(t.workflow, n.id)?.replicaIds.join())
  const what = [
    ...(t.title !== before.title || t.description !== before.description ? ['the title or description'] : []),
    ...(flowChanged ? ['the plan\'s steps or links'] : []),
    ...(restaffed ? ['who works the steps'] : []),
    ...(t.ownerId !== before.ownerId ? ['the owner'] : []),
  ]
  if (!what.length) return
  if (t.ownerId !== before.ownerId) c.controlVersion++
  if (flowChanged && t.stage === 'awaitMerge') { // what was concluded has to be confirmed again
    t.stage = 'running'
    c.questions = c.questions.filter((q) => q.kind !== 'merge')
    c.controlVersion++
  }
  c.planVersion++
  const args: Record<string, string> = { what: what.join(', '), ...change }
  const lines = change ? PLAN_LINES.filter(([k]) => change[k]).map(([k, zh, en]) => `${say2(w, zh, en)}：${change[k]}`) : []
  taskEvent(w, t, 'editedByUser', [say2(w, '使用者修改了任務', 'You edited the task'), ...lines].join('\n'), args)
}

/**
 * Let an employee go, handing everything they still have to `heirId` first: the tasks they own, the steps
 * they are staffed on, and every unfinished sub-task. A job they were in the middle of keeps its progress
 * and waits for the heir to be free, so the heir still works one thing at a time.
 */
/**
 * The companies where employee `id` has work to hand over before leaving: a step, the ownership or the merge of a task
 * not finished, or a run not done; as the backend's pendingTeams.
 */
export function pendingTeams(w: World, id: string): string[] {
  const out = new Set<string>()
  for (const t of Object.values(w.tasks)) {
    if (t.stage === 'done' || t.stage === 'cancelled') continue
    if (t.ownerId === id || t.merge?.replicaId === id || t.workflow.nodes.some((n) => n.replicaIds.includes(id))) out.add(t.teamId)
  }
  for (const s of Object.values(w.subTasks)) {
    if (s.replicaId !== id || s.cancelled || s.status === 'complete') continue
    const t = w.tasks[s.taskId]
    if (t) out.add(t.teamId)
  }
  return [...out].sort()
}

/** Who can take over from employee `id`: someone else able to work wherever their work is, as the backend checks. */
export function heirsOf(w: World, id: string): Replica[] {
  const r = w.replicas[id]
  if (!r) return []
  const teams = r.teamId === STAFFING_ID ? pendingTeams(w, id) : [r.teamId]
  const all = r.teamId === STAFFING_ID ? Object.values(w.replicas) : [...Object.values(w.replicas)].filter((x) => worksIn(x, r.teamId))
  return all.filter((x) => x.id !== id && teams.every((t) => worksIn(x, t)))
}

/** Whether employee `id` can leave with nobody taking over: one of the staffing agency's with no work to hand over. */
export const leavesAlone = (w: World, id: string) => w.replicas[id]?.teamId === STAFFING_ID && pendingTeams(w, id).length === 0

/** Whether employee `id` is the last of their company's own, who has to stay; the staffing agency may be left empty. */
export const lastOfTeam = (w: World, id: string) => {
  const r = w.replicas[id]
  return !!r && r.teamId !== STAFFING_ID && Object.values(w.replicas).filter((x) => x.teamId === r.teamId).length < 2
}

/** Refuses letting employee `id` go to `heirId` (or to nobody, when empty) by throwing; changes nothing. */
function checkFire(w: World, id: string, heirId: string): Replica {
  const r = w.replicas[id]
  if (!r) throw new Error(`找不到員工`)
  if (lastOfTeam(w, id)) throw new Error(`公司至少要有一位員工`)
  if (!heirId) {
    if (!leavesAlone(w, id)) throw new Error(`還有工作要交接，請選擇接手的員工`)
  } else if (!heirsOf(w, id).some((x) => x.id === heirId)) throw new Error(`${w.replicas[heirId]?.name ?? ''} 不能接手這些工作`)
  return r
}

/**
 * Lets an employee go, handing what is theirs to `heirId`, as the backend's Fire: a company keeps one employee of its
 * own, and one of the staffing agency's with no work left may go with no heir (`heirId` empty). Refusals throw.
 */
export function fire(w: World, id: string, heirId: string) {
  const r = checkFire(w, id, heirId)
  const swap = (ids: string[]) => [...new Set(ids.flatMap((x) => (x !== id ? [x] : heirId ? [heirId] : [])))]
  for (const wf of Object.values(w.workflows)) for (const n of wf.nodes) n.replicaIds = swap(n.replicaIds)
  if (heirId) {
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
  }
  endChatsOf(w, id)
  dropOwnBlueprint(w, r)
  delete w.replicas[id]
}

/**
 * Moves an employee between a company and the staffing agency, as the backend's MoveReplica: let go where they are,
 * as `fire` does, and hired anew at `to` with the same name, look, settings, model and level, but no memory. All or
 * nothing: a refusal throws before anything changes.
 */
export function moveReplica(w: World, id: string, to: string, heirId: string): Replica {
  const r = w.replicas[id]
  if (!r) throw new Error(`找不到員工`)
  if (to !== STAFFING_ID && !w.teams[to]) throw new Error(`找不到公司`)
  if ((r.teamId === STAFFING_ID) === (to === STAFFING_ID)) throw new Error(`只能在公司和人力資源公司之間移動員工`)
  checkFire(w, id, heirId)
  const own = w.blueprints[r.blueprintId]?.owner === r.id ? structuredClone(w.blueprints[r.blueprintId]) : undefined
  const moved: Replica = { ...structuredClone(r), id: uid(w, 'rep'), teamId: to, memory: [], hiredAt: w.now }
  fire(w, id, heirId)
  if (own) {
    own.id = uid(w, 'bp')
    own.owner = moved.id
    w.blueprints[own.id] = own
    moved.blueprintId = own.id
  }
  w.replicas[moved.id] = moved
  return moved
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

/**
 * Remove a blueprint anyone can be hired from. Employees made from it move to blueprint `to` first; without a `to` that
 * can take them (another one anyone is hired from, not the airport staff's), it is false and nothing changes.
 */
export function deleteBlueprint(w: World, id: string, to?: string): boolean {
  if (!w.blueprints[id] || w.blueprints[id].owner) return false
  const users = blueprintUsers(w, id)
  if (users.length) {
    const target = to ? w.blueprints[to] : undefined
    if (!target || target.owner || to === id || to === AIRPORT_BLUEPRINT_ID) return false
    for (const r of users) r.blueprintId = to!
  }
  delete w.blueprints[id]
  return true
}

/** Every Git source a blueprint reads: its own, then those of its skill packs. */
export function gitSources(bp: Blueprint): GitSource[] {
  return [bp.source, ...bp.skills.map((p) => p.source)].filter((s): s is GitSource => s?.kind === 'git')
}

/** Why an update can fail, besides a missing upstream. */
const UPDATE_ERRORS = { zh: ['驗證失敗，沒有讀取權限', '新版本缺少 SKILL.md', '下載逾時'], en: ['Authentication failed: no read access', 'The new version has no SKILL.md', 'The download timed out'] }

/**
 * Move a Git source to its newest version. It fails when the upstream can't be found, and now and then for
 * other reasons; a failed update keeps the version in use. Either way the attempt is recorded.
 */
export function updateSource(w: World, s: GitSource) {
  const error = !s.upstream ? say2(w, '找不到上游', 'Upstream not found') : chance(w, 0.25) ? pick(w, mockText(w.language, UPDATE_ERRORS.zh, UPDATE_ERRORS.en)) : undefined
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
  const wf: Workflow = { id: uid(w, 'wf'), name, ...blankSteps((p) => uid(w, p), mockText(w.language, '新步驟1', 'New step 1')) }
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
    settings: { timeoutMin: 120, costLimitUsd: 3, retries: 1 },
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

// ---------- tasks their owner runs ----------
// The simulator plays the owner simply: it takes in what the user says and replies, dispatches each step whose way in
// is done, takes in what comes back a moment later, and reports the task done. The backend's owner is a model.

/** Seconds the simulated owner takes to answer, take in a handoff, or confirm a stop. */
export const OWNER_TIME = 3
export const STOP_TIME = 1

/** A request the simulator turns down, as the backend would: `code` is the API's error code. */
export class TaskRefusal extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
  }
}

export function newCoordination(task: Task): TaskCoordination {
  const staff = task.workflow.nodes.flatMap((n) => n.replicaIds)
  return {
    planVersion: 1, controlVersion: 1, ownerState: 'idle', ownerCostUsd: 0, ownerTokens: 0,
    history: { version: '0', count: 0 },
    authorization: { replicaIds: [...new Set([...(task.ownerId ? [task.ownerId] : []), ...staff])], planChanges: true },
    facts: [], questions: [], operations: [],
  }
}

function ownerTask(w: World, id: string): Task & { coordination: TaskCoordination } {
  const t = w.tasks[id]
  if (!t) throw new TaskRefusal(say2(w, '找不到這個任務', 'Task not found'), 'not_found')
  if (!isOwnerTask(t) || !t.coordination) throw new TaskRefusal(say2(w, '這是舊制任務，沒有負責人對話', 'This task runs the older way and has no owner conversation'), 'conflict')
  return t as Task & { coordination: TaskCoordination }
}

/** Who said something, as they were then. */
const byWhom = (w: World, id: string | null | undefined) => {
  const r = id ? w.replicas[id] : undefined
  return r ? { by: r.id, name: r.name, look: { ...r.look } } : {}
}

export function postActivity(w: World, task: Task, a: Omit<TaskActivity, 'id' | 'seq' | 'at' | 'planVersion'>): TaskActivity {
  const list = ((w.mockActivity ??= {})[task.id] ??= [])
  const c = task.coordination!
  const item: TaskActivity = { id: uid(w, 'act'), seq: list.length + 1, at: w.now, planVersion: c.planVersion, ...a }
  list.push(item)
  c.history = { version: String(item.seq), count: item.seq }
  return item
}

const taskEvent = (w: World, task: Task, key: string, text: string, args: Record<string, string> = {}, extra: Partial<TaskActivity> = {}) =>
  postActivity(w, task, { kind: 'event', from: 'system', key, text: text.replace(/\{(\w+)\}/g, (hole, k: string) => args[k] ?? hole), args, ...extra })

const ownerSays = (w: World, task: Task, text: string) =>
  postActivity(w, task, { kind: 'message', from: 'agent', text, ...byWhom(w, task.ownerId) })

const ownerName = (w: World, task: Task) => (task.ownerId ? w.replicas[task.ownerId]?.name : undefined) ?? ''

function operation(w: World, task: Task, kind: TaskOperation['kind'], requestId: string, extra: Partial<TaskOperation> = {}): TaskOperation {
  const c = task.coordination!
  const op: TaskOperation = { id: uid(w, 'op'), requestId, kind, status: 'received', at: w.now, updatedAt: w.now, ...extra }
  c.operations.push(op)
  // every open one, and the last 20 closed
  const closed = c.operations.filter((o) => o.status === 'applied' || o.status === 'failed')
  if (closed.length > 20) {
    const old = new Set(closed.slice(0, closed.length - 20).map((o) => o.id))
    c.operations = c.operations.filter((o) => !old.has(o.id))
  }
  return c.operations[c.operations.length - 1]
}

const settleOp = (w: World, op: TaskOperation, status: TaskOperation['status']) => {
  op.status = status
  op.updatedAt = w.now
}

const ended = (w: World) => new TaskRefusal(say2(w, '這個任務已經結束，不能再這樣做', 'This task has ended; that is no longer possible'), 'conflict')

export interface OwnerMessage {
  requestId: string
  text: string
  images?: Attachment[]
  files?: Attachment[]
  /** Into the meeting under way, where `mentions` answer in order; else to the owner. */
  meetingId?: string
  mentions?: string[]
}

/** The user tells the owner something. It is kept at once; the owner takes it in on its next turn. */
export function sayToOwner(w: World, taskId: string, m: OwnerMessage): { operation: TaskOperation; activity: TaskActivity } {
  const task = ownerTask(w, taskId)
  const c = task.coordination
  const again = c.operations.find((o) => o.requestId === m.requestId)
  if (again) return { operation: again, activity: (w.mockActivity?.[task.id] ?? []).find((a) => a.id === again.messageId)! }
  if (!m.text.trim() && !m.images?.length && !m.files?.length) throw new TaskRefusal(say2(w, '訊息是空的', 'The message is empty'), 'invalid_request')
  if (task.stage !== 'running' && task.stage !== 'awaitMerge') throw ended(w)
  if (m.meetingId || m.mentions?.length) return sayInMeeting(w, task, m)
  if (c.activeMeetingId) throw new TaskRefusal(say2(w, '現在正在開會，訊息沒有送出', 'A meeting is under way; the message was not sent'), 'conflict')
  const activity = postActivity(w, task, { kind: 'message', from: 'user', text: m.text.trim(), ...(m.images?.length ? { images: m.images } : {}), ...(m.files?.length ? { files: m.files } : {}) })
  const op = operation(w, task, 'message', m.requestId, { messageId: activity.id })
  activity.operationId = op.id
  c.controlVersion++
  c.ownerState = 'queued'
  // what the owner reported done has to be looked at again with this in mind, so a card to merge it is gone
  if (task.stage === 'awaitMerge') {
    task.stage = 'running'
    c.questions = c.questions.filter((q) => q.kind !== 'merge')
  }
  return { operation: op, activity }
}

export type OwnerControl =
  | { requestId: string; action: 'pause' }
  | { requestId: string; action: 'resume'; planVersion: number; controlVersion: number }
  | { requestId: string; action: 'return'; subId: string; reason: string; planVersion: number; controlVersion: number }
  | { requestId: string; action: 'retry'; operationId: string; planVersion: number; controlVersion: number }
  | { requestId: string; action: 'answer'; questionId: string; optionId: string; note?: string; planVersion: number; controlVersion: number }

/** Every run that read `sub`'s work, and every run that read theirs. */
function readersOf(w: World, task: Task, sub: SubTask): SubTask[] {
  const found = new Set([sub.id])
  const out: SubTask[] = []
  for (let grew = true; grew;) {
    grew = false
    for (const s of subsOf(w, task.id)) {
      if (!found.has(s.id) && currentRun(s) && s.upstreamIds.some((u) => found.has(u))) {
        found.add(s.id)
        out.push(s)
        grew = true
      }
    }
  }
  return out
}

/** Asks the runs given to stop: none goes on, and each is stopped once that is confirmed. */
function askStop(w: World, runs: SubTask[]) {
  const asked: string[] = []
  for (const s of runs) {
    if (s.status !== 'progressing' && s.executionState !== 'running') continue
    s.status = 'todo'
    s.executionState = 'stopping'
    log(s, w.now, 'system', '任務已暫停，中斷工作', 'paused')
    asked.push(s.id)
  }
  return asked
}

/** The user pauses, starts or resumes, sends a step back, retries the owner or answers a question. */
export function controlOwnerTask(w: World, taskId: string, b: OwnerControl): { operation: TaskOperation } {
  const task = ownerTask(w, taskId)
  const c = task.coordination
  const again = c.operations.find((o) => o.requestId === b.requestId)
  if (again) return { operation: again }
  if (task.stage !== 'running' && task.stage !== 'awaitMerge') throw ended(w)
  // a pause goes through whatever the screen showed; anything else is decided on what the user saw
  if (b.action !== 'pause' && (b.planVersion !== c.planVersion || b.controlVersion !== c.controlVersion)) {
    throw new TaskRefusal(say2(w, '任務在你看到之後有了變化，請看過最新狀態再試', 'The task changed after you saw it; check where it is now and try again'), 'conflict')
  }
  const subs = subsOf(w, task.id)
  switch (b.action) {
    case 'pause': {
      const op = operation(w, task, 'pause', b.requestId)
      if (task.paused) {
        settleOp(w, op, 'applied')
        return { operation: op }
      }
      const meeting = c.activeMeetingId ? w.subTasks[c.activeMeetingId]?.meeting : undefined
      if (meeting?.state === 'open') pauseMeeting(meeting, 'taskPaused')
      task.paused = true
      task.pausedAt = w.now
      c.controlVersion++
      op.affectedSubIds = askStop(w, subs.filter(currentRun))
      settleOp(w, op, op.affectedSubIds.length ? 'processing' : 'applied')
      taskEvent(w, task, 'paused', say2(w, '任務已暫停', 'Task paused'), {}, { operationId: op.id })
      return { operation: op }
    }
    case 'resume': {
      const why = resumeBlock(task, subs)
      if (why) {
        throw new TaskRefusal(why === 'owner' ? say2(w, '先選任務負責人', 'Pick the task owner first')
          : why === 'stopping' ? say2(w, '還在停止執行中的步驟，等停好再繼續', 'Steps are still being stopped; continue once they have')
          : why === 'uncertain' ? say2(w, '有步驟無法確認是否已停止，請先確認', 'A step may still be running; check it first')
          : say2(w, '先回答待決的問題', 'Answer the open question first'), 'conflict')
      }
      if (!task.paused) throw new TaskRefusal(say2(w, '任務沒有暫停', 'The task is not paused'), 'conflict')
      const first = c.startedAt === undefined
      task.paused = false
      task.pausedAt = undefined
      task.pausedStatus = undefined
      c.controlVersion++
      if (first) {
        c.startedAt = w.now
        c.ownerState = 'queued'
      }
      // a run stopped by the pause starts again as a new run
      for (const s of subs) {
        if (currentRun(s) && s.executionState === 'stopped') {
          s.executionState = 'queued'
          s.runGeneration = (s.runGeneration ?? 1) + 1
        }
      }
      const op = operation(w, task, 'resume', b.requestId)
      settleOp(w, op, 'applied')
      taskEvent(w, task, first ? 'started' : 'resumed', first ? say2(w, '任務開始', 'Task started') : say2(w, '任務繼續', 'Task resumed'), {}, { operationId: op.id })
      return { operation: op }
    }
    case 'return': {
      const sub = w.subTasks[b.subId]
      if (!sub || sub.taskId !== task.id || !currentRun(sub)) throw new TaskRefusal(say2(w, '這一步已經有新的重做，不能再退回', 'This step has been redone since; it cannot be sent back'), 'conflict')
      const reason = b.reason.trim()
      if (!reason) throw new TaskRefusal(say2(w, '請寫退回原因', 'Say why it goes back'), 'invalid_request')
      // the task stops where it is: nothing new is dispatched until the user resumes
      task.paused = true
      task.pausedAt ??= w.now
      if (task.stage === 'awaitMerge') task.stage = 'running'
      c.controlVersion++
      const readers = readersOf(w, task, sub)
      const op = operation(w, task, 'return', b.requestId, { subId: sub.id, affectedSubIds: [sub.id, ...readers.map((s) => s.id)] })
      const asked = askStop(w, [sub, ...readers])
      sub.validity = 'superseded'
      for (const s of readers) s.validity = 'needsRevalidation'
      const redo = spawn(w, task, sub.nodeId, [...sub.upstreamIds], sub.parentId, w.now)
      redo.script = { ...redo.script, ask: undefined, fail: undefined, sendBack: undefined }
      redo.replicaId = sub.replicaId
      redo.rework = { from: sub.id, reason }
      redo.instruction = sub.instruction
      redo.planVersion = c.planVersion
      redo.runGeneration = (sub.runGeneration ?? 1) + 1
      redo.executionState = 'queued'
      redo.validity = 'current'
      settleOp(w, op, asked.length ? 'processing' : 'applied')
      const step = nodeOf(task.workflow, sub.nodeId)?.name ?? sub.nodeId
      taskEvent(w, task, 'returned', say2(w, '「{step}」退回重做：{reason}', '"{step}" sent back to redo: {reason}'), { step, reason }, { subId: sub.id, nodeId: sub.nodeId, operationId: op.id })
      return { operation: op }
    }
    case 'retry': {
      const failed = c.operations.find((o) => o.id === b.operationId && o.status === 'failed')
      if (!failed) throw new TaskRefusal(say2(w, '沒有可以重試的失敗', 'Nothing failed to retry'), 'conflict')
      c.ownerState = 'queued'
      c.blockedReason = undefined
      const op = operation(w, task, 'retry', b.requestId)
      settleOp(w, op, 'applied')
      return { operation: op }
    }
    case 'answer': {
      const q = c.questions.find((x) => x.id === b.questionId && x.audience === 'user')
      if (!q) throw new TaskRefusal(say2(w, '這個問題已經回答過，或不再適用', 'This question was answered already or no longer applies'), 'conflict')
      const option = q.options.find((o) => o.id === b.optionId)
      if (!option) throw new TaskRefusal(say2(w, '沒有這個選項', 'No such option'), 'invalid_request')
      c.questions = c.questions.filter((x) => x.id !== q.id)
      c.controlVersion++
      const label = option.label ?? (option.id === 'approve' ? say2(w, '同意', 'Agree') : option.id === 'reject' ? say2(w, '拒絕', 'Refuse') : option.id)
      const said = postActivity(w, task, { kind: 'message', from: 'user', text: [label, b.note?.trim()].filter(Boolean).join('\n'), questionId: q.id })
      if (q.kind === 'approval' && option.id === 'approve' && q.change?.kind === 'employees') {
        for (const l of q.change.lines) if (l.after && w.replicas[l.after] && !c.authorization.replicaIds.includes(l.after)) c.authorization.replicaIds.push(l.after)
      }
      const op = operation(w, task, 'answer', b.requestId, { messageId: said.id })
      said.operationId = op.id
      // merging is the user's own press: the owner has nothing more to decide
      if (q.kind === 'merge' && option.id === 'merge') {
        mergeTask(w, task.id)
        settleOp(w, op, 'applied')
        return { operation: op }
      }
      c.ownerState = 'queued'
      return { operation: op }
    }
  }
}

/** A page of a task's conversation, oldest first: the newest `limit` before `before` (exclusive), or the newest. */
export function activityPage(w: World, taskId: string, q: { before?: number; limit?: number; version?: string }) {
  const task = ownerTask(w, taskId)
  const list = w.mockActivity?.[taskId] ?? []
  const version = task.coordination.history.version
  if (q.version && q.version !== version) throw new TaskRefusal(say2(w, '對話已經更新', 'The conversation has changed'), 'conflict')
  const end = q.before === undefined ? list.length : Math.max(0, Math.min(q.before - 1, list.length))
  const start = Math.max(0, end - Math.min(100, Math.max(1, q.limit ?? 50)))
  return { version, total: list.length, items: clone(list.slice(start, end)), hasMore: start > 0 }
}

export function activityItem(w: World, taskId: string, id: string): TaskActivity {
  ownerTask(w, taskId)
  const a = w.mockActivity?.[taskId]?.find((x) => x.id === id)
  if (!a) throw new TaskRefusal(say2(w, '找不到這則訊息', 'Message not found'), 'not_found')
  return clone(a)
}

/** The owner gives a step to its employee, with what to do. */
function dispatchStep(w: World, task: Task, nodeId: string, from: SubTask[]) {
  const c = task.coordination!
  const n = nodeOf(task.workflow, nodeId)!
  const guests = [...new Set(n.replicaIds)].filter((r) => r !== task.ownerId && w.replicas[r])
  if (n.kind === 'talk' && task.ownerId && guests.length) return holdMeeting(w, task, nodeId, n.name, guests.slice(0, MEETING_GUESTS), from)
  const s = spawn(w, task, nodeId, from.map((x) => x.id), from[0]?.id ?? null, w.now)
  s.script = { ...s.script, ask: undefined, fail: undefined, sendBack: undefined }
  s.replicaId = n.replicaIds.find((r) => w.replicas[r]) ?? task.ownerId
  s.instruction = n.prompt || say2(w, '依任務說明完成「{step}」', 'Do "{step}" as the task asks', { step: n.name })
  s.planVersion = c.planVersion
  s.runGeneration = 1
  s.executionState = 'queued'
  s.validity = 'current'
  const name = (s.replicaId ? w.replicas[s.replicaId]?.name : undefined) ?? ''
  taskEvent(w, task, 'dispatched', say2(w, '{owner} 派 {name} 做「{step}」', '{owner} gave "{step}" to {name}'), { owner: ownerName(w, task), name, step: n.name }, { subId: s.id, nodeId })
}

/** A run's work comes back to the owner: a meeting's words first, then what its employee handed on. */
function handBack(w: World, task: Task, s: SubTask) {
  // a meeting held in the conversation brings back its conclusion alone, already there
  if (s.meeting) return
  const n = nodeOf(task.workflow, s.nodeId)
  if (n?.kind === 'talk') {
    const people = n.replicaIds.filter((r) => w.replicas[r])
    const lines = [s.script.talk?.opening, ...(s.script.talk?.replies ?? [])].filter((x): x is string => !!x)
    people.forEach((r, i) => {
      if (lines[i]) postActivity(w, task, { kind: 'meeting', from: 'agent', text: lines[i], ...byWhom(w, r), subId: s.id, nodeId: s.nodeId, meetingId: s.id })
    })
  }
  postActivity(w, task, { kind: 'handoff', from: 'agent', text: s.handoff?.human.headline ?? '', ...byWhom(w, s.replicaId), subId: s.id, nodeId: s.nodeId })
}

/** The simulated owner's turn: confirm stops, answer the user, take in work, dispatch what can start, report done. */
function ownerTick(w: World, task: Task) {
  const c = task.coordination
  if (!c) return
  const subs = subsOf(w, task.id)
  for (const op of c.operations) {
    if ((op.kind === 'pause' || op.kind === 'return') && op.status === 'processing' && w.now >= op.updatedAt + STOP_TIME) {
      for (const id of op.affectedSubIds ?? []) {
        const s = w.subTasks[id]
        if (s?.executionState === 'stopping') s.executionState = 'stopped'
      }
      settleOp(w, op, 'applied')
      taskEvent(w, task, 'stopped', say2(w, '執行中的步驟都已停止', 'Every running step has stopped'), {}, { operationId: op.id })
    }
  }
  for (const s of subs) if (currentRun(s) && s.status === 'progressing') s.executionState = 'running'
  if (task.stage !== 'running') return
  // what the user said comes first: taken in, then answered
  let busy = false
  for (const op of c.operations) {
    if ((op.kind !== 'message' && op.kind !== 'answer') || (op.status !== 'received' && op.status !== 'processing')) continue
    busy = true
    if (op.status === 'received') {
      settleOp(w, op, 'processing')
      c.ownerState = 'responding'
    } else if (w.now >= op.updatedAt + OWNER_TIME) {
      settleOp(w, op, 'applied')
      c.ownerCostUsd += 0.012
      c.ownerTokens += 1400
      ownerSays(w, task, task.paused
        ? say2(w, '收到。任務暫停中，我先記下來，等你繼續後照這個方向安排。', 'Got it. The task is paused, so I have noted it, and will plan by it once you continue.')
        : say2(w, '收到，接下來的安排會照這個方向調整。', 'Got it. I will plan the next steps around it.'))
    }
  }
  if (busy) return
  if (c.startedAt === undefined || task.paused) {
    c.ownerState = 'idle'
    return
  }
  const live = subs.filter(currentRun)
  // finished work comes back to the owner, who takes it in a moment later
  for (const s of live) {
    if (s.status === 'complete' && !s.ownerReview) {
      s.ownerReview = 'pending'
      s.routed = true
      handBack(w, task, s)
    }
  }
  for (const s of live) {
    if (s.ownerReview === 'pending' && w.now >= (s.endedAt ?? w.now) + OWNER_TIME) {
      s.ownerReview = 'accepted'
      c.ownerCostUsd += 0.008
      c.ownerTokens += 900
      const step = nodeOf(task.workflow, s.nodeId)?.name ?? s.nodeId
      taskEvent(w, task, 'accepted', say2(w, '{owner} 接受「{step}」的交付', '{owner} accepted "{step}"'), { owner: ownerName(w, task), step }, { subId: s.id, nodeId: s.nodeId })
    }
  }
  if (live.some((s) => s.ownerReview === 'pending')) {
    c.ownerState = 'responding'
    return
  }
  // a run sent back has to be redone, and the runs that read it are checked again once it is
  for (const s of live) {
    if (s.validity === 'needsRevalidation' && s.ownerReview === 'accepted' && !live.some((o) => o.ownerReview !== 'accepted' && s.upstreamIds.includes(o.id))) s.validity = 'current'
  }
  const wf = task.workflow
  const accepted = (nodeId: string) => live.filter((s) => s.nodeId === nodeId && s.ownerReview === 'accepted')
  const open = (nodeId: string) => live.some((s) => s.nodeId === nodeId && s.ownerReview !== 'accepted')
  let dispatched = 0
  for (const n of wf.nodes) {
    if (accepted(n.id).length || open(n.id)) continue
    if (n.kind === 'talk' && c.activeMeetingId) continue
    const ins = inEdges(wf, n.id)
    // the ways in whose step is done and, where that step picks one way on, picked this one
    const chosen = ins.filter((e) => {
      const done = accepted(e.from)
      if (!done.length) return false
      const outs = outEdges(wf, e.from)
      if (nodeOf(wf, e.from)?.handoff !== 'pickOne' || outs.length < 2) return true
      const r = done[done.length - 1].script.route
      return outs[(typeof r === 'number' ? r : 0) % outs.length].to === n.id
    })
    if (ins.length && (n.join === 'all' ? chosen.length < ins.length : !chosen.length)) continue
    dispatchStep(w, task, n.id, chosen.flatMap((e) => accepted(e.from).slice(-1)))
    dispatched++
  }
  if (dispatched) {
    c.ownerCostUsd += 0.006
    c.ownerTokens += 700
    c.ownerState = 'idle'
    return
  }
  if (live.length && live.every((s) => s.ownerReview === 'accepted' && s.validity !== 'needsRevalidation') && !c.questions.length) {
    task.stage = 'awaitMerge'
    c.ownerState = 'idle'
    taskEvent(w, task, 'completed', say2(w, '{owner} 回報完成，等你決定合併', '{owner} reported it done; merging is up to you'), { owner: ownerName(w, task) })
    ownerSays(w, task, say2(w, '每一步都完成並確認過了，可以合併。要改什麼也可以直接跟我說。', 'Every step is done and checked; it is ready to merge. Tell me if anything should change.'))
    w.events.push({ kind: 'awaitMerge', taskId: task.id })
    return
  }
  c.ownerState = 'idle'
}

// ---------- meetings held in the conversation ----------

/** How many employees a meeting holds besides its chair, and how many model calls the user allows at a time. */
export const MEETING_GUESTS = 6
export const MEETING_BATCH = 36

const meetingOf = (w: World, task: Task, id: string | undefined) => {
  const s = id ? w.subTasks[id] : undefined
  return s?.taskId === task.id && s.meeting ? s as SubTask & { meeting: Meeting } : undefined
}

const queueOf = (w: World, id: string) => ((w.mockMeetingQueue ??= {})[id] ??= { ids: [], at: w.now })

function pauseMeeting(m: Meeting, why: NonNullable<Meeting['pauseReason']>) {
  m.state = 'paused'
  m.pauseReason = why
  m.speakerId = undefined
  m.revision++
}

/** The owner calls a meeting on a talk step: it chairs, opens, then calls on everyone once. */
function holdMeeting(w: World, task: Task, nodeId: string, topic: string, guests: string[], from: SubTask[] = []): SubTask {
  const c = task.coordination!
  const s = spawn(w, task, nodeId, from.map((x) => x.id), from[0]?.id ?? null, w.now)
  const chair = task.ownerId!
  s.replicaId = chair
  s.status = 'progressing'
  s.startedAt = w.now
  s.planVersion = c.planVersion
  s.runGeneration = 1
  s.executionState = 'running'
  s.validity = 'current'
  s.meeting = {
    version: 2, id: s.id, topic, chairId: chair, state: 'open', revision: 1, batch: 1, callsInBatch: 0, callsTotal: 0, startedAt: w.now,
    participants: [chair, ...guests].map((id) => {
      const r = w.replicas[id]
      return { replicaId: id, name: r.name, look: { ...r.look }, model: r.model, ...(r.effort ? { effort: r.effort } : {}) }
    }),
  }
  c.activeMeetingId = s.id
  w.mockMeetingQueue = { ...w.mockMeetingQueue, [s.id]: { ids: [chair, ...guests, chair], at: w.now + REPLY_TIME } }
  taskEvent(w, task, 'meetingCalled', say2(w, '{owner} 召開會議：{topic}', '{owner} called a meeting: {topic}'), { topic, owner: ownerName(w, task) }, { subId: s.id, nodeId })
  return s
}

/** The user speaks in the meeting under way: those mentioned answer in order, else the chair. */
function sayInMeeting(w: World, task: Task & { coordination: TaskCoordination }, m: OwnerMessage) {
  const c = task.coordination
  const s = meetingOf(w, task, m.meetingId)
  if (!s) throw new TaskRefusal(say2(w, '找不到這場會議', 'Meeting not found'), 'not_found')
  const mt = s.meeting
  if (c.activeMeetingId !== s.id || mt.state === 'ended' || mt.state === 'cancelled') throw new TaskRefusal(say2(w, '這場會議已結束，訊息沒有送出', 'This meeting is over; the message was not sent'), 'conflict')
  if (mt.state === 'closing' || mt.state === 'summaryFailed') throw new TaskRefusal(say2(w, '會議正在結束，不能再發言', 'The meeting is ending; no more words'), 'conflict')
  const mentions = [...new Set(m.mentions ?? [])]
  if (mentions.some((id) => !mt.participants.some((p) => p.replicaId === id))) throw new TaskRefusal(say2(w, '只能指定這場會議的與會者', 'Only those in this meeting can be asked'), 'invalid_request')
  const activity = postActivity(w, task, {
    kind: 'meeting', from: 'user', text: m.text.trim(), meetingVersion: 2, meetingPart: 'speech', meetingId: s.id, subId: s.id, nodeId: s.nodeId,
    ...(mentions.length ? { mentions } : {}), ...(m.images?.length ? { images: m.images } : {}), ...(m.files?.length ? { files: m.files } : {}),
  })
  const op = operation(w, task, 'message', m.requestId, { messageId: activity.id, subId: s.id })
  activity.operationId = op.id
  settleOp(w, op, 'applied')
  const q = queueOf(w, s.id)
  if (!q.ids.length) q.at = w.now + REPLY_TIME
  q.ids.push(...(mentions.length ? mentions : [mt.chairId]))
  mt.revision++
  return { operation: op, activity }
}

const MEETING_LINES: [string, string][] = [
  ['我先說結論：照現在的拆法可行，風險在折扣計算的四捨五入。', 'My take: the split works; the risk is rounding in the discount.'],
  ['我同意，測試要補一個過期優惠碼的情境。', 'Agreed. We need a test for an expired code.'],
  ['介面上錯誤訊息要說清楚是過期還是不存在。', 'The error has to say whether the code expired or does not exist.'],
  ['好，這幾點我記下來了，還有要補充的嗎？', 'Good, I have these down. Anything else?'],
]

/** One who was called on speaks; the chair sums up once the meeting is ending; each a model call, counted. */
function meetingTick(w: World, task: Task) {
  const c = task.coordination!
  const s = meetingOf(w, task, c.activeMeetingId)
  if (!s) return
  const m = s.meeting
  const q = queueOf(w, s.id)
  if (m.state === 'closing') {
    if (w.now < q.at) return
    count(m, s)
    const summary = say2(w, '結論：照現在的拆法做，補過期優惠碼的測試，錯誤訊息分清楚過期和不存在。', 'Conclusion: keep the split, add a test for expired codes, and tell expired from unknown in the error.')
    const a = postActivity(w, task, { kind: 'meeting', from: 'agent', text: summary, meetingVersion: 2, meetingPart: 'summary', meetingId: s.id, subId: s.id, nodeId: s.nodeId, ...byWhom(w, m.chairId) })
    endMeeting(w, task, s, summary, a.id)
    return
  }
  if (m.state !== 'open') return
  const next = q.ids[0]
  m.speakerId = next
  if (!next || w.now < q.at) return
  q.ids.shift()
  count(m, s)
  const said = MEETING_LINES[m.callsTotal % MEETING_LINES.length]
  postActivity(w, task, { kind: 'meeting', from: 'agent', text: say2(w, ...said), meetingVersion: 2, meetingPart: 'speech', meetingId: s.id, subId: s.id, nodeId: s.nodeId, ...byWhom(w, next) })
  q.at = w.now + REPLY_TIME
  m.speakerId = q.ids[0]
  m.revision++
  if (m.callsInBatch >= MEETING_BATCH) {
    pauseMeeting(m, 'limit')
    taskEvent(w, task, 'meetingLimitReached', say2(w, '會議「{topic}」已用完這一輪的 {limit} 次模型呼叫，等你決定是否繼續', 'Meeting "{topic}" used this round\'s {limit} model calls; continue?'), { topic: m.topic, limit: String(MEETING_BATCH) }, { subId: s.id, nodeId: s.nodeId })
  }
}

function count(m: Meeting, s: SubTask) {
  if (m.callsInBatch < MEETING_BATCH) m.callsInBatch++
  m.callsTotal++
  s.costUsd += 0.01
  s.tokens += 1200
}

function endMeeting(w: World, task: Task, s: SubTask & { meeting: Meeting }, summary: string, activityId: string) {
  const m = s.meeting
  m.state = 'ended'
  m.summary = summary
  m.summaryActivityId = activityId
  m.speakerId = undefined
  m.pauseReason = undefined
  m.endedAt = w.now
  m.revision++
  task.coordination!.activeMeetingId = undefined
  delete w.mockMeetingQueue?.[s.id]
  s.status = 'complete'
  s.progress = 1
  s.endedAt = w.now
  delete s.executionState
  for (const op of task.coordination!.operations) if (op.subId === s.id && op.kind === 'meetingEnd' && op.status !== 'applied') settleOp(w, op, 'applied')
  taskEvent(w, task, 'meetingEnded', say2(w, '會議結束：{topic}', 'Meeting over: {topic}'), { topic: m.topic }, { subId: s.id, nodeId: s.nodeId })
}

export interface MeetingControl { requestId: string; action: 'continue' | 'end' | 'retrySummary'; revision: number }

/** The user goes on with a paused meeting for another batch, ends it, or asks again for the conclusion. */
export function controlMeeting(w: World, taskId: string, meetingId: string, b: MeetingControl): { operation: TaskOperation } {
  const task = ownerTask(w, taskId)
  const c = task.coordination
  const s = meetingOf(w, task, meetingId)
  if (!s) throw new TaskRefusal(say2(w, '找不到這場會議', 'Meeting not found'), 'not_found')
  const again = c.operations.find((o) => o.requestId === b.requestId)
  if (again) return { operation: again }
  const m = s.meeting
  const kind = b.action === 'continue' ? 'meetingContinue' : b.action === 'end' ? 'meetingEnd' : 'meetingRetrySummary'
  const stale = () => new TaskRefusal(say2(w, '會議已更新，請確認最新狀態再操作', 'The meeting changed; check where it is and try again'), 'conflict')
  if (m.state === 'ended' || m.state === 'cancelled') throw new TaskRefusal(say2(w, '這場會議已結束', 'This meeting is over'), 'conflict')
  if (b.revision > m.revision || (b.action !== 'end' && b.revision !== m.revision)) throw stale()
  const q = queueOf(w, s.id)
  if (b.action === 'continue') {
    if (m.state !== 'paused') throw new TaskRefusal(say2(w, '這場會議沒有暫停', 'This meeting is not paused'), 'conflict')
    if (m.closingRequested) throw new TaskRefusal(say2(w, '結論沒有寫成，請按重試', 'The conclusion was not written; retry it'), 'conflict')
    if (task.paused) throw new TaskRefusal(say2(w, '任務已暫停，要先繼續任務', 'The task is paused; continue the task first'), 'conflict')
    if (m.pauseReason === 'limit' || m.callsInBatch >= MEETING_BATCH) {
      m.batch++
      m.callsInBatch = 0
      taskEvent(w, task, 'meetingContinued', say2(w, '會議「{topic}」繼續第 {batch} 輪', 'Meeting "{topic}" goes on, round {batch}'), { topic: m.topic, batch: String(m.batch) }, { subId: s.id, nodeId: s.nodeId })
    }
    m.state = 'open'
    m.pauseReason = undefined
    m.error = undefined
    q.at = w.now + REPLY_TIME
  } else if (b.action === 'end') {
    if (m.state === 'closing') throw new TaskRefusal(say2(w, '會議正在結束', 'The meeting is ending'), 'conflict')
    if (m.state === 'summaryFailed' || m.closingRequested) throw new TaskRefusal(say2(w, '結論沒有寫成，請按重試', 'The conclusion was not written; retry it'), 'conflict')
    m.state = 'closing'
    m.closingRequested = true
    m.pauseReason = undefined
    m.speakerId = m.chairId
    q.ids = []
    q.at = w.now + REPLY_TIME
  } else {
    if (m.state !== 'summaryFailed' && !(m.state === 'paused' && m.closingRequested)) throw new TaskRefusal(say2(w, '這場會議現在不能重試結論', 'This meeting cannot retry its conclusion now'), 'conflict')
    m.state = 'closing'
    m.pauseReason = undefined
    m.error = undefined
    m.speakerId = m.chairId
    q.at = w.now + REPLY_TIME
  }
  m.revision++
  const op = operation(w, task, kind, b.requestId, { subId: s.id })
  settleOp(w, op, b.action === 'continue' ? 'applied' : 'processing')
  return { operation: op }
}

/** A page of one meeting's words and conclusion, oldest first, in the conversation's order. */
export function meetingActivityPage(w: World, taskId: string, meetingId: string, q: { before?: number; limit?: number; version?: string }) {
  const task = ownerTask(w, taskId)
  if (!w.subTasks[meetingId] || w.subTasks[meetingId].taskId !== task.id) throw new TaskRefusal(say2(w, '找不到這場會議', 'Meeting not found'), 'not_found')
  const list = (w.mockActivity?.[taskId] ?? []).filter((a) => a.kind === 'meeting' && a.meetingId === meetingId)
  const version = String(list.at(-1)?.seq ?? 0)
  if (q.version && q.version !== version) throw new TaskRefusal(say2(w, '對話已經更新', 'The conversation has changed'), 'conflict')
  const shown = q.before === undefined ? list : list.filter((a) => a.seq < q.before!)
  const items = shown.slice(-Math.min(100, Math.max(1, q.limit ?? 50)))
  return { version, total: list.length, items: clone(items), hasMore: items.length < shown.length }
}

/** Exposed for the seed, which writes an owner-run task partway through. */
export const ownerSeed = { dispatchStep, handBack, ownerSays, taskEvent, holdMeeting, endMeeting }
