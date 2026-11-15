import { afterEach, describe, expect, it, vi } from 'vitest'
import { deleteTeam } from './ops'

vi.mock('./mode', () => ({ MOCK: false }))
afterEach(() => vi.unstubAllGlobals())

const act = () => { throw new Error('the world changes by what the backend sends') }

describe('closing a company', () => {
  it('names each one kept in the query, and none when nobody is', async () => {
    const f = vi.fn(async (_path: string, _init: RequestInit) => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', f)
    await expect(deleteTeam(act, 't 1', ['rep-1', 'r&2'])).resolves.toBeUndefined()
    await expect(deleteTeam(act, 't 1')).resolves.toBeUndefined()
    await expect(deleteTeam(act, 't 1', [])).resolves.toBeUndefined()
    expect(f.mock.calls.map(([path, init]) => [init.method, path, init.body])).toEqual([
      ['DELETE', '/api/v1/teams/t%201?keep=rep-1&keep=r%262', undefined],
      ['DELETE', '/api/v1/teams/t%201', undefined],
      ['DELETE', '/api/v1/teams/t%201', undefined],
    ])
  })

  it("passes on the backend's refusal for the sheet to show", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"code":"invalid_request","message":"Bo 選了兩次"}}', { status: 400 })))
    await expect(deleteTeam(act, 't', ['b', 'b'])).rejects.toThrow('Bo 選了兩次')
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"code":"not_found","message":"找不到公司"}}', { status: 404 })))
    await expect(deleteTeam(act, 'gone')).rejects.toThrow('找不到公司')
  })
})
