// Fake runtime: moves tasks through their workflow. Every function mutates the world in place
// (the store wraps calls in immer), so tests can use plain objects.

import { makeHandoff, makeScript, roleOf } from './content'
import { canReach, isFixed, feedsOnly, inEdges, nodeOf, outEdges, taskNodeOf } from './graph'
import { between, chance, hex, pick, uid } from './rng'
import { taskStatus } from './rollup'
import type {
  Attachment, Blueprint, GitSource, LogKind, MemorySource, ModelProvider, ProviderAuth, Replica, Review, Script, SubTask, Task, Team, Workflow, World,
} from './types'

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
  overrides?: Record<string, Partial<Script>>
  mergeConflict?: boolean
  /** Who works each step of this task, by node id. Steps left out keep the flow's own list. */
  staff?: Record<string, string[]>
  /** The task's owner, who works 整理需求 and 驗收 whatever `staff` says. */
  ownerId?: string
  images?: Attachment[]
}

export function createTask(w: World, input: NewTask): Task {
  const number = Object.values(w.tasks).filter((t) => t.teamId === input.teamId).length + 1
  const task: Task = {
    id: uid(w, 'task'),
    teamId: input.teamId,
    number,
    title: input.title,
    description: input.description,
    images: input.images ?? [],
    workflowId: input.workflowId,
    workflow: clone(w.workflows[input.workflowId]),
    createdAt: w.now,
    stage: 'running',
    paused: false,
    branch: `task/${number}`,
    budgetBonus: 0,
    costCarry: 0,
    mergeConflict: input.mergeConflict ?? false,
    overrides: input.overrides,
    ownerId: null,
  }
  for (const n of task.workflow.nodes) if (input.staff?.[n.id]) n.replicaIds = [...input.staff[n.id]]
  setOwner(task, input.ownerId ?? null)
  w.tasks[task.id] = task
  spawn(w, task, taskNodeOf(task.workflow).id, [], null, w.now)
  return task
}

/** What 整理需求 and 驗收 are told to do; no flow can change it. */
export const START_PROMPT = '讀懂任務，整理目標、範圍與驗收條件，交給下一個節點。'
export const END_PROMPT = '對照驗收條件檢查成果；符合就交給使用者，不符合就退回前一步重做。'

/**
 * Make `ownerId` the task's owner: they work its two fixed steps, 整理需求 and 驗收, which also get their
 * own instructions back. With no owner (a task made where none is picked), the flow's staff stays on them.
 */
export function setOwner(task: Task, ownerId: string | null) {
  task.ownerId = ownerId
  const wf = task.workflow
  for (const n of wf.nodes) {
    if (!isFixed(wf, n.id)) continue
    n.prompt = n.kind === 'task' ? START_PROMPT : END_PROMPT
    if (ownerId) {
      n.replicaIds = [ownerId]
      n.assignment = 'firstAvailable'
    }
  }
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
    progress: 0, duration: script.duration ?? 24, createdAt: w.now, attempts: 0, costUsd: 0,
    routedTo: [], routed: false, waiting, arrivedAt, log: [], script,
    ...(round ? { round } : {}),
  }
  w.subTasks[id] = sub
  if (waiting) log(sub, w.now, 'system', '等待其他上游完成', 'joinWaiting')
  else release(w, task, sub)
  return sub
}

/** Pick who works on a sub-task according to the node's assignment mode. */
function release(w: World, task: Task, sub: SubTask) {
  sub.waiting = false
  const node = nodeOf(task.workflow, sub.nodeId)!
  const ids = node.replicaIds.filter((r) => w.replicas[r])
  if (node.assignment === 'roundRobin' && ids.length) {
    const team = w.teams[task.teamId]
    const key = `${task.workflowId}:${node.id}`
    const i = team.cursors[key] ?? 0
    sub.replicaId = ids[i % ids.length]
    team.cursors[key] = i + 1
  } else if (node.assignment === 'everyone' && ids.length) {
    sub.replicaId = ids[0]
    if (ids.length > 1) {
      sub.group = sub.id
      for (const r of ids.slice(1)) {
        const mate: SubTask = {
          ...clone(sub), id: uid(w, 'sub'), replicaId: r,
          script: makeScript(w, roleOf(node), task, { ...task.overrides?.['*'], ...task.overrides?.[node.id] }),
        }
        mate.duration = mate.script.duration ?? 24
        w.subTasks[mate.id] = mate
      }
    }
  }
  log(sub, w.now, 'system', '已排入佇列', 'queued')
}

// ---------- tick ----------

export function tick(w: World, dt: number) {
  w.now += dt
  drift(w)
  const running = (t: Task) => t.stage === 'running' && !t.paused
  const subs = Object.values(w.subTasks).filter((s) => !s.cancelled && running(w.tasks[s.taskId]))

  for (const s of subs) if (s.status === 'progressing') advance(w, w.tasks[s.taskId], s, dt)
  for (const s of subs) if (!s.cancelled && s.status === 'complete' && !s.routed) route(w, w.tasks[s.taskId], s)
  for (const s of Object.values(w.subTasks)) if (s.waiting && !s.cancelled && running(w.tasks[s.taskId])) checkJoin(w, s)
  // a merge waits for its owner; it goes before new work so the owner is not handed the next step first
  for (const t of Object.values(w.tasks)) if (t.stage === 'merging') stepMerge(w, t)
  dispatch(w)

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

/** Start a merge once its owner is free, and finish it when its time is up. */
function stepMerge(w: World, task: Task) {
  const m = task.merge!
  const target = w.teams[task.teamId]?.targetBranch ?? 'main'
  if (m.startedAt === undefined) {
    if (m.replicaId && busyReplicas(w).has(m.replicaId)) return
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
  if (sub.progress >= 1) complete(w, task, sub)
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
 * Whether a finished run sends the work back instead of handing it on. Only the flow's last step (a review
 * that does not pass) and a step that was itself sent back may, never the first step, and a task at most
 * `MAX_SEND_BACKS` times; each send-back halves the odds of the next.
 */
function sendsBack(w: World, task: Task, sub: SubTask) {
  const wf = task.workflow
  const node = nodeOf(wf, sub.nodeId)
  if (!node || node.kind === 'task' || sub.sentBack || sub.skipped || !sub.upstreamIds.length) return false
  const last = outEdges(wf, node.id).length === 0
  if (!last && !sub.rework) return false
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
    const node = nodeOf(wf, u.nodeId)
    if (u.replicaId && w.replicas[u.replicaId] && node?.assignment !== 'everyone') redo.replicaId = u.replicaId
    // the whole group, when everyone on the step works it
    for (const r of redo.group ? subsOf(w, task.id).filter((x) => x.group === redo.group) : [redo]) {
      r.rework = { from: sub.id, reason }
      // hand on the way it did the first time, without asking again
      r.routedTo = [...u.routedTo]
      log(r, w.now, 'system', `${from} 退回重做：${reason}`, 'reworkFrom', { node: from, reason })
    }
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
  const busy = busyReplicas(w)
  const ready = Object.values(w.subTasks)
    .filter((s) => {
      const t = w.tasks[s.taskId]
      return s.status === 'todo' && !s.cancelled && !s.waiting && t.stage === 'running' && !t.paused &&
        w.now >= s.arrivedAt + TRAVEL && taskCost(w, t) < costLimit(w, t)
    })
    .sort((a, b) => a.createdAt - b.createdAt)
  for (const s of ready) {
    const node = nodeOf(w.tasks[s.taskId].workflow, s.nodeId)
    const id = s.replicaId ?? node?.replicaIds.find((r) => w.replicas[r] && !busy.has(r)) ?? null
    if (!id || busy.has(id) || !w.replicas[id]) continue
    s.replicaId = id
    s.status = 'progressing'
    busy.add(id)
    log(s, w.now, 'system', `${w.replicas[id].name} 開始工作`, 'start', { name: w.replicas[id].name })
    const task = w.tasks[s.taskId]
    // 整理需求, the first time: the owner makes the work tree every later step commits to
    if (s.startedAt === undefined && node?.kind === 'task' && !s.round) {
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
  if (!r) return
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
      sub.status = 'todo'
      remember(w, sub.replicaId, option
        ? `使用者對「${r.prompt}」選擇「${label}」${note ? `，理由：${note}` : ''}`
        : `使用者對「${r.prompt}」回覆：${note}`, 'review', task.id)
      break
    case 'pickRoute': {
      sub.status = 'complete'
      sub.routedTo = [optionId]
      if (sub.handoff) sub.handoff.agent.next = { nodeId: optionId, reason: note || '使用者指定' }
      const name = nodeOf(task.workflow, sub.nodeId)?.name
      remember(w, sub.replicaId, `${name}拿不定下游時，使用者選了「${label}」${note ? `，理由：${note}` : ''}`, 'review', task.id)
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

export function resumeTask(w: World, taskId: string) {
  const task = w.tasks[taskId]
  if (!task.paused) return
  task.paused = false
  task.pausedAt = undefined
  task.pausedStatus = undefined
}

export function cancelTask(w: World, taskId: string) {
  const task = w.tasks[taskId]
  if (!task.paused) return
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
  for (const s of subsOf(w, taskId)) delete w.subTasks[s.id]
  task.workflowId = workflowId
  task.workflow = clone(w.workflows[workflowId])
  setOwner(task, task.ownerId)
  task.paused = false
  task.pausedAt = undefined
  task.pausedStatus = undefined
  spawn(w, task, taskNodeOf(task.workflow).id, [], null, w.now)
}

/** Remove a task for good, with its sub-tasks and anything still waiting on it. */
export function deleteTask(w: World, taskId: string) {
  if (!w.tasks[taskId]) return
  for (const s of subsOf(w, taskId)) delete w.subTasks[s.id]
  delete w.tasks[taskId]
  w.events = w.events.filter((e) => !('taskId' in e) || e.taskId !== taskId)
}

/** The run of the flow's last step (驗收) the task ended on: the newest, the lead of a group. */
export function lastReview(w: World, task: Task): SubTask | undefined {
  return subsOf(w, task.id)
    .filter((s) => !s.cancelled && (!s.group || s.group === s.id) && s.status === 'complete' && !outEdges(task.workflow, s.nodeId).length)
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))[0]
}

/**
 * The user merges a task that waits for it: the owner (or, with none, whoever did 驗收) merges the work
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
 * The user sends a task that waits to be merged back, with `feedback`: the steps before 驗收 run again on
 * it, by the same people, and hand on to a new 驗收 as before.
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

/** Only the key's last four characters are kept, to tell keys apart. */
const authOf = (l: ProviderLogin): ProviderAuth =>
  l.kind === 'apiKey' ? { kind: 'apiKey', keyHint: l.apiKey.trim().slice(-4) } : { kind: 'subscription' }

/** Add a model provider, with the models it lists; names are trimmed and each model kept once. */
export function addProvider(w: World, input: Pick<ModelProvider, 'name' | 'kind' | 'baseUrl' | 'models'> & { login: ProviderLogin }): ModelProvider {
  const id = uid(w, 'mp')
  const auth = authOf(input.login)
  w.providers[id] = {
    id, name: input.name.trim(), kind: input.kind, auth,
    baseUrl: auth.kind === 'subscription' ? '' : input.baseUrl.trim(),
    models: [...new Set(input.models.map((m) => m.trim()).filter(Boolean))],
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

export function hire(
  w: World, teamId: string, blueprintId: string, name: string, look?: Replica['look'],
  mind: Partial<Pick<Replica, 'model' | 'effort'>> = {},
): Replica {
  const bp = w.blueprints[blueprintId]
  const id = uid(w, 'rep')
  const r: Replica = {
    id,
    teamId,
    blueprintId,
    name,
    // their own cut and clothes, from their id: the blueprint's style draws the blueprint's icon, not them
    look: look ?? { ...bp.look, skin: pick(w, SKINS), hair: pick(w, HAIRS), style: seedOfId(id) },
    model: mind.model ?? DEFAULT_MODEL,
    effort: mind.effort ?? 'medium',
    memory: [],
    hiredAt: w.now,
  }
  w.replicas[r.id] = r
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
  delete w.replicas[id]
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
 * version; a blueprint that updates itself tries to move to it at once. Repos whose upstream is gone get none.
 */
function drift(w: World) {
  if (w.now < w.nextDriftAt) return
  w.nextDriftAt = w.now + between(w, 90, 160)
  const all = Object.values(w.blueprints).flatMap((bp) => gitSources(bp).filter((s) => s.upstream).map((s) => ({ bp, s })))
  if (!all.length) return
  const { bp, s } = pick(w, all)
  s.latest = hex(w)
  s.latestRef = bump(s.latestRef)
  if (bp.autoUpdate) updateSource(w, s)
  w.events.push({ kind: 'blueprintUpdated', blueprintId: bp.id, commit: s.latest, auto: bp.autoUpdate })
}

/** What every flow starts as: sorting out what the task asks, then a review. `id` names each node and edge. */
export function flowEnds(id: (prefix: string) => string): Pick<Workflow, 'nodes' | 'edges'> {
  const start = id('n')
  const end = id('n')
  return {
    nodes: [
      {
        id: start, kind: 'task', name: '整理需求', prompt: START_PROMPT,
        replicaIds: [], assignment: 'firstAvailable', handoff: 'all', join: 'all', pos: { x: 0, y: 0 },
      },
      {
        id: end, kind: 'work', name: '驗收', prompt: END_PROMPT,
        replicaIds: [], assignment: 'firstAvailable', handoff: 'all', join: 'all', pos: { x: 0, y: 200 },
      },
    ],
    edges: [{ id: id('e'), from: start, to: end, condition: '' }],
  }
}

export function newWorkflow(w: World, teamId: string, name: string): Workflow {
  const wf: Workflow = { id: uid(w, 'wf'), teamId, name, ...flowEnds((p) => uid(w, p)) }
  w.workflows[wf.id] = wf
  return wf
}

/** A copy of a flow, named after it with the first free `-1`, `-2`…; it is not the default. */
export function duplicateWorkflow(w: World, wfId: string): Workflow | undefined {
  const from = w.workflows[wfId]
  if (!from) return
  const taken = new Set(Object.values(w.workflows).filter((x) => x.teamId === from.teamId).map((x) => x.name))
  let n = 1
  while (taken.has(`${from.name}-${n}`)) n++
  const wf: Workflow = { ...clone(from), id: uid(w, 'wf'), name: `${from.name}-${n}` }
  w.workflows[wf.id] = wf
  return wf
}

/**
 * Remove a flow. Tasks keep the copy they were started with, so they run on; a company's last flow stays,
 * and if the default goes, the company's first other flow becomes the default.
 */
export function deleteWorkflow(w: World, wfId: string) {
  const wf = w.workflows[wfId]
  if (!wf) return
  const others = Object.values(w.workflows).filter((x) => x.teamId === wf.teamId && x.id !== wfId)
  if (!others.length) return
  delete w.workflows[wfId]
  const team = w.teams[wf.teamId]
  if (team?.defaultWorkflowId === wfId) team.defaultWorkflowId = others[0].id
}

export function createTeam(
  w: World, input: { name: string; folder: string; targetBranch: string; branches: string[]; initializedGit: boolean },
): Team {
  const id = uid(w, 'team')
  const wf = newWorkflow(w, id, '預設流程')
  const team: Team = {
    id, ...input, defaultWorkflowId: wf.id, prompt: '', createdAt: w.now, cursors: {},
    settings: { timeoutMin: 30, costLimitUsd: 3, retries: 1 },
  }
  w.teams[id] = team
  return team
}

/**
 * Close a company: it goes with everyone who works there, its flows, and all its tasks and their sub-tasks.
 * Blueprints are shared and stay. The prototype has no real folders, so `removeFiles` deletes nothing here.
 */
export function deleteTeam(w: World, teamId: string, _opts: { removeFiles: boolean } = { removeFiles: false }) {
  if (!w.teams[teamId]) return
  const tasks = new Set(Object.values(w.tasks).filter((t) => t.teamId === teamId).map((t) => t.id))
  for (const s of Object.values(w.subTasks)) if (tasks.has(s.taskId)) delete w.subTasks[s.id]
  for (const id of tasks) delete w.tasks[id]
  for (const r of Object.values(w.replicas)) if (r.teamId === teamId) delete w.replicas[r.id]
  for (const wf of Object.values(w.workflows)) if (wf.teamId === teamId) delete w.workflows[wf.id]
  w.events = w.events.filter((e) => !('taskId' in e) || !tasks.has(e.taskId))
  delete w.teams[teamId]
}
