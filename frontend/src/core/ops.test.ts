import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyPatches, emptyWorld, request, unreachable } from './backend'
import { fmtClock } from './model'
import { ApiError } from './backend'
import { createProjectEntry, deleteMemory, editMemory, listProjectTree, projectImageUrl } from './ops'

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
    const plot = { at: [10, 10], style: 'villa', seed: 123 }
    applyPatches(w, { upserts: [{ kind: 'team', id: 'a', data: { id: 'a', name: '舊的', plot } }] }, (k, id) => k === 'team' && id === 'a')
    expect(w.teams.a.name).toBe('正在打字')
    expect(w.teams.a.plot).toEqual(plot)
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
    await expect(request('POST', '/x')).rejects.toThrow(unreachable())
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    await expect(request('POST', '/x')).rejects.toThrow(unreachable())
  })

  it('tells kinds of refusal apart by the backend\'s code and status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"code":"conflict","message":"不行"}}', { status: 409 })))
    const e = await request('POST', '/x').catch((x: unknown) => x)
    expect(e).toBeInstanceOf(ApiError)
    expect(e).toMatchObject({ message: '不行', code: 'conflict', status: 409 })
  })
})

describe('the project\'s files', () => {
  it('lists one level of a folder, empty as an empty list', async () => {
    const f = vi.fn(async () => new Response('{"entries":null,"truncated":false}'))
    vi.stubGlobal('fetch', f)
    await expect(listProjectTree('t', 'a b')).resolves.toEqual({ entries: [], truncated: false })
    expect(f.mock.calls[0]).toEqual(['/api/v1/teams/t/tree?path=a%20b', expect.objectContaining({ method: 'GET' })])
  })

  it('makes a file or folder in a folder', async () => {
    const f = vi.fn(async () => new Response('{"name":"n.txt","path":"a/n.txt","kind":"file"}', { status: 201 }))
    vi.stubGlobal('fetch', f)
    await expect(createProjectEntry('t', 'a', 'n.txt', 'file')).resolves.toEqual({ name: 'n.txt', path: 'a/n.txt', kind: 'file' })
    const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(path).toBe('/api/v1/teams/t/tree')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ parent: 'a', name: 'n.txt', kind: 'file' })
  })
})

describe('the clock', () => {
  it('counts up on the simulator and tells the time on the backend', () => {
    expect(fmtClock(65)).toBe('1:05')
    expect(fmtClock(1793000000)).toMatch(/^\d{2}:\d{2}$/)
  })
})

describe('correcting memory', () => {
  const world = () => {
    const w = emptyWorld()
    w.now = 50
    w.replicas.r = { memory: [{ id: 'a', text: 'old', source: 'work', at: 1 }, { id: 'b', text: 'keep', source: 'work', at: 2 }] } as never
    return w
  }

  it('marks an edit as the user\'s own note and leaves the others', () => {
    const w = world()
    editMemory(w, 'r', 'a', 'new')
    expect(w.replicas.r.memory).toEqual([{ id: 'a', text: 'new', source: 'user', at: 50 }, { id: 'b', text: 'keep', source: 'work', at: 2 }])
  })

  it('removes only the deleted note', () => {
    const w = world()
    deleteMemory(w, 'r', 'a')
    expect(w.replicas.r.memory.map((m) => m.id)).toEqual(['b'])
  })
})

describe('files a message names', () => {
  it('are in the company\'s folder, or at home for the airport\'s', () => {
    expect(projectImageUrl('t1', 'a b.png')).toBe('/api/v1/teams/t1/image?path=a%20b.png')
    expect(projectImageUrl('', 'Pictures/a.png')).toBe('/api/v1/airport/image?path=Pictures%2Fa.png')
  })
})
