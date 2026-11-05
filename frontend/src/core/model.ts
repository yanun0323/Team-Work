// Read-only helpers shared by all three designs. Nothing here renders.

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { depths, inEdges, nodeOf, outEdges, wouldCreateCycle } from './domain/graph'
import { combine } from './domain/rollup'
import { busyReplicas, statusOf, subsOf, TRAVEL } from './domain/sim'
import type { LogLine, Replica, Status, SubTask, Task, World, Workflow, WorkflowNode } from './domain/types'
import { appLanguage, colon, trRecorded } from './i18n'
import { AIRPORT_BLUEPRINT, isPreset, presetRank } from './data/presets'
import { sourceOfId } from './domain/sources'
import { useStore } from './store'

export const useWorld = () => useStore((s) => s.world)
export const useTeamId = () => useStore((s) => s.teamId) as string

export const fmtCost = (usd: number) => `$${usd.toFixed(2)}`

/** A token count; a dash when none were counted. */
export const fmtTokens = (n: number) => (n > 0 ? n.toLocaleString('en-US') : '—')

/** Simulated seconds as m:ss. */
export const fmtClock = (sec: number) => {
  // the backend's clock is real time; the simulator's counts up from zero
  if (sec >= 1e9) return new Date(sec * 1000).toLocaleTimeString(appLanguage() === 'zh' ? 'zh-TW' : 'en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
  const s = Math.max(0, Math.floor(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** A stable hue per task number, used to tell tasks apart. */
export const taskHue = (n: number) => (n * 67 + 200) % 360

export function logText(l: LogLine): string {
  if (!l.key) return l.text
  if (l.kind === 'human') {
    const note = l.args?.note
    return note ? `${trRecorded(l.key)}${colon()}${note}` : trRecorded(l.key)
  }
  return trRecorded(`log.${l.key}`, l.args)
}

export const teamTasks = (w: World, teamId: string) =>
  Object.values(w.tasks).filter((x) => x.teamId === teamId).sort((a, b) => b.number - a.number)

export const teamReplicas = (w: World, teamId: string) =>
  Object.values(w.replicas).filter((r) => r.teamId === teamId).sort((a, b) => a.hiredAt - b.hiredAt || a.name.localeCompare(b.name))


/** What a Replica is doing right now: the first of it, and how much more there is. */
export function activity(w: World, r: Replica): { sub?: SubTask; task?: Task; merging?: Task; more: number } {
  const subs = Object.values(w.subTasks).filter((s) => s.replicaId === r.id && s.status === 'progressing' && !s.cancelled)
  const merges = Object.values(w.tasks).filter((x) => x.stage === 'merging' && x.merge?.replicaId === r.id && x.merge.startedAt !== undefined)
  const more = Math.max(subs.length + merges.length - 1, 0)
  if (subs.length) return { sub: subs[0], task: w.tasks[subs[0].taskId], more }
  return merges.length ? { merging: merges[0], more } : { more }
}

/** A sub-task of this Replica that is waiting for the user. */
export const raisedHand = (w: World, r: Replica) =>
  Object.values(w.subTasks).find((s) => s.replicaId === r.id && s.review && !s.cancelled && w.tasks[s.taskId]?.stage === 'running')

/** The Replica's current sub-task, or the last one it worked on. */
export function lastSub(w: World, r: Replica): SubTask | undefined {
  return activity(w, r).sub ??
    Object.values(w.subTasks)
      .filter((s) => s.replicaId === r.id && s.startedAt !== undefined)
      .sort((x, y) => (y.startedAt ?? 0) - (x.startedAt ?? 0))[0]
}

const flowNumber = (id: string) => Number(id.match(/\d+$/)?.[0] ?? 0)

/** Where a blueprint or flow is listed: the user's own, then those from sources, then the built-in ones. */
const originRank = (id: string) => (isPreset(id) ? 2 : sourceOfId(id) ? 1 : 0)

/**
 * The user's own in the order they were made, then those of each source in turn by name, then the built-in ones in
 * their set order.
 */
const ownFirst = <T extends { id: string; name: string }>(all: Record<string, T>) => Object.values(all).sort((a, b) =>
  originRank(a.id) - originRank(b.id) || presetRank(a.id) - presetRank(b.id)
  || sourceOfId(a.id).localeCompare(sourceOfId(b.id), undefined, { numeric: true })
  || (sourceOfId(a.id) ? a.name.localeCompare(b.name) : flowNumber(a.id) - flowNumber(b.id)))

/** Flows in the order they were made. Ids end in a running number; as text, wf-12 would come before wf-9. */
export const flowList = (w: World) => ownFirst(w.workflows)

/** Blueprints the same way: those anyone can be hired from, not an employee's own settings. */
export const blueprintList = (w: World) => ownFirst(w.blueprints).filter((bp) => !bp.owner)

/** What can be picked: all but the hidden ones, keeping `keep`, the one already chosen, even when hidden. */
export const unhidden = <T extends { id: string }>(list: T[], hidden: string[], keep?: string) =>
  list.filter((x) => x.id === keep || !hidden.includes(x.id))

/** The blueprints an employee can be hired from: all but the airport staff's. */
export const hireList = (w: World) => blueprintList(w).filter((bp) => bp.id !== AIRPORT_BLUEPRINT)

export type InboxItem = { task: Task; sub?: SubTask; kind: string; name: string }

/** Everything in a team that waits for the user, oldest first. */
export function inbox(w: World, teamId: string | null): InboxItem[] {
  const items: InboxItem[] = []
  for (const task of Object.values(w.tasks).sort((a, b) => a.number - b.number)) {
    if (teamId && task.teamId !== teamId) continue
    if (task.stage === 'awaitMerge') items.push({ task, kind: 'awaitMerge', name: '' })
    if (task.stage !== 'running') continue
    for (const sub of subsOf(w, task.id)) {
      if (sub.review && !sub.cancelled) {
        const name = (sub.replicaId && w.replicas[sub.replicaId]?.name) || nodeOf(task.workflow, sub.nodeId)?.name || ''
        items.push({ task, sub, kind: sub.review.kind, name })
      }
    }
  }
  return items
}

/** What waits for the user in a company, shown over its building. The airport's chats have no company: `teamId` is empty for them.
 * A chat counts while the chat list marks it: unread, or waiting on the user's answer even once read.
 * A chat still replying is not counted yet: it says unread once the reply ends. */
export function teamAlerts(w: World, teamId: string) {
  return {
    waitingChats: Object.values(w.chats).filter((c) => c.teamId === teamId && c.replyAt === undefined && (c.unread || c.question || c.change)).length,
    waitingTasks: teamTasks(w, teamId).filter((t) => t.stage !== 'cancelled' && statusOf(w, t) === 'review').length,
  }
}

/** What a company has under way, shown spinning on its name tag: chats being replied to, and tasks with a step
 * running or a merge started (once each, however many steps run). The airport's chats have an empty `teamId`. */
export function teamWork(w: World, teamId: string): { chats: number; tasks: number } {
  return {
    chats: Object.values(w.chats).filter((c) => c.teamId === teamId && c.replyAt !== undefined).length,
    tasks: teamTasks(w, teamId).filter((t) =>
      (t.stage === 'merging' && t.merge?.startedAt !== undefined) ||
      subsOf(w, t.id).some((s) => s.status === 'progressing' && !s.cancelled)).length,
  }
}

/** How many of a company's employees are at work right now: on a task, merging one, or writing a chat reply. Shown on its building. */
export function teamBusy(w: World, teamId: string): number {
  const busy = busyReplicas(w)
  for (const c of Object.values(w.chats)) if (c.replyAt !== undefined) busy.add(c.replicaId)
  return [...busy].filter((id) => w.replicas[id]?.teamId === teamId).length
}

/** The tab that has something for the user to deal with, `first` when both do. A chat already read can still be waiting on an answer. */
export function waitingTab(w: World, teamId: string, first: 'tasks' | 'chats' = 'tasks'): 'tasks' | 'chats' | undefined {
  const tasks = teamAlerts(w, teamId).waitingTasks > 0
  const chats = Object.values(w.chats).some((c) => c.teamId === teamId && (c.unread || c.question))
  if (tasks && chats) return first
  return tasks ? 'tasks' : chats ? 'chats' : undefined
}

export function counts(w: World, teamId: string) {
  const c: Record<Status, number> = { todo: 0, progressing: 0, review: 0, complete: 0 }
  for (const task of teamTasks(w, teamId)) if (task.stage !== 'cancelled') c[statusOf(w, task)] += 1
  return c
}

export type NodeState = Status | 'idle' | 'waiting' | 'cancelled'

/** How far a task has got at one node of its workflow. */
export function nodeState(subs: SubTask[], nodeId: string): NodeState {
  const mine = subs.filter((s) => s.nodeId === nodeId)
  const live = mine.filter((s) => !s.cancelled)
  if (live.length) return live.some((s) => s.waiting) ? 'waiting' : combine(live.map((s) => s.status))
  return mine.length ? 'cancelled' : 'idle'
}

/** True when work actually went along this connection. */
export const edgeTaken = (subs: SubTask[], from: string, to: string) =>
  subs.some((s) => s.nodeId === to && s.upstreamIds.some((u) => subs.find((x) => x.id === u)?.nodeId === from))

/** Sub-tasks still in progress or queued, the ones worth showing on a card. */
export const liveSubs = (w: World, task: Task) =>
  subsOf(w, task.id).filter((s) => !s.cancelled && !s.waiting && s.status !== 'complete')

/** A handoff on its way to a node. `from` is null for the Task Node, whose input comes from the intake. */
export interface Transit { sub: SubTask; from: string | null; to: string; t: number }

export function inTransit(w: World, task: Task): Transit[] {
  if (task.stage !== 'running') return []
  const out: Transit[] = []
  for (const s of subsOf(w, task.id)) {
    if (s.cancelled || s.waiting || s.status !== 'todo') continue
    const t = (w.now - s.arrivedAt) / TRAVEL
    if (t < 0 || t >= 1) continue
    if (s.group && s.group !== s.id) continue
    const up = w.subTasks[s.upstreamIds[s.upstreamIds.length - 1]]
    out.push({ sub: s, from: up?.nodeId ?? null, to: s.nodeId, t: task.paused ? Math.min(t, 0.5) : t })
  }
  return out
}

/** Nodes in layers by depth, keeping the left-to-right order the editor saved. */
export function layers(wf: Workflow): { at: Record<string, { layer: number; rank: number; size: number }>; count: number; widest: number } {
  const d = depths(wf)
  const groups: WorkflowNode[][] = []
  for (const n of wf.nodes) (groups[d[n.id] ?? 0] ??= []).push(n)
  const at: Record<string, { layer: number; rank: number; size: number }> = {}
  groups.forEach((g, layer) => {
    if (!g) return
    g.sort((a, b) => a.pos.x - b.pos.x)
    g.forEach((n, rank) => (at[n.id] = { layer, rank, size: g.length }))
  })
  return { at, count: groups.length, widest: Math.max(1, ...groups.map((g) => g?.length ?? 0)) }
}

// ---------- workflow edits (run inside act) ----------

export function addNext(w: World, wfId: string, parentId: string, name: string): string {
  const g = w.workflows[wfId]
  const parent = g.nodes.find((n) => n.id === parentId)
  if (!parent) return ''
  const siblings = outEdges(g, parentId).map((e) => nodeOf(g, e.to)).filter(Boolean) as WorkflowNode[]
  const id = `n${++w.seq}`
  g.nodes.push({
    id, kind: 'work', name, prompt: '', replicaIds: [], handoff: 'all', join: 'all',
    pos: { x: siblings.length ? Math.max(...siblings.map((k) => k.pos.x)) + 240 : parent.pos.x, y: parent.pos.y + 200 },
  })
  g.edges.push({ id: `e${++w.seq}`, from: parentId, to: id, condition: '' })
  return id
}

/** Nodes this node may still connect to without a loop or a duplicate. */
export function connectable(wf: Workflow, from: string) {
  return wf.nodes.filter((n) =>
    n.id !== from && !wf.edges.some((e) => e.from === from && e.to === n.id) && !wouldCreateCycle(wf, from, n.id))
}

export function connect(w: World, wfId: string, from: string, to: string) {
  const g = w.workflows[wfId]
  if (!connectable(g, from).some((n) => n.id === to)) return
  g.edges.push({ id: `e${++w.seq}`, from, to, condition: '' })
}

export function deleteNode(w: World, wfId: string, id: string) {
  const g = w.workflows[wfId]
  g.nodes = g.nodes.filter((y) => y.id !== id)
  g.edges = g.edges.filter((e) => e.from !== id && e.to !== id)
}

export const needsCondition = (wf: Workflow, from: string) =>
  nodeOf(wf, from)?.handoff === 'pickOne' && outEdges(wf, from).length > 1

export { inEdges, nodeOf, outEdges }

// ---------- DOM hooks ----------

/** Keeps a scrolled-to-bottom list pinned to the bottom as new lines arrive. pin() goes back to the bottom and
 * stays there, as when the user sends a message after scrolling up to read. */
export function useStickToBottom<E extends HTMLElement>(dep: unknown): [RefObject<E | null>, () => void] {
  const ref = useRef<E>(null)
  const pinned = useRef(true)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const on = () => (pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24)
    // something beside the list grew, such as the box to write in: the last line stays in view
    const size = new ResizeObserver(() => { if (pinned.current) el.scrollTop = el.scrollHeight })
    size.observe(el)
    el.addEventListener('scroll', on)
    return () => {
      size.disconnect()
      el.removeEventListener('scroll', on)
    }
  }, [])
  useEffect(() => {
    const el = ref.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [dep])
  const pin = useCallback(() => {
    pinned.current = true
    const down = () => { const el = ref.current; if (el && pinned.current) el.scrollTop = el.scrollHeight }
    down()
    // once what was sent is drawn, such as a message waiting its turn, which leaves dep as it was
    requestAnimationFrame(down)
  }, [])
  return [ref, pin]
}

/** Whether a scrolled list shows its last line, and a way back there. A list too short to scroll is at the bottom. */
export function useAtBottom(ref: RefObject<HTMLElement | null>): [boolean, () => void] {
  const [atBottom, setAtBottom] = useState(true)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const on = () => setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 24)
    const size = new ResizeObserver(on)
    size.observe(el)
    // new lines change the height without a scroll or a resize of the list itself
    const lines = new MutationObserver(on)
    lines.observe(el, { childList: true, subtree: true, characterData: true })
    el.addEventListener('scroll', on)
    return () => {
      size.disconnect()
      lines.disconnect()
      el.removeEventListener('scroll', on)
    }
  }, [ref])
  const toBottom = () => {
    const el = ref.current
    const calm = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    el?.scrollTo({ top: el.scrollHeight, behavior: calm ? 'auto' : 'smooth' })
  }
  return [atBottom, toBottom]
}

/** Whether a key went to the terminal, where it belongs to the shell and not to the screen around it. */
export const inTerminal = (e: KeyboardEvent) => !!(e.target as Element | null)?.closest?.('.fx-terminal')

export function useEscape(fn: () => void) {
  const ref = useRef(fn)
  ref.current = fn
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !inTerminal(e)) ref.current()
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [])
}

/** A task's log lines across its sub-tasks (or one step's), oldest first. */
export function taskLines(subs: SubTask[], nodeId = '') {
  return subs
    .filter((s) => !nodeId || s.nodeId === nodeId)
    .flatMap((s) => s.log.map((l, i) => ({ ...l, s, i })))
    .sort((a, b) => a.at - b.at || a.i - b.i)
}
