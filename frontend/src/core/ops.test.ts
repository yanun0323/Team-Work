import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyPatches, emptyWorld, request, UNREACHABLE } from './backend'
import { fmtClock } from './model'

afterEach(() => vi.unstubAllGlobals())

describe('changes from the backend', () => {
  it('writes and removes entities in the right book', () => {
    const w = emptyWorld()
    applyPatches(w, { upserts: [{ kind: 'team', id: 'a', data: { id: 'a' } }, { kind: 'subTask', id: 's', data: { id: 's' } }] })
    expect(w.teams.a).toEqual({ id: 'a' })
    expect(w.subTasks.s).toEqual({ id: 's' })
    applyPatches(w, { deletes: [{ kind: 'team', id: 'a' }] })
    expect(w.teams.a).toBeUndefined()
    expect(w.subTasks.s).toBeDefined()
  })

  it('ignores kinds it does not know, for a newer backend', () => {
    const w = emptyWorld()
    applyPatches(w, { upserts: [{ kind: 'unknown', id: 'x', data: {} }], deletes: [{ kind: 'unknown', id: 'x' }] })
    expect(w).toEqual({ ...emptyWorld(), now: w.now })
  })

  it('leaves what the user is editing alone', () => {
    const w = emptyWorld()
    w.teams.a = { id: 'a', name: '正在打字' } as never
    applyPatches(w, { upserts: [{ kind: 'team', id: 'a', data: { id: 'a', name: '舊的' } }] }, (k, id) => k === 'team' && id === 'a')
    expect(w.teams.a.name).toBe('正在打字')
  })
})

describe('requests', () => {
  it('sends JSON and reads what comes back', async () => {
    const f = vi.fn(async () => new Response('{"id":"t"}', { status: 201 }))
    vi.stubGlobal('fetch', f)
    await expect(request('POST', '/teams', { name: 'x' })).resolves.toEqual({ id: 't' })
    const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(path).toBe('/api/v1/teams')
    expect(init.body).toBe('{"name":"x"}')
  })

  it('takes nothing back from an empty answer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })))
    await expect(request('POST', '/x')).resolves.toBeUndefined()
  })

  it('shows the backend\'s message, or says it is not there', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"code":"conflict","message":"不行"}}', { status: 409 })))
    await expect(request('POST', '/x')).rejects.toThrow('不行')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })))
    await expect(request('POST', '/x')).rejects.toThrow(UNREACHABLE)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    await expect(request('POST', '/x')).rejects.toThrow(UNREACHABLE)
  })
})

describe('the clock', () => {
  it('counts up on the simulator and tells the time on the backend', () => {
    expect(fmtClock(65)).toBe('1:05')
    expect(fmtClock(1793000000)).toMatch(/^\d{2}:\d{2}$/)
  })
})
