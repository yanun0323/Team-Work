import { afterEach, describe, expect, it, vi } from 'vitest'

// the real requests, not the simulator
vi.mock('./mode', () => ({ MOCK: false }))

const { controlTask, readTaskActivity, readTaskActivityItem, readTaskOperation, sayToOwner, updateTask } = await import('./ops')
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
    const f = answer(null, 204)
    vi.stubGlobal('fetch', f)
    const w = emptyWorld()
    w.tasks.t = { id: 't', coordination: { planVersion: 3, controlVersion: 7 } } as never
    w.tasks.old = { id: 'old' } as never
    const p = { title: 'x', description: '', staff: {}, ownerId: 'r' }
    updateTask(w, 't', p)
    updateTask(w, 'old', p)
    await vi.waitFor(() => expect(f).toHaveBeenCalledTimes(2))
    expect(sent(f, 0).body).toEqual({ ...p, planVersion: 3, controlVersion: 7 })
    expect(sent(f, 1).body).toEqual(p)
  })
})
