import { afterEach, expect, it, vi } from 'vitest'
import { emptyWorld } from './core/backend'
import { useStore } from './core/store'
import type { Chat, Replica, Task, Team, World } from './core/domain/types'
import { DEFAULT_PREFS, usePrefs } from './prefs'
import { away, isOpenTarget, noticeOf, placeOf, startSystemNotices, useOpenRequest, waitingCount } from './notices'

const sample = (): World => {
  const w = emptyWorld()
  w.teams.t1 = { id: 't1', name: '北極星' } as Team
  w.replicas.r1 = { id: 'r1', name: 'Mira', teamId: 't1' } as Replica
  w.replicas.r2 = { id: 'r2', name: 'Kai', teamId: '' } as Replica
  w.tasks.k1 = { id: 'k1', teamId: 't1', number: 7, title: '修登入', stage: 'awaitMerge', paused: false } as Task
  w.tasks.k2 = { id: 'k2', teamId: 'gone', number: 8, title: '舊的', stage: 'running', paused: false } as Task
  w.chats.c1 = {
    id: 'c1', teamId: '', replicaId: 'r2', name: 'Kai', title: '', unread: true,
    messages: [{ at: 0, from: 'user', text: '幫我看看' }, { at: 1, from: 'agent', text: '  第一行\n\n第二行 ', by: 'r2' }, { at: 2, from: 'tool', text: 'ls' }],
  } as unknown as Chat
  w.chats.c2 = { id: 'c2', teamId: 't1', replicaId: 'r1', name: '已離職的人', messages: [{ at: 0, from: 'agent', text: 'x'.repeat(300), by: 'left' }] } as unknown as Chat
  return w
}

afterEach(() => {
  vi.unstubAllGlobals()
  usePrefs.setState(DEFAULT_PREFS)
  useOpenRequest.setState({ asked: null, ready: null })
})

it('words a task notice by what it waits for, and sounds only where the app itself stays quiet', () => {
  const w = sample()
  expect(noticeOf(w, { kind: 'task', id: 'k1', merge: true }, DEFAULT_PREFS)).toEqual({ kind: 'task', id: 'k1', title: '#7 修登入', subtitle: '北極星', body: '可以合併', sound: true })
  expect(noticeOf(w, { kind: 'task', id: 'k1', merge: false }, DEFAULT_PREFS)?.body).toBe('需要回覆')
  // The app's chime plays on in the background, or is switched off: macOS adds none.
  expect(noticeOf(w, { kind: 'task', id: 'k1', merge: true }, { ...DEFAULT_PREFS, muteInBackground: false })?.sound).toBe(false)
  expect(noticeOf(w, { kind: 'task', id: 'k1', merge: true }, { ...DEFAULT_PREFS, soundNotice: false })?.sound).toBe(false)
  expect(noticeOf(w, { kind: 'task', id: 'k1', merge: true }, { ...DEFAULT_PREFS, effectsMuted: true })?.sound).toBe(false)
  expect(noticeOf(w, { kind: 'task', id: 'gone', merge: true }, DEFAULT_PREFS)).toBeNull()
})

it('shows who replied in a chat and what they said last, flattened and clipped', () => {
  const w = sample()
  expect(noticeOf(w, { kind: 'chat', id: 'c1' }, DEFAULT_PREFS)).toMatchObject({ kind: 'chat', id: 'c1', title: 'Kai', subtitle: '機場 · 幫我看看', body: '第一行 第二行' })
  const left = noticeOf(w, { kind: 'chat', id: 'c2' }, DEFAULT_PREFS)!
  expect(left.title).toBe('已離職的人')
  expect(left.subtitle).toBe('北極星 · x'.padEnd('北極星 · '.length + 300, 'x'))
  expect(left.body).toHaveLength(200)
  expect(left.body.endsWith('…')).toBe(true)
})

it('counts what waits on the user as the buildings do, and finds where a target is', () => {
  const w = sample()
  // The airport's unread chat, and the company's task waiting to merge; the task of a closed company is not on the map.
  expect(waitingCount(w)).toBe(2)
  expect(placeOf(w, { kind: 'task', id: 'k1' })).toBe('t1')
  expect(placeOf(w, { kind: 'chat', id: 'c1' })).toBe('')
  expect(placeOf(w, { kind: 'task', id: 'k2' })).toBeNull()
  expect(placeOf(w, { kind: 'chat', id: 'nope' })).toBeNull()
  expect(isOpenTarget({ kind: 'chat', id: 'c1' })).toBe(true)
  expect(isOpenTarget({ kind: 'task', id: '' })).toBe(false)
  expect(isOpenTarget({ kind: 'team', id: 't1' })).toBe(false)
  expect(isOpenTarget(null)).toBe(false)
})

it('treats a hidden page or one without the focus as away', () => {
  expect(away({ hidden: false, hasFocus: () => true })).toBe(false)
  expect(away({ hidden: true, hasFocus: () => true })).toBe(true)
  expect(away({ hidden: false, hasFocus: () => false })).toBe(true)
})

it('notifies the app only while the user is away, counts on the Dock and takes clicks', () => {
  const initial = useStore.getState()
  const notify = vi.fn(), badge = vi.fn()
  let focused = true
  const page = new EventTarget()
  vi.stubGlobal('webkit', { messageHandlers: { notify: { postMessage: notify }, badge: { postMessage: badge } } })
  vi.stubGlobal('document', { hidden: false, hasFocus: () => focused })
  vi.stubGlobal('window', page)
  const w = sample()
  useStore.setState({ loaded: true, offline: false, toasts: [], world: w })
  const app = globalThis as { twOpen?: unknown }
  // A click that launched the app came before the page was up.
  app.twOpen = { kind: 'task', id: 'k1' }
  const stop = startSystemNotices()!
  try {
    expect(useOpenRequest.getState().asked).toEqual({ kind: 'task', id: 'k1' })
    expect(app.twOpen).toBeUndefined()
    useOpenRequest.setState({ asked: null })
    expect(badge).toHaveBeenLastCalledWith(2)
    const awaitMerge = (id: number) => useStore.setState({ toasts: [{ id, event: { kind: 'awaitMerge', taskId: 'k1' } }] })
    awaitMerge(1)
    expect(notify).not.toHaveBeenCalled()
    focused = false
    awaitMerge(2)
    expect(notify).toHaveBeenCalledOnce()
    expect(notify.mock.calls[0][0]).toMatchObject({ kind: 'task', id: 'k1', title: '#7 修登入' })
    usePrefs.setState({ systemNotices: false })
    awaitMerge(3)
    expect(notify).toHaveBeenCalledOnce()
    // Switched off, the Dock shows nothing.
    expect(badge).toHaveBeenLastCalledWith(0)
    usePrefs.setState({ systemNotices: true })
    expect(badge).toHaveBeenLastCalledWith(2)
    const calls = badge.mock.calls.length
    useStore.setState({ failure: 'irrelevant' })
    expect(badge).toHaveBeenCalledTimes(calls)
    app.twOpen = { kind: 'chat', id: 'c1', extra: 1 }
    page.dispatchEvent(new Event('tw-open'))
    expect(useOpenRequest.getState().asked).toEqual({ kind: 'chat', id: 'c1' })
    useOpenRequest.setState({ asked: null })
    app.twOpen = { kind: 'chat' }
    page.dispatchEvent(new Event('tw-open'))
    expect(useOpenRequest.getState().asked).toBeNull()
  } finally { stop(); useStore.setState(initial) }
})

it('does nothing outside the Mac app', () => {
  expect(startSystemNotices()).toBeUndefined()
})
