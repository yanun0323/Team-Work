import { act, createRoot } from '@react-three/fiber'
import type { WebGLRenderer } from 'three'
import { afterEach, expect, it, vi } from 'vitest'
import { emptyWorld } from './backend'
import { useLive, useLiveText } from './live'
import { useNow, useSimLoop, useStore } from './store'
import { ago } from '../source'
import { editMemory } from './ops'
import { seedWorld } from './data/seed'

const mode = vi.hoisted(() => ({ MOCK: false }))
vi.mock('./mode', () => mode)
const initial = useStore.getState()
const roots: ReturnType<typeof createRoot>[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => { root.unmount() })
  useStore.setState(initial, true)
  mode.MOCK = false
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function mount(view: React.ReactNode) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const canvas = {} as HTMLCanvasElement
  const gl = { render: vi.fn(), setSize: vi.fn(), setPixelRatio: vi.fn(), domElement: canvas } as unknown as WebGLRenderer
  const root = createRoot(canvas)
  roots.push(root)
  await root.configure({ gl, frameloop: 'never', size: { width: 1, height: 1, top: 0, left: 0 } })
  await act(async () => { root.render(view) })
  return root
}

it('keeps an idle production world unchanged across 100 clock ticks', () => {
  vi.useFakeTimers()
  useStore.getState().receive({ type: 'snapshot', world: emptyWorld() })
  const world = useStore.getState().world
  const changed = vi.fn()
  const unsubscribe = useStore.subscribe((s, prev) => { if (s.world !== prev.world) changed() })
  try {
    for (let i = 0; i < 100; i++) {
      vi.advanceTimersByTime(100)
      useStore.getState().step(0.1)
    }
    expect(changed).not.toHaveBeenCalled()
    expect(useStore.getState().world).toBe(world)
  } finally { unsubscribe() }
})

it('does not rerender world subscribers on idle ticks, but still delivers patches, unread and streamed replies', async () => {
  vi.stubGlobal('window', globalThis)
  vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => { queueMicrotask(() => f(0)); return 1 })
  const worldRender = vi.fn()
  const liveRender = vi.fn()
  function History() {
    worldRender(useStore((s) => s.world))
    return null
  }
  function Reply() {
    liveRender(useLiveText('c'))
    return null
  }
  function View() {
    useSimLoop()
    return <><History /><Reply /></>
  }
  await mount(<View />)
  worldRender.mockClear()
  liveRender.mockClear()
  for (let i = 0; i < 10; i++) await act(async () => { useStore.getState().step(0.1) })
  expect(worldRender).not.toHaveBeenCalled()

  await act(async () => { useStore.getState().receive({ type: 'patch', upserts: [{ kind: 'chat', id: 'c', data: { id: 'c', unread: true, messages: [] } }] }) })
  expect(worldRender).toHaveBeenCalledTimes(1)
  expect(worldRender.mock.lastCall![0].chats.c.unread).toBe(true)
  worldRender.mockClear()
  await act(async () => { useStore.getState().receive({ type: 'delta', subId: 'c', text: '新回覆' }) })
  expect(liveRender).toHaveBeenLastCalledWith('新回覆')
  expect(worldRender).not.toHaveBeenCalled()
  await act(async () => { useStore.getState().receive({ type: 'patch', upserts: [{ kind: 'chat', id: 'c', data: { id: 'c', unread: false, messages: [{ from: 'agent', text: '新回覆', at: 0 }] } }] }) })
  expect(worldRender).toHaveBeenCalledTimes(1)
  expect(worldRender.mock.lastCall![0].chats.c.messages).toHaveLength(1)
  expect(worldRender.mock.lastCall![0].chats.c.unread).toBe(false)
  expect(liveRender).toHaveBeenLastCalledWith('')
})

// The backend's own order (usecase/owner_meeting.go): a turn starts with a patch naming its speaker, then each call
// at the model opens with deltaReset and streams deltas. The user's words in the meeting bump its revision and add a
// line to the task while the speaker goes on; an accepted answer clears the speaker in the patch that saves it, before
// the next turn names one again. Only those last signs say what was being written is done.
function meetingWorld() {
  vi.stubGlobal('window', globalThis)
  vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => { queueMicrotask(() => f(0)); return 1 })
  const world = seedWorld()
  const task = Object.values(world.tasks).find((t) => t.coordination?.activeMeetingId)!
  const id = task.coordination!.activeMeetingId!
  const meeting = world.subTasks[id].meeting!
  const bob = meeting.participants.find((p) => p.replicaId !== meeting.chairId)!.replicaId
  useStore.setState({ world, loaded: true })
  const receive = useStore.getState().receive
  const run = (change: (m: NonNullable<typeof meeting>) => void) => {
    const s = structuredClone(useStore.getState().world.subTasks[id])
    change(s.meeting!)
    s.meeting!.revision++
    receive({ type: 'patch', upserts: [{ kind: 'subTask', id, data: s }] })
  }
  const line = (withRun?: (m: NonNullable<typeof meeting>) => void) => {
    const t = structuredClone(useStore.getState().world.tasks[task.id])
    t.coordination!.history = { version: String(Math.random()), count: t.coordination!.history.count + 1 }
    const upserts: { kind: 'task' | 'subTask'; id: string; data: unknown }[] = [{ kind: 'task', id: task.id, data: t }]
    if (withRun) {
      const s = structuredClone(useStore.getState().world.subTasks[id])
      withRun(s.meeting!)
      s.meeting!.revision++
      upserts.push({ kind: 'subTask', id, data: s })
    }
    receive({ type: 'patch', upserts } as Parameters<typeof receive>[0])
  }
  const live = () => useLive.getState().texts[id]
  const say = async (text: string) => {
    receive({ type: 'delta', subId: id, text })
    await new Promise((r) => setTimeout(r, 0))
  }
  const reset = () => receive({ type: 'deltaReset', subId: id })
  run((m) => { m.state = 'open'; m.speakerId = meeting.chairId })
  reset()
  return { id, task, chair: meeting.chairId, bob, run, line, live, say, reset }
}

it('keeps what a meeting speaker is writing when the user speaks up in the meeting, and goes on after it', async () => {
  const m = meetingWorld()
  await m.say('回答前半段')
  expect(m.live()).toBe('回答前半段')
  // another step goes on meanwhile
  m.line()
  expect(m.live()).toBe('回答前半段')
  // the user writes in the meeting: a line, a new revision, the same speaker still speaking
  m.line(() => {})
  expect(m.live()).toBe('回答前半段')
  await m.say('回答後半段')
  expect(m.live()).toBe('回答前半段回答後半段')
})

it('keeps a speaker\'s words across a tool round until its call starts over', async () => {
  const m = meetingWorld()
  await m.say('先看檔案')
  // the next call at the model is counted (a new revision) and then starts over with deltaReset
  m.run((x) => { x.callsTotal++; x.callsInBatch++ })
  expect(m.live()).toBe('先看檔案')
  m.reset()
  expect(m.live()).toBeUndefined()
  await m.say('看完了')
  expect(m.live()).toBe('看完了')
})

it('lets a meeting speaker\'s words go once they are an answer, the same one goes on, or another speaks', async () => {
  const m = meetingWorld()
  await m.say('第一段')
  // the answer is saved: a line, and no one speaking until the next turn
  m.line((x) => { x.speakerId = undefined })
  expect(m.live()).toBeUndefined()

  // the same one speaks again
  m.run((x) => { x.speakerId = m.chair })
  m.reset()
  await m.say('同一人再說')
  expect(m.live()).toBe('同一人再說')
  m.line((x) => { x.speakerId = undefined })
  expect(m.live()).toBeUndefined()

  // the floor passes straight to another
  m.run((x) => { x.speakerId = m.chair })
  await m.say('主持人的話')
  m.run((x) => { x.speakerId = m.bob })
  expect(m.live()).toBeUndefined()

  // a try at the model starts over
  await m.say('重來前')
  m.reset()
  expect(m.live()).toBeUndefined()
})

it('lets a meeting speaker\'s words go when the meeting stops or ends under them', async () => {
  const m = meetingWorld()
  await m.say('說到一半')
  m.run((x) => { x.state = 'paused'; x.pauseReason = 'limit' })
  expect(m.live()).toBeUndefined()

  m.run((x) => { x.state = 'closing'; x.pauseReason = undefined; x.speakerId = m.chair })
  await m.say('結論寫到一半')
  m.line((x) => { x.state = 'ended'; x.speakerId = undefined; x.summary = '結論' })
  expect(m.live()).toBeUndefined()
})

it('clears what a meeting was saying when the meeting ends under it', async () => {
  vi.stubGlobal('window', globalThis)
  vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => { queueMicrotask(() => f(0)); return 1 })
  const world = seedWorld()
  const task = Object.values(world.tasks).find((t) => t.coordination?.activeMeetingId)!
  const id = task.coordination!.activeMeetingId!
  useStore.setState({ world, loaded: true })
  useStore.getState().receive({ type: 'delta', subId: id, text: '最後一句' })
  await new Promise((r) => setTimeout(r, 0))
  expect(useLive.getState().texts[id]).toBe('最後一句')
  const ended = structuredClone(task)
  ended.coordination!.activeMeetingId = undefined
  useStore.getState().receive({ type: 'patch', upserts: [{ kind: 'task', id: task.id, data: ended }] })
  expect(useLive.getState().texts[id]).toBeUndefined()
})

it('updates elapsed-time displays independently and cleans up their timer', async () => {
  vi.stubGlobal('window', globalThis)
  vi.useFakeTimers()
  vi.setSystemTime(1_800_000_000_000)
  const start = Date.now() / 1000 - 59
  const shown = vi.fn()
  function Clock() {
    shown(ago(useNow(), start))
    return null
  }
  const world = useStore.getState().world
  const root = await mount(<Clock />)
  expect(shown).toHaveBeenLastCalledWith('剛剛')
  await act(async () => { vi.advanceTimersByTime(1000) })
  expect(shown).toHaveBeenLastCalledWith('1 分鐘前')
  expect(useStore.getState().world).toBe(world)
  await act(async () => { root.render(<></>) })
  shown.mockClear()
  await act(async () => { vi.advanceTimersByTime(2000) })
  expect(shown).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it('does not start the simulation timer in production', async () => {
  vi.stubGlobal('window', globalThis)
  vi.useFakeTimers()
  function View() { useSimLoop(); return null }
  await mount(<View />)
  expect(vi.getTimerCount()).toBe(0)
})

it('still advances the simulator ten times a second and respects pause', async () => {
  mode.MOCK = true
  vi.stubGlobal('window', globalThis)
  vi.useFakeTimers()
  useStore.setState({ world: emptyWorld(), speed: 1 })
  const shown = vi.fn()
  function View() { useSimLoop(); shown(useNow()); return null }
  const root = await mount(<View />)
  const before = useStore.getState().world.now
  await act(async () => { vi.advanceTimersByTime(1000) })
  expect(useStore.getState().world.now - before).toBeCloseTo(1)
  expect(shown).toHaveBeenLastCalledWith(useStore.getState().world.now)
  useStore.setState({ speed: 0 })
  const paused = useStore.getState().world
  await act(async () => { vi.advanceTimersByTime(1000) })
  expect(useStore.getState().world).toBe(paused)
  await act(async () => { root.render(<></>) })
  expect(vi.getTimerCount()).toBe(0)
})

it('timestamps memory edits at save time rather than the last world snapshot', () => {
  vi.useFakeTimers()
  vi.setSystemTime(1_800_000_000_000)
  const fetch = vi.fn(async () => new Response('{}'))
  vi.stubGlobal('fetch', fetch)
  const world = seedWorld()
  const r = Object.values(world.replicas)[0]
  r.memory = [{ id: 'm', text: 'old', at: 1, source: 'user' }]
  editMemory(world, r.id, 'm', 'new')
  const options = fetch.mock.calls[0] as unknown as [string, RequestInit]
  expect(JSON.parse(String(options[1].body)).memory[0]).toEqual({ id: 'm', text: 'new', at: Date.now() / 1000, source: 'user' })
  expect(r.memory[0].text).toBe('old') // only the backend's patch changes the real world
  mode.MOCK = true
  editMemory(world, r.id, 'm', 'simulated')
  expect(r.memory[0].at).toBe(world.now)
})
