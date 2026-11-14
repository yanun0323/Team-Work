// Read-only helpers shared by all three designs. Nothing here renders.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { depths, inEdges, nodeOf, outEdges, wouldCreateCycle } from './domain/graph'
import { combine } from './domain/rollup'
import { busyReplicas, statusOf, subsOf, TRAVEL } from './domain/sim'
export { heirsOf, lastOfTeam, leavesAlone, pendingTeams } from './domain/sim'
import { STAFFING_ID, type LogLine, type Replica, type Status, type SubTask, type Task, type World, type Workflow, type WorkflowNode } from './domain/types'
import { appLanguage, colon, LOCALE_TAGS, trRecorded } from './i18n'
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
  if (sec >= 1e9) return new Date(sec * 1000).toLocaleTimeString(LOCALE_TAGS[appLanguage()], { hour: '2-digit', minute: '2-digit', hour12: false })
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

/** A board lane's tasks: 完成 shows the latest first, the lanes still in hand the oldest first. */
export const laneTasks = (w: World, teamId: string, status: Status) => {
  const list = teamTasks(w, teamId).filter((x) => x.stage !== 'cancelled' && statusOf(w, x) === status)
  return status === 'complete' ? list : list.sort((a, b) => a.createdAt - b.createdAt || a.number - b.number)
}

export const teamReplicas = (w: World, teamId: string) =>
  Object.values(w.replicas).filter((r) => r.teamId === teamId).sort((a, b) => a.hiredAt - b.hiredAt || a.name.localeCompare(b.name))

/** Who can be picked to work in a company: its own employees, then the staffing agency's. */
export const crewOf = (w: World, teamId: string) =>
  teamId && teamId !== STAFFING_ID ? [...teamReplicas(w, teamId), ...teamReplicas(w, STAFFING_ID)] : teamReplicas(w, teamId)



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

/** Where a source's file asks to be listed: its `order`, or after all that give one. */
const orderOf = (x: { order?: number }) => x.order ?? Infinity

/**
 * The user's own in the order they were made, then those of each source in turn by the `order` their files give and
 * then by name, then the built-in ones in their set order.
 */
const ownFirst = <T extends { id: string; name: string; order?: number }>(all: Record<string, T>) => Object.values(all).sort((a, b) =>
  originRank(a.id) - originRank(b.id) || presetRank(a.id) - presetRank(b.id)
  || sourceOfId(a.id).localeCompare(sourceOfId(b.id), undefined, { numeric: true })
  || (sourceOfId(a.id)
    ? (orderOf(a) === orderOf(b) ? 0 : orderOf(a) < orderOf(b) ? -1 : 1) || a.name.localeCompare(b.name)
    : flowNumber(a.id) - flowNumber(b.id)))

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

/** Keys that scroll a list up. */
const UP_KEYS = new Set(['ArrowUp', 'PageUp', 'Home'])

/**
 * The one place a chat-like list is scrolled. Pinned to the bottom, it follows what arrives there. Let go, the rows
 * the reader sees stay where they are on screen whatever changes around them: rows coming or going above, a reply
 * ending below, a picture loading. The reader scrolling up, by however little, lets go at once; scrolling back down to
 * the bottom takes hold again. pin() goes back to the bottom and stays there, as when the user sends a message after
 * scrolling up to read; pin(true) glides there.
 *
 * The browser's own scroll anchoring is off: WebKit and Chromium differ in it, and it moved the list under this one.
 * Rows marked data-scroll-skip, such as a "loading" line or the button for earlier messages, are never held in place.
 */
export function useStickToBottom<E extends HTMLElement>(dep: unknown): [RefObject<E | null>, (smooth?: boolean) => void] {
  const ref = useRef<E>(null)
  const pinned = useRef(true)
  const place = useRef(() => {})
  const bottom = useRef((_smooth: boolean) => {})
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.overflowAnchor = 'none'
    // blank space under the last row that holds the reader where they were when rows below them went away, as a
    // list scrolled past its end is pulled back by the browser; it is [data-scroll-room]::after in fusion.css
    let room = 0
    el.dataset.scrollRoom = ''
    el.style.setProperty('--scroll-gap', `${parseFloat(getComputedStyle(el).rowGap) || 0}px`)
    // the scrollTop last set here, so its scroll event is not read as the reader's
    let mine = -1
    let last = el.scrollTop
    // the rows on screen, then the one just above them, and how far each is from the list's top: the first one still
    // there is held in place; with none left, as when the rows on screen were all replaced, scrollTop stays as it was
    let seen: { row: Element; at: number }[] = []
    let seenTop = el.scrollTop
    // dragging the scroll bar, which is the list's own
    let held = false
    let finger = 0
    const setRoom = (n: number) => {
      n = Math.max(0, Math.ceil(n))
      if (n === room) return
      room = n
      el.style.setProperty('--scroll-room', `${n}px`)
    }
    const write = (top: number) => {
      el.scrollTop = top
      mine = last = el.scrollTop
    }
    const look = () => {
      const top = el.getBoundingClientRect().top
      seen = []
      seenTop = el.scrollTop
      let above: { row: Element; at: number } | undefined
      for (const row of el.children) {
        if (row instanceof HTMLElement && row.dataset.scrollSkip !== undefined) continue
        const r = row.getBoundingClientRect()
        if (r.top >= top + el.clientHeight) break
        if (r.bottom > top) seen.push({ row, at: r.top - top })
        else if (r.height) above = { row, at: r.top - top }
      }
      if (above) seen.push(above)
    }
    // what the reader's place needs below the rows, for scrollTop top
    const need = (top: number) => top + el.clientHeight - (el.scrollHeight - room)
    const keep = () => {
      if (pinned.current) {
        setRoom(0)
        write(el.scrollHeight)
      } else {
        const kept = seen.find((s) => s.row.parentElement === el)
        const want = kept ? el.scrollTop + kept.row.getBoundingClientRect().top - el.getBoundingClientRect().top - kept.at : seenTop
        setRoom(need(want))
        if (Math.abs(el.scrollTop - want) >= 0.5) write(want)
        // what the browser would not scroll to, short of room by its rounding, is made room for
        if (want - el.scrollTop >= 0.5) { setRoom(room + want - el.scrollTop); write(want) }
      }
      look()
    }
    place.current = keep
    bottom.current = (smooth) => {
      pinned.current = true
      setRoom(0)
      if (smooth) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
      else write(el.scrollHeight)
    }
    // a list too short to scroll has nowhere up to go, so a scroll up there lets nothing go
    const up = () => { if (el.scrollTop > 0) pinned.current = false }
    const on = () => {
      const top = el.scrollTop
      if (Math.abs(top - mine) < 1) return
      mine = -1
      // near the end of the rows, not of the blank space under them
      const near = el.scrollHeight - room - top - el.clientHeight < 24
      const rose = top < last
      last = top
      // near the bottom only a move down takes hold, so a nudge up stays let go; away from it only a move up lets
      // go, so a smooth scroll on its way down keeps hold
      if (near && !rose) pinned.current = true
      else if (rose && (!near || held)) pinned.current = false
      setRoom(pinned.current ? 0 : need(top))
      look()
    }
    const wheel = (e: WheelEvent) => { if (e.deltaY < 0 && !e.ctrlKey) up() }
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t?.isContentEditable || t?.tagName === 'INPUT' || t?.tagName === 'TEXTAREA') return
      if (UP_KEYS.has(e.key) || (e.key === ' ' && e.shiftKey)) up()
    }
    const touch = (e: TouchEvent) => { finger = e.touches[0]?.clientY ?? 0 }
    const swipe = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY ?? finger
      // the finger going down drags the lines down, showing those above
      if (y > finger) up()
      finger = y
    }
    const press = (e: PointerEvent) => { if (e.target === el) held = true }
    const release = () => { held = false }
    // the list's rows and the list itself changing size, as a picture loading or the box to write in growing
    const watched = new Set<Element>()
    const sizes = new ResizeObserver(keep)
    sizes.observe(el, { box: 'border-box' })
    const watch = () => {
      for (const row of watched) if (row.parentElement !== el) { sizes.unobserve(row); watched.delete(row) }
      for (const row of el.children) if (!watched.has(row)) { sizes.observe(row, { box: 'border-box' }); watched.add(row) }
    }
    // rows coming, going or changing, before the browser draws them
    const rows = new MutationObserver(() => { watch(); keep() })
    rows.observe(el, { childList: true, subtree: true, characterData: true })
    watch()
    keep()
    el.addEventListener('scroll', on)
    el.addEventListener('wheel', wheel, { passive: true })
    el.addEventListener('keydown', key)
    el.addEventListener('touchstart', touch, { passive: true })
    el.addEventListener('touchmove', swipe, { passive: true })
    el.addEventListener('pointerdown', press)
    addEventListener('pointerup', release)
    addEventListener('pointercancel', release)
    return () => {
      sizes.disconnect()
      rows.disconnect()
      delete el.dataset.scrollRoom
      el.style.removeProperty('--scroll-room')
      el.style.removeProperty('--scroll-gap')
      place.current = () => {}
      bottom.current = () => {}
      el.removeEventListener('scroll', on)
      el.removeEventListener('wheel', wheel)
      el.removeEventListener('keydown', key)
      el.removeEventListener('touchstart', touch)
      el.removeEventListener('touchmove', swipe)
      el.removeEventListener('pointerdown', press)
      removeEventListener('pointerup', release)
      removeEventListener('pointercancel', release)
    }
  }, [])
  // what React drew this time, before it is shown; the observers above catch the rest
  useLayoutEffect(() => place.current(), [dep])
  const pin = useCallback((smooth = false) => {
    const calm = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    bottom.current(smooth && !calm)
  }, [])
  return [ref, pin]
}

/** Whether a scrolled list shows its last line. A list too short to scroll is at the bottom. */
export function useAtBottom(ref: RefObject<HTMLElement | null>): boolean {
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
  return atBottom
}

/** Whether a key went to the terminal, where it belongs to the shell and not to the screen around it. */
export const inTerminal = (e: KeyboardEvent) => !!(e.target as Element | null)?.closest?.('.fx-terminal')

/**
 * Whether Esc belongs to what has focus rather than to the sheet or the drawer around it: an open list, a floating
 * menu such as the hand-off one, or a box holding a draft, which Esc leaves rather than closing the sheet under it.
 */
export const keepsEscape = (target: EventTarget | null) =>
  !!(target as Element | null)?.closest?.('[aria-expanded="true"][aria-haspopup="listbox"], [popover], [data-esc="box"]')

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
