import { afterEach, describe, expect, it, vi } from 'vitest'

// the real requests, not the simulator
vi.mock('./mode', () => ({ MOCK: false }))

const { controlMeeting, controlTask, readMeetingActivity, readTaskActivity, readTaskActivityItem, readTaskOperation, sayToOwner, updateTask } = await import('./ops')
const { ApiError, emptyWorld } = await import('./backend')

afterEach(() => vi.unstubAllGlobals())

const answer = (body: unknown, status = 202) => vi.fn(async () => new Response(JSON.stringify(body), { status }))
const sent = (f: ReturnType<typeof answer>, i = 0) => {
  const [path, init] = f.mock.calls[i] as unknown as [string, RequestInit]
  return { path, method: init.method, body: init.body ? JSON.parse(init.body as string) : undefined }
}
const act = () => { throw new Error('the real requests do not touch the world') }

describe('a task its owner runs, from the backend', () => {
  it('drops the owner\'s streamed words once they are a line of the conversation', async () => {
    const { useStore } = await import('./store')
    const { useLive } = await import('./live')
    const task = (count: number) => ({ id: 't', coordination: { history: { version: String(count), count } } })
    const { receive } = useStore.getState()
    vi.stubGlobal('requestAnimationFrame', (fn: () => void) => { queueMicrotask(fn); return 1 })
    receive({ type: 'patch', upserts: [{ kind: 'task', id: 't', data: task(1) }] })
    receive({ type: 'delta', subId: 'owner:t', text: '正在寫' })
    await new Promise((done) => setTimeout(done))
    expect(useLive.getState().texts['owner:t']).toBe('正在寫')
    // a change that adds no line keeps them
    receive({ type: 'patch', upserts: [{ kind: 'task', id: 't', data: task(1) }] })
    expect(useLive.getState().texts['owner:t']).toBe('正在寫')
    receive({ type: 'patch', upserts: [{ kind: 'task', id: 't', data: task(2) }] })
    expect(useLive.getState().texts['owner:t']).toBeUndefined()
  })
})

describe('a task its owner runs, over the API', () => {
  it('sends a message to the owner alone, with its requestId, and gives back what was received', async () => {
    const op = { id: 'op1', kind: 'message', status: 'received', at: 1, updatedAt: 1 }
    const f = answer({ operation: op, activity: { id: 'a1', seq: 3 } })
    vi.stubGlobal('fetch', f)
    const r = await sayToOwner(act, 'task 1', { requestId: 'r1', text: 'hi' })
    expect(r.operation).toEqual(op)
    expect(sent(f)).toEqual({ path: '/api/v1/tasks/task%201/messages', method: 'POST', body: { requestId: 'r1', text: 'hi' } })
  })

  it('sends words into a meeting with its id and who is asked, and controls and reads the meeting on its own paths', async () => {
    const f = answer({ operation: { id: 'op' }, activity: { id: 'a1' } })
    vi.stubGlobal('fetch', f)
    await sayToOwner(act, 't', { requestId: 'r1', text: 'hi', meetingId: 'sub-9', mentions: ['rep-2', 'rep-3'] })
    expect(sent(f).body).toEqual({ requestId: 'r1', text: 'hi', meetingId: 'sub-9', mentions: ['rep-2', 'rep-3'] })
    await controlMeeting(act, 't', 'sub 9', { requestId: 'c1', action: 'continue', revision: 4 })
    expect(sent(f, 1)).toEqual({ path: '/api/v1/tasks/t/meetings/sub%209/control', method: 'POST', body: { requestId: 'c1', action: 'continue', revision: 4 } })
    const page = answer({ version: '7', total: 2, items: [], hasMore: false }, 200)
    vi.stubGlobal('fetch', page)
    await readMeetingActivity(emptyWorld(), 't', 'sub-9', { before: 40, limit: 20, version: '7' })
    expect(sent(page).path).toBe('/api/v1/tasks/t/meetings/sub-9/activity?before=40&limit=20&version=7')
  })

  it('pauses with no versions, and decides anything else on the versions the screen showed', async () => {
    const f = answer({ operation: { id: 'op' } })
    vi.stubGlobal('fetch', f)
    await controlTask(act, 't', { requestId: 'p', action: 'pause' })
    await controlTask(act, 't', { requestId: 'b', action: 'return', subId: 's1', reason: 'why', planVersion: 2, controlVersion: 5 })
    expect(sent(f, 0)).toEqual({ path: '/api/v1/tasks/t/control', method: 'POST', body: { requestId: 'p', action: 'pause' } })
    expect(sent(f, 1).body).toEqual({ requestId: 'b', action: 'return', subId: 's1', reason: 'why', planVersion: 2, controlVersion: 5 })
  })

  it('keeps the refusal code, so an out-of-date action can be told from a lost connection', async () => {
    vi.stubGlobal('fetch', answer({ error: { code: 'conflict', message: '任務已變化' } }, 409))
    const e = await controlTask(act, 't', { requestId: 'r', action: 'resume', planVersion: 1, controlVersion: 1 }).catch((x) => x)
    expect(e).toBeInstanceOf(ApiError)
    expect(e.code).toBe('conflict')
    expect(e.message).toBe('任務已變化')
  })

  it('reads the conversation in pages pinned to a version, one message, and one action', async () => {
    const f = answer({ version: 'v', total: 0, items: [], hasMore: false }, 200)
    vi.stubGlobal('fetch', f)
    await readTaskActivity(emptyWorld(), 't', { limit: 50 })
    await readTaskActivity(emptyWorld(), 't', { before: 40, limit: 20, version: 'v 2' })
    await readTaskActivityItem(emptyWorld(), 't', 'a/1')
    await readTaskOperation(emptyWorld(), 't', 'op1')
    expect(f.mock.calls.map((_, i) => sent(f, i).path)).toEqual([
      '/api/v1/tasks/t/activity?limit=50',
      '/api/v1/tasks/t/activity?before=40&limit=20&version=v+2',
      '/api/v1/tasks/t/activity/a%2F1',
      '/api/v1/tasks/t/operations/op1',
    ])
    expect(f.mock.calls.every((_, i) => sent(f, i).method === 'GET')).toBe(true)
  })

  it('edits a task its owner runs only as the user saw it', async () => {
    const f = vi.fn(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', f)
    const w = emptyWorld()
    w.tasks.t = { id: 't', coordination: { planVersion: 3, controlVersion: 7 } } as never
    w.tasks.old = { id: 'old' } as never
    const p = { title: 'x', description: '', staff: {}, ownerId: 'r' }
    expect(await updateTask(w, act, 't', p)).toBe(true)
    expect(await updateTask(w, act, 'old', p)).toBe(true)
    expect(sent(f, 0).body).toEqual({ ...p, planVersion: 3, controlVersion: 7 })
    expect(sent(f, 1).body).toEqual(p)
  })

  it('sends a changed flow against the plan the sheet was opened on, and says when the task moved on', async () => {
    const f = answer({ error: { code: 'conflict', message: '任務已更新，請確認最新狀態再操作' } }, 409)
    vi.stubGlobal('fetch', f)
    const w = emptyWorld()
    w.tasks.t = { id: 't', coordination: { planVersion: 4, controlVersion: 7 } } as never
    const workflow = { id: '', name: 'x', nodes: [], edges: [] }
    const p = { title: 'x', description: '', staff: {}, ownerId: 'r', workflow, planVersion: 3 }
    expect(await updateTask(w, act, 't', p)).toBe(false)
    expect(sent(f).body).toEqual({ ...p, planVersion: 3, controlVersion: 7 })
  })
})
