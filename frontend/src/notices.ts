// macOS notifications and the Dock badge for what waits on the user, sent through the Mac app, and opening what a
// clicked notification is about. Outside the app nothing listens, so nothing is sent.
import { useEffect } from 'react'
import { create } from 'zustand'
import { tr } from './core/i18n'
import { teamAlerts } from './core/model'
import { useStore } from './core/store'
import type { World } from './core/domain/types'
import { chatPreview } from './crew'
import { usePrefs, type Prefs } from './prefs'
import { subscribeChatSound, subscribeNoticeSound, type NoticeTarget } from './sound'

type Mac = { webkit?: { messageHandlers?: Record<string, { postMessage: (x: unknown) => void } | undefined> }; twOpen?: unknown }
const handler = (name: string) => (globalThis as Mac).webkit?.messageHandlers?.[name]

/** What the app shows as one notification; a newer one for the same task or chat replaces it. */
export interface SystemNotice {
  kind: 'task' | 'chat'
  id: string
  title: string
  subtitle: string
  body: string
  /** The app's own chime is silent in the background then, so macOS sounds instead. */
  sound: boolean
}

const BODY_CHARS = 200
const clip = (text: string) => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > BODY_CHARS ? `${flat.slice(0, BODY_CHARS - 1)}…` : flat
}

/** The notification for a target, or none once the task or chat is gone. */
export function noticeOf(w: World, target: NoticeTarget, prefs: Pick<Prefs, 'muteInBackground' | 'soundNotice' | 'effectsMuted' | 'effectsVolume'>): SystemNotice | null {
  const sound = prefs.muteInBackground && prefs.soundNotice && !prefs.effectsMuted && prefs.effectsVolume > 0
  const place = (teamId: string) => (teamId ? w.teams[teamId]?.name ?? '' : tr('機場'))
  if (target.kind === 'task') {
    const task = w.tasks[target.id]
    if (!task) return null
    return { kind: 'task', id: task.id, title: `#${task.number} ${task.title}`, subtitle: place(task.teamId), body: target.merge ? tr('可以合併') : tr('需要回覆'), sound }
  }
  const chat = w.chats[target.id]
  if (!chat) return null
  const last = chat.history?.lastAgent ?? chat.messages.findLast((m) => m.from === 'agent')
  const who = w.replicas[last?.by || chat.replicaId]?.name || chat.name
  return { kind: 'chat', id: chat.id, title: who, subtitle: [place(chat.teamId), chat.title || chatPreview(chat)].filter(Boolean).join(' · '), body: clip(last?.text ?? ''), sound }
}

/** Everything waiting on the user, as the buildings' tags count it: the airport's chats and every company's chats and tasks. */
export function waitingCount(w: World) {
  return ['', ...Object.keys(w.teams)].reduce((sum, id) => {
    const a = teamAlerts(w, id)
    return sum + a.waitingChats + a.waitingTasks
  }, 0)
}

/** Whether the user is looking elsewhere: the page is hidden or another window has the focus. */
export const away = (page: Pick<Document, 'hidden' | 'hasFocus'>) => page.hidden || !page.hasFocus()

/** A task or chat to open, as a clicked notification names it. */
export type OpenTarget = { kind: 'task' | 'chat'; id: string }

export const isOpenTarget = (x: unknown): x is OpenTarget => {
  const t = x as OpenTarget | null
  return !!t && (t.kind === 'task' || t.kind === 'chat') && typeof t.id === 'string' && t.id !== ''
}

/** The company a target is in, '' for the airport's chats, or null once it or its company is gone. */
export function placeOf(w: World, target: OpenTarget): string | null {
  const teamId = target.kind === 'task' ? w.tasks[target.id]?.teamId : w.chats[target.id]?.teamId
  if (teamId === undefined) return null
  return teamId === '' || w.teams[teamId] ? teamId : null
}

/**
 * `asked` is a click not yet acted on; the map takes it once the world has loaded and opens the company or airport.
 * `ready` is then for that company's file or the airport to open on the task or chat.
 */
export const useOpenRequest = create<{ asked: OpenTarget | null; ready: (OpenTarget & { teamId: string }) | null }>(() => ({ asked: null, ready: null }))

/** The company's file, or the airport with teamId '', opens the task or chat a clicked notification asked for. */
export function useOpenedFromNotice(teamId: string, leaving: boolean, show: (target: OpenTarget) => void) {
  const ready = useOpenRequest((s) => s.ready)
  useEffect(() => {
    if (!ready || ready.teamId !== teamId || leaving) return
    useOpenRequest.setState({ ready: null })
    show(ready)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, teamId, leaving])
}

/** Sends notifications while the user is away, keeps the Dock badge counting, and takes clicks on notifications. */
export const useSystemNotices = () => useEffect(startSystemNotices, [])

/** What useSystemNotices does; returns the undo. Outside the Mac app it does nothing. */
export function startSystemNotices() {
  if (!handler('notify')) return
  const send = (targets: NoticeTarget[]) => {
    const prefs = usePrefs.getState()
    if (!prefs.systemNotices || !away(document)) return
    const w = useStore.getState().world
    for (const target of targets) {
      const notice = noticeOf(w, target, prefs)
      if (notice) handler('notify')?.postMessage(notice)
    }
  }
  let shown = -1
  const badge = () => {
    const { loaded, world } = useStore.getState()
    const count = usePrefs.getState().systemNotices && loaded ? waitingCount(world) : 0
    if (count !== shown) handler('badge')?.postMessage(shown = count)
  }
  // The app sets window.twOpen and announces it with tw-open; one set before this page was up is read at once.
  const open = () => {
    const page = globalThis as Mac
    const target = page.twOpen
    delete page.twOpen
    if (isOpenTarget(target)) useOpenRequest.setState({ asked: { kind: target.kind, id: target.id } })
  }
  badge()
  open()
  const unsubscribe = [subscribeNoticeSound(send), subscribeChatSound(send), useStore.subscribe(badge), usePrefs.subscribe(badge)]
  window.addEventListener('tw-open', open)
  return () => {
    for (const stop of unsubscribe) stop()
    window.removeEventListener('tw-open', open)
  }
}
