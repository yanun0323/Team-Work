import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  answerLeaving, dirAt, draftAt, draftOf, editDraftText, forgetClean, isDirty, leaveTeam, loadDir, markSaved, setDraft,
  textToSave, toggleFolder, unsavedIn, useFileDrafts, viewOf,
} from './fileDrafts'

beforeEach(() => useFileDrafts.setState({ drafts: {}, views: {}, dirs: {}, leaving: null }))
afterEach(() => vi.unstubAllGlobals())

it('edits CRLF files with LF line ends and writes them back with CRLF', () => {
  const d = draftOf('a\r\nb\r\n', 'h')
  expect(d).toEqual({ text: 'a\nb\n', base: 'a\nb\n', hash: 'h', crlf: true })
  expect(textToSave({ ...d, text: 'a\nb\nc\n' })).toBe('a\r\nb\r\nc\r\n')
  const lf = draftOf('a\nb\n', 'h')
  expect(lf.crlf).toBe(false)
  expect(textToSave({ ...lf, text: 'x\ny' })).toBe('x\ny')
})

it('is unsaved while the text differs from what was read or last saved', () => {
  setDraft('t', 'a.txt', draftOf('one', 'h1'))
  expect(isDirty(draftAt('t', 'a.txt'))).toBe(false)
  editDraftText('t', 'a.txt', 'two')
  expect(isDirty(draftAt('t', 'a.txt'))).toBe(true)
  expect(unsavedIn(useFileDrafts.getState().drafts, 't')).toEqual(['a.txt'])
  expect(unsavedIn(useFileDrafts.getState().drafts, 'other')).toEqual([])
  markSaved('t', 'a.txt', 'two', 'h2')
  expect(draftAt('t', 'a.txt')).toMatchObject({ base: 'two', hash: 'h2' })
  expect(isDirty(draftAt('t', 'a.txt'))).toBe(false)
})

it('forgets a clean draft once its sheets are put away, and keeps an unsaved one', () => {
  setDraft('t', 'a.txt', draftOf('a', 'h'))
  forgetClean('t', 'a.txt')
  expect(draftAt('t', 'a.txt')).toBeUndefined()
  setDraft('t', 'b.txt', draftOf('b', 'h'))
  editDraftText('t', 'b.txt', 'changed')
  forgetClean('t', 'b.txt')
  expect(draftAt('t', 'b.txt')?.text).toBe('changed')
})

it('reads a folder, keeping the old listing on show while it is read again, and says why one could not be read', async () => {
  const entries = [{ name: 'src', path: 'src', kind: 'dir' }]
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ entries, truncated: false }))))
  await loadDir('t', '')
  expect(dirAt(useFileDrafts.getState().dirs, 't', '')).toEqual({ status: 'ok', entries, truncated: false })
  const again = loadDir('t', '')
  expect(dirAt(useFileDrafts.getState().dirs, 't', '')).toEqual({ status: 'loading', entries, truncated: false })
  await again
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'not_found', message: '找不到' } }), { status: 404 })))
  await loadDir('t', 'gone')
  expect(dirAt(useFileDrafts.getState().dirs, 't', 'gone')).toEqual({ status: 'error', message: '找不到' })
  expect(dirAt(useFileDrafts.getState().dirs, 'u', '')).toBeUndefined()
})

it('remembers which folders are open, per company', () => {
  toggleFolder('t', 'src')
  toggleFolder('t', 'docs')
  toggleFolder('t', 'src')
  expect(viewOf(useFileDrafts.getState().views, 't').expanded).toEqual(['docs'])
  toggleFolder('t', 'docs', true)
  expect(viewOf(useFileDrafts.getState().views, 't').expanded).toEqual(['docs'])
  expect(viewOf(useFileDrafts.getState().views, 'u').expanded).toEqual([])
})

it('leaves a company at once without unsaved drafts, and otherwise only once the user agrees', () => {
  const go = vi.fn()
  leaveTeam('t', go)
  expect(go).toHaveBeenCalledTimes(1)
  leaveTeam(null, go)
  expect(go).toHaveBeenCalledTimes(2)

  setDraft('t', 'a.txt', draftOf('a', 'h'))
  editDraftText('t', 'a.txt', 'b')
  leaveTeam('t', go)
  expect(go).toHaveBeenCalledTimes(2)
  expect(useFileDrafts.getState().leaving?.teamId).toBe('t')
  answerLeaving(false)
  expect(go).toHaveBeenCalledTimes(2)
  expect(useFileDrafts.getState().leaving).toBeNull()

  leaveTeam('t', go)
  answerLeaving(true)
  expect(go).toHaveBeenCalledTimes(3)
  // the draft is still there to come back to
  expect(draftAt('t', 'a.txt')?.text).toBe('b')
})
