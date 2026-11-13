import { act, createRoot } from '@react-three/fiber'
import { isValidElement, type ReactElement, type ReactNode } from 'react'
import type { WebGLRenderer } from 'three'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('./core/mode', () => ({ MOCK: false }))

import { Toggle } from './Controls'
import { emptyWorld } from './core/backend'
import { useStore } from './core/store'
import { SemanticSearchView, useSemanticSearch } from './SemanticSearch'
import { OFF, type SemanticStatus } from './semanticStatus'

const roots: ReturnType<typeof createRoot>[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => { root.unmount() })
  vi.useRealTimers()
  vi.unstubAllGlobals()
  useStore.setState({ world: emptyWorld() })
})

const status = (state: SemanticStatus['state'], p: Partial<SemanticStatus> = {}, progress: Partial<SemanticStatus['progress']> = {}): SemanticStatus =>
  ({ ...OFF, enabled: state !== 'disabled', state, ...p, progress: { ...OFF.progress, ...progress } })

type Call = { method: string; body: unknown; signal?: AbortSignal; answer: (status: number, body?: unknown) => void }

/** This computer's backend, answering each request only when the test says, and failing aborted ones as fetch does. */
function backend() {
  const calls: Call[] = []
  vi.stubGlobal('fetch', (url: string, init: RequestInit) => new Promise<Response>((resolve, reject) => {
    const signal = init.signal ?? undefined
    const abort = () => reject(new DOMException('aborted', 'AbortError'))
    if (signal?.aborted) return abort()
    signal?.addEventListener('abort', abort)
    expect(url).toMatch(/^\/api\/v1\/settings\/(semantic-search|preferences)$/)
    calls.push({
      method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body as string) : undefined, signal,
      answer: (code, body) => resolve(new Response(body === undefined ? null : JSON.stringify(body), { status: code })),
    })
  }))
  const reads = () => calls.filter((c) => c.method === 'GET')
  const saves = () => calls.filter((c) => c.method === 'PATCH')
  return { calls, reads, saves, lastRead: () => reads().at(-1)!, lastSave: () => saves().at(-1)! }
}

/** The native bridge the Mac app puts on the page; each call waits for the test's answer. */
function nativeBridge() {
  const posts: Array<{ resolve: (x: unknown) => void; reject: (x: unknown) => void }> = []
  const postMessage = vi.fn((x: null) => {
    expect(x).toBeNull()
    return new Promise((resolve, reject) => posts.push({ resolve, reject }))
  })
  vi.stubGlobal('webkit', { messageHandlers: { restart: { postMessage } } })
  return { postMessage, posts }
}

/** Every element in what the view draws, its function components left as elements. */
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement<Record<string, unknown>>(node)) return []
  return [node, ...elements(node.props.children as ReactNode)]
}

/** The section mounted as the settings page mounts it, with what it draws and the controls a user would use. */
async function mount() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.useFakeTimers()
  vi.stubGlobal('window', globalThis)
  const canvas = {} as HTMLCanvasElement
  const gl = { render: vi.fn(), setSize: vi.fn(), setPixelRatio: vi.fn(), domElement: canvas } as unknown as WebGLRenderer
  const root = createRoot(canvas)
  roots.push(root)
  await root.configure({ gl, frameloop: 'never', size: { width: 1, height: 1, top: 0, left: 0 } })
  let drawn: ReactNode = null
  let props!: ReturnType<typeof useSemanticSearch>
  function View() {
    props = useSemanticSearch()
    // a component without hooks of its own: called here, it gives the tree the page would show
    drawn = SemanticSearchView(props)
    return null
  }
  await act(async () => { root.render(<View />) })
  const all = () => elements(drawn)
  const text = () => all().flatMap((e) => [e.props.children, e.props.label]).filter((x) => typeof x === 'string').join('\n')
  const toggle = () => all().find((e) => e.type === Toggle)
  const button = (name: string) => all().find((e) => e.type === 'button' && e.props.children === name)
  const alerts = () => {
    const alert = all().find((e) => e.props.role === 'alert')!
    return elements(alert.props.children as ReactNode).map((e) => e.props.children)
  }
  const step = (f: () => unknown) => act(async () => { f() })
  return {
    props: () => props, drawn: () => drawn, text, toggle, button, alerts, step,
    unmount: () => act(async () => { root.unmount(); roots.splice(roots.indexOf(root), 1) }),
    wait: (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) }),
  }
}

it('reads on opening, then every second while the model moves, and seldom once it is ready', async () => {
  const b = backend()
  const s = await mount()
  expect(b.reads()).toHaveLength(1)
  expect(s.drawn()).toBeNull()

  await s.step(() => b.lastRead().answer(200, status('downloading', {}, { downloadedBytes: 120_000_000, totalBytes: 632_000_000 })))
  expect(s.text()).toContain('下載模型中 120 / 632 MB')
  await s.wait(999)
  expect(b.reads()).toHaveLength(1)
  await s.wait(1)
  expect(b.reads()).toHaveLength(2)

  await s.step(() => b.lastRead().answer(200, status('compiling')))
  expect(s.text()).toContain('編譯模型中')
  await s.wait(1000)
  await s.step(() => b.lastRead().answer(200, status('indexing', {}, { completedFiles: 3, pendingFiles: 7 })))
  expect(s.text()).toContain('建立索引中 3 / 10 個檔案')
  await s.wait(1000)
  await s.step(() => b.lastRead().answer(200, status('ready')))
  expect(s.text()).toContain('可以使用')
  expect(b.reads()).toHaveLength(4)

  await s.wait(9999)
  expect(b.reads()).toHaveLength(4)
  await s.wait(1)
  expect(b.reads()).toHaveLength(5)
})

it('says why the status could not be read, offers a retry, and keeps trying until it can', async () => {
  const b = backend()
  const s = await mount()
  await s.step(() => b.lastRead().answer(500, { error: { code: 'internal', message: '讀不到狀態' } }))
  expect(s.alerts()).toEqual(['讀不到狀態'])
  expect(s.button('重試')).toBeDefined()
  expect(s.toggle()).toBeUndefined()

  // pressing retry reads at once, and the timer it replaces does not read again on top
  await s.wait(2000)
  await s.step(() => (s.button('重試')!.props.onClick as () => void)())
  expect(b.reads()).toHaveLength(2)
  await s.wait(3000)
  expect(b.reads()).toHaveLength(2)
  await s.step(() => b.lastRead().answer(500, { error: { code: 'internal', message: '還是讀不到' } }))
  expect(s.alerts()).toEqual(['還是讀不到'])
  await s.wait(4999)
  expect(b.reads()).toHaveLength(2)
  await s.wait(1)
  expect(b.reads()).toHaveLength(3)

  await s.step(() => b.lastRead().answer(200, OFF))
  expect(s.alerts()).toEqual([])
  expect(s.toggle()?.props.checked).toBe(false)
  expect(s.button('重試')).toBeUndefined()
})

it('stops reading on leaving: the request under way is cancelled and no timer reads again', async () => {
  const b = backend()
  const s = await mount()
  const first = b.lastRead()
  await s.unmount()
  expect(first.signal?.aborted).toBe(true)
  await s.wait(60_000)
  expect(b.reads()).toHaveLength(1)

  // and leaving while waiting for the next look
  const again = await mount()
  await again.step(() => b.lastRead().answer(200, status('downloading')))
  expect(b.reads()).toHaveLength(2)
  await again.unmount()
  await again.wait(60_000)
  expect(b.reads()).toHaveLength(2)
})

it('does not show a status that arrives after a newer read began', async () => {
  const b = backend()
  const s = await mount()
  const stale = b.lastRead()
  await s.step(() => s.props().onRetry())
  expect(stale.signal?.aborted).toBe(true)
  await s.step(() => b.lastRead().answer(200, OFF))
  // the answer to the cancelled read cannot land, and nothing reads twice from it
  await s.step(() => stale.answer(200, status('error', {}, {})))
  expect(s.text()).not.toContain('詳情見')
  await s.wait(9999)
  expect(b.reads()).toHaveLength(2)
})

it('saves the switch, holding it still meanwhile, then reads where it stands', async () => {
  const b = backend()
  const s = await mount()
  await s.step(() => b.lastRead().answer(200, OFF))

  await s.step(() => (s.toggle()!.props.onChange as (on: boolean) => void)(true))
  expect(b.lastSave().body).toEqual({ semanticSearch: true })
  expect(s.toggle()?.props.disabled).toBe(true)
  // a second change while saving sends nothing
  await s.step(() => s.props().onToggle(false))
  expect(b.saves()).toHaveLength(1)

  await s.step(() => b.lastSave().answer(204))
  expect(s.toggle()?.props.disabled).toBe(false)
  expect(b.reads()).toHaveLength(2)
  await s.step(() => b.lastRead().answer(200, status('restart_required', { requiresRestart: true })))
  expect(s.toggle()?.props.checked).toBe(true)
  expect(s.text()).toContain('重新啟動 Team Work 後生效')
  expect(s.alerts()).toEqual([])
})

it('says why saving failed, leaves the switch as the backend has it, and lets it be tried again', async () => {
  const b = backend()
  const s = await mount()
  await s.step(() => b.lastRead().answer(200, OFF))

  await s.step(() => s.props().onToggle(true))
  await s.step(() => b.lastSave().answer(500, { error: { code: 'internal', message: '設定存不進去' } }))
  expect(s.alerts()).toEqual(['設定存不進去'])
  expect(s.toggle()?.props.disabled).toBe(false)
  expect(b.reads()).toHaveLength(2)
  await s.step(() => b.lastRead().answer(200, OFF))
  expect(s.toggle()?.props.checked).toBe(false)

  // trying again clears the old reason
  await s.step(() => s.props().onToggle(true))
  expect(s.alerts()).toEqual([])
  await s.step(() => b.lastSave().answer(204))
  expect(b.saves().map((x) => x.body)).toEqual([{ semanticSearch: true }, { semanticSearch: true }])
})

it('restarts through the Mac app only on the second press, and leaving the button takes the question back', async () => {
  const b = backend()
  const n = nativeBridge()
  const s = await mount()
  await s.step(() => b.lastRead().answer(200, status('restart_required', { requiresRestart: true })))
  expect(s.text()).toContain('重新啟動後生效')

  const press = (name: string) => s.step(() => (s.button(name)!.props.onClick as () => void)())
  await press('重新啟動')
  expect(n.postMessage).not.toHaveBeenCalled()
  expect(s.button('確定重新啟動')).toBeDefined()
  // tabbing away (blur) asks again from the start
  await s.step(() => (s.button('確定重新啟動')!.props.onBlur as () => void)())
  expect(s.button('重新啟動')).toBeDefined()

  await press('重新啟動')
  await press('確定重新啟動')
  expect(n.postMessage).toHaveBeenCalledTimes(1)
  const going = s.button('重新啟動中…')!
  expect(going.props.disabled).toBe(true)
  // neither another press nor leaving the button undoes a restart under way
  await s.step(() => s.props().onRestart())
  await s.step(() => (going.props.onBlur as () => void)())
  expect(n.postMessage).toHaveBeenCalledTimes(1)
  expect(s.button('重新啟動中…')).toBeDefined()

  // the app took it: the button stays put until the app quits
  await s.step(() => n.posts[0].resolve({ accepted: true }))
  expect(s.button('重新啟動中…')).toBeDefined()
  expect(s.alerts()).toEqual([])
})

it('says why the Mac app would not restart, and lets it be asked again', async () => {
  const b = backend()
  const n = nativeBridge()
  const s = await mount()
  await s.step(() => b.lastRead().answer(200, status('restart_required', { requiresRestart: true })))
  const confirm = async () => {
    await s.step(() => s.props().onRestart())
    await s.step(() => s.props().onRestart())
  }

  await confirm()
  await s.step(() => n.posts.at(-1)!.reject('無法啟動新的 App'))
  expect(s.alerts()).toEqual(['無法啟動新的 App'])
  expect(s.button('重新啟動')).toBeDefined()

  // a refusal without a reason, or no word at all, still tells the user what to do
  await confirm()
  expect(s.alerts()).toEqual([])
  await s.step(() => n.posts.at(-1)!.resolve({ accepted: false }))
  expect(s.alerts()).toEqual(['沒辦法重新啟動，請自行重新啟動 Team Work'])
  await confirm()
  await s.step(() => n.posts.at(-1)!.resolve(undefined))
  expect(s.alerts()).toEqual(['沒辦法重新啟動，請自行重新啟動 Team Work'])
  expect(n.postMessage).toHaveBeenCalledTimes(3)

  // saving the switch again starts the question over
  await confirm()
  await s.step(() => n.posts.at(-1)!.reject(''))
  await s.step(() => s.props().onToggle(true))
  await s.step(() => b.lastSave().answer(204))
  expect(s.alerts()).toEqual([])
})

it('warns before stopping work under way', async () => {
  const b = backend()
  nativeBridge()
  const s = await mount()
  await s.step(() => b.lastRead().answer(200, status('restart_required', { requiresRestart: true })))
  await s.step(() => s.props().onRestart())
  expect(s.button('確定重新啟動')).toBeDefined()
  const world = emptyWorld()
  world.chats.c = { id: 'c', replyAt: 1 } as (typeof world.chats)[string]
  await s.step(() => useStore.setState({ world }))
  expect(s.button('工作會中斷，確定重新啟動')).toBeDefined()
})

it('has no restart button in a browser, only the line saying to restart', async () => {
  const b = backend()
  const s = await mount()
  await s.step(() => b.lastRead().answer(200, status('restart_required', { requiresRestart: true })))
  expect(s.props().bridge).toBe(false)
  expect(s.text()).toContain('重新啟動 Team Work 後生效')
  expect(s.button('重新啟動')).toBeUndefined()
})

it('shows the reason an error gives, and where the details are', async () => {
  const b = backend()
  const s = await mount()
  await s.step(() => b.lastRead().answer(200, status('error', { error: { code: 'download', message: '模型下載失敗', stage: 'download', log: 'backend.log' } })))
  expect(s.alerts()).toEqual(['模型下載失敗，詳情見 backend.log'])
  // an error does not move: looked at again now and then
  await s.wait(10_000)
  expect(b.reads()).toHaveLength(2)
})

it('draws nothing on a computer that cannot run it, and the switch is never there', async () => {
  const b = backend()
  const s = await mount()
  await s.step(() => b.lastRead().answer(200, status('unsupported', { supported: false, enabled: false })))
  expect(s.drawn()).toBeNull()
})
