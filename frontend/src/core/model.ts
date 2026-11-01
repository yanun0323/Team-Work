// Read-only helpers shared by all three designs. Nothing here renders.

import { useEffect, useRef } from 'react'
import { depths, inEdges, nodeOf, outEdges, wouldCreateCycle } from './domain/graph'
import { combine } from './domain/rollup'
import { statusOf, subsOf, TRAVEL } from './domain/sim'
import type { LogLine, Replica, Status, SubTask, Task, World, Workflow, WorkflowNode } from './domain/types'
import { appLanguage, colon, trRecorded } from './i18n'
import { presetRank } from './data/presets'
import { useStore } from './store'

export const useWorld = () => useStore((s) => s.world)
export const useTeamId = () => useStore((s) => s.teamId) as string

export const fmtCost = (usd: number) => `$${usd.toFixed(2)}`

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


/** What a Replica is doing right now. */
export function activity(w: World, r: Replica): { sub?: SubTask; task?: Task; merging?: Task } {
  const sub = Object.values(w.subTasks).find((s) => s.replicaId === r.id && s.status === 'progressing' && !s.cancelled)
  if (sub) return { sub, task: w.tasks[sub.taskId] }
  const merging = Object.values(w.tasks).find((x) => x.stage === 'merging' && x.merge?.replicaId === r.id && x.merge.startedAt !== undefined)
  return merging ? { merging } : {}
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

/** The user's own in the order they were made, then the built-in ones in their set order. */
const ownFirst = <T extends { id: string }>(all: Record<string, T>) => Object.values(all).sort((a, b) =>
  presetRank(a.id) - presetRank(b.id) || flowNumber(a.id) - flowNumber(b.id))

/** Flows in the order they were made. Ids end in a running number; as text, wf-12 would come before wf-9. */
export const flowList = (w: World) => ownFirst(w.workflows)

/** Blueprints the same way. */
export const blueprintList = (w: World) => ownFirst(w.blueprints)

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
    id, kind: 'work', name, prompt: '', replicaIds: [], assignment: 'firstAvailable', handoff: 'all', join: 'all',
    pos: { x: siblings.length ? Math.max(...siblings.map((k) => k.pos.x)) + 240 : parent.pos.x, y: parent.pos.y + 200 },
  })
  g.edges.push({ id: `e${++w.seq}`, from: parentId, to: id, condition: '' })
  return id
}

/** Nodes this node may still connect to without a loop or a duplicate. */
export function connectable(wf: Workflow, from: string) {
  return wf.nodes.filter((n) =>
    n.id !== from && n.kind !== 'task' && !wf.edges.some((e) => e.from === from && e.to === n.id) && !wouldCreateCycle(wf, from, n.id))
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

/** Keeps a scrolled-to-bottom list pinned to the bottom as new lines arrive. */
export function useStickToBottom<E extends HTMLElement>(dep: unknown) {
  const ref = useRef<E>(null)
  const pinned = useRef(true)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const on = () => (pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24)
    el.addEventListener('scroll', on)
    return () => el.removeEventListener('scroll', on)
  }, [])
  useEffect(() => {
    const el = ref.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [dep])
  return ref
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
