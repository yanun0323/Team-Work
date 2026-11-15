import { afterEach, describe, expect, it, vi } from 'vitest'
import { addTeamMemory, deleteTeamMemory, editTeamMemory } from './ops'

vi.mock('./mode', () => ({ MOCK: false }))
afterEach(() => vi.unstubAllGlobals())

const act = () => { throw new Error('the world changes by what the backend sends') }

describe('company memory requests', () => {
  it('adds, corrects and removes one note at a time', async () => {
    const note = { id: 'mem-1', text: 'x', source: 'user', at: 1 }
    const f = vi.fn(async (_path: string, init: RequestInit) => new Response(init.method === 'DELETE' ? null : JSON.stringify(note), { status: init.method === 'POST' ? 201 : init.method === 'DELETE' ? 204 : 200 }))
    vi.stubGlobal('fetch', f)
    await expect(addTeamMemory(act, 't 1', 'x')).resolves.toEqual(note)
    await expect(editTeamMemory(act, 't 1', 'mem-1', 'y')).resolves.toEqual(note)
    await expect(deleteTeamMemory(act, 't 1', 'mem-1')).resolves.toBeUndefined()
    const calls = f.mock.calls.map(([path, init]) => [init.method, path, init.body])
    expect(calls).toEqual([
      ['POST', '/api/v1/teams/t%201/memory', '{"text":"x"}'],
      ['PATCH', '/api/v1/teams/t%201/memory/mem-1', '{"text":"y"}'],
      ['DELETE', '/api/v1/teams/t%201/memory/mem-1', undefined],
    ])
  })

  it("passes on the backend's refusal", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"code":"invalid_request","message":"text is empty"}}', { status: 400 })))
    await expect(addTeamMemory(act, 't', ' ')).rejects.toThrow('text is empty')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"code":"not_found","message":"no note"}}', { status: 404 })))
    await expect(deleteTeamMemory(act, 't', 'gone')).rejects.toThrow('no note')
  })
})
