import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./mode', () => ({ MOCK: false }))

import { connect, handedImageUrl, localRequest, request, setIslandRefusedHandler } from './backend'
import { apiBase, islandScope, shownUrl, socketUrl, useIsland } from './island'
import { projectImageUrl, openFolder, setFailureHandler, setLanguage } from './ops'
import { emptyWorld } from './backend'
import { terminalPath } from '../terminalSessions'
import { claudeStatus, installClaude } from '../claudeCode'
import { pickFolder } from '../pickFolder'
import { draftKey } from '../chatDraft'
import { draftAt, setDraft, unsavedIn, useFileDrafts } from '../fileDrafts'

const away = () => useIsland.setState({ island: { id: 'mac 2', name: 'Studio' }, notice: '' })
const ok = () => vi.fn(async () => new Response('{}', { status: 200 }))
const call = (f: ReturnType<typeof vi.fn>, i = -1) => f.mock.calls.at(i) as unknown as [string, RequestInit]

beforeEach(() => useIsland.setState({ island: null, notice: '' }))
afterEach(() => {
  vi.unstubAllGlobals()
  useIsland.setState({ island: null, notice: '' })
})

describe('the island shown', () => {
  it("goes to this computer's backend at home, and through it to the other's away", () => {
    expect(apiBase()).toBe('/api/v1')
    away()
    expect(apiBase()).toBe('/api/v1/remote/mac%202')
  })

  it('sends every request about the island to its base, and the tower, language and tutorial home', async () => {
    const f = ok()
    vi.stubGlobal('fetch', f)
    away()
    await request('GET', '/teams/t1/notes')
    expect(call(f)[0]).toBe('/api/v1/remote/mac%202/teams/t1/notes')
    await localRequest('GET', '/towers')
    expect(call(f)[0]).toBe('/api/v1/towers')
  })

  it('gives every request but a GET a new Idempotency-Key, and keeps JSON and pictures as they were', async () => {
    const f = ok()
    vi.stubGlobal('fetch', f)
    await request('GET', '/teams')
    expect((call(f)[1].headers as Record<string, string>)['Idempotency-Key']).toBeUndefined()
    await request('POST', '/tasks', { title: 'x' })
    const first = call(f)[1]
    const key = (first.headers as Record<string, string>)['Idempotency-Key']
    expect(key).toMatch(/\S{8,}/)
    expect((first.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    expect(first.body).toBe('{"title":"x"}')
    await request('POST', '/tasks', { title: 'x' })
    expect((call(f)[1].headers as Record<string, string>)['Idempotency-Key']).not.toBe(key)
    const picture = new Blob(['png'])
    await request('POST', '/attachments', picture)
    expect(call(f)[1].body).toBe(picture)
    expect((call(f)[1].headers as Record<string, string>)['Content-Type']).toBeUndefined()
  })

  it('takes the screen home when the other island refuses for good, but not for other refusals or at home', async () => {
    const refused = vi.fn()
    setIslandRefusedHandler(refused)
    const answer = (code: string, status: number) => vi.fn(async () => new Response(JSON.stringify({ error: { code, message: code } }), { status }))
    vi.stubGlobal('fetch', answer('peer_denied', 403))
    await expect(request('GET', '/teams')).rejects.toThrow('peer_denied')
    expect(refused).not.toHaveBeenCalled()
    away()
    await expect(request('GET', '/teams')).rejects.toThrow('peer_denied')
    expect(refused).toHaveBeenCalledTimes(1)
    vi.stubGlobal('fetch', answer('not_found', 404))
    await expect(request('GET', '/teams/x')).rejects.toThrow('not_found')
    expect(refused).toHaveBeenCalledTimes(1)
    setIslandRefusedHandler(() => {})
  })

  it('opens live updates, terminals, pictures and Claude Code on the island shown', async () => {
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:5173' })
    away()
    expect(socketUrl('/events?chats=paged')).toBe('ws://localhost:5173/api/v1/remote/mac%202/events?chats=paged')
    const opened: string[] = []
    vi.stubGlobal('WebSocket', class { constructor(url: string) { opened.push(url) } close() {} })
    vi.stubGlobal('window', { setTimeout, clearTimeout })
    connect(() => {}, () => {})()
    expect(opened).toEqual(['ws://localhost:5173/api/v1/remote/mac%202/events?chats=paged'])
    expect(terminalPath('t1')).toBe('/api/v1/remote/mac%202/teams/t1/terminal')
    expect(terminalPath('')).toBe('/api/v1/remote/mac%202/airport/terminal')
    expect(handedImageUrl('s1', 'a.png')).toBe('/api/v1/remote/mac%202/subtasks/s1/image?path=a.png')
    expect(projectImageUrl('t1', 'a.png')).toBe('/api/v1/remote/mac%202/teams/t1/image?path=a.png')
    const f = vi.fn(async () => new Response('{"installed":true,"signedIn":true,"models":[]}', { status: 200 }))
    vi.stubGlobal('fetch', f)
    const signal = new AbortController().signal
    await claudeStatus(signal)
    expect(call(f)[0]).toBe('/api/v1/remote/mac%202/claude-code')
    await installClaude(signal)
    expect(call(f)[0]).toBe('/api/v1/remote/mac%202/claude-code/install')
    expect((call(f)[1].headers as Record<string, string>)['Idempotency-Key']).toBeTruthy()
  })

  it("shows the other computer's attachment links through its base, and leaves data links and home alone", () => {
    expect(shownUrl('/api/v1/attachments/abc')).toBe('/api/v1/attachments/abc')
    away()
    expect(shownUrl('/api/v1/attachments/abc')).toBe('/api/v1/remote/mac%202/attachments/abc')
    expect(shownUrl('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA')
    expect(shownUrl('https://example.com/a.png')).toBe('https://example.com/a.png')
  })
})

describe('on another island', () => {
  it("changes this computer's language, and shows it at once", () => {
    const f = ok()
    vi.stubGlobal('fetch', f)
    away()
    const w = emptyWorld()
    setLanguage(w, 'en')
    expect(w.language).toBe('en')
    expect(call(f)[0]).toBe('/api/v1/settings/language')
    expect(call(f)[1].method).toBe('PUT')
  })

  it("never opens Finder or a folder dialog on the other computer, nor the app's own here", async () => {
    const f = ok()
    vi.stubGlobal('fetch', f)
    const failed = vi.fn()
    setFailureHandler(failed)
    away()
    openFolder('t1')
    expect(failed).toHaveBeenCalledWith('這會在對方電腦上打開視窗，這裡不能用')
    const app = vi.fn(async () => '/Users/me/here')
    vi.stubGlobal('window', { webkit: { messageHandlers: { pickFolder: { postMessage: app } } } })
    await expect(pickFolder('')).rejects.toThrow('這會在對方電腦上打開視窗')
    expect(app).not.toHaveBeenCalled()
    expect(f).not.toHaveBeenCalled()
    setFailureHandler(() => {})
  })

  it('keeps drafts apart by computer, as ids on another may be the same as here', () => {
    const here = draftKey('c1', 't1')
    setDraft('t1', 'a.md', { text: 'here', base: '', hash: 'h', crlf: false })
    away()
    expect(draftKey('c1', 't1')).not.toBe(here)
    expect(draftAt('t1', 'a.md')).toBeUndefined()
    expect(unsavedIn(useFileDrafts.getState().drafts, 't1')).toEqual([])
    setDraft('t1', 'a.md', { text: 'there', base: '', hash: 'h', crlf: false })
    expect(unsavedIn(useFileDrafts.getState().drafts, 't1')).toEqual(['a.md'])
    useIsland.setState({ island: null })
    expect(draftAt('t1', 'a.md')?.text).toBe('here')
    expect(islandScope('x')).toBe('x')
  })
})
