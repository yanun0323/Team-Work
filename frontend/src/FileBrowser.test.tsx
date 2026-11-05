import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FilePane, Level, loadFile, parentOf, saveDraft, type DirState } from './FileBrowser'
import { draftAt, draftOf, editDraftText, setDraft, useFileDrafts } from './fileDrafts'

// rendered to a string, a store is read at its initial state: these renders show the state set up for them
const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => {
  Object.assign(useFileDrafts.getInitialState(), useFileDrafts.getState())
  return renderToStaticMarkup(el)
}
beforeEach(() => useFileDrafts.setState({ drafts: {}, views: {}, leaving: null }))
afterEach(() => vi.unstubAllGlobals())

const answer = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }))
const refusal = (status: number, code: string, message: string) => answer(status, { error: { code, message } })

describe('opening a file', () => {
  it('reads a text file into a draft with its hash', async () => {
    const f = answer(200, { text: 'a\r\nb', hash: 'h1' })
    vi.stubGlobal('fetch', f)
    await expect(loadFile('t', 'src/a.txt')).resolves.toEqual({ status: 'ready' })
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe('/api/v1/teams/t/file?path=src%2Fa.txt')
    expect(draftAt('t', 'src/a.txt')).toEqual({ text: 'a\nb', base: 'a\nb', hash: 'h1', crlf: true })
  })

  it('keeps unsaved changes instead of reading the file again', async () => {
    setDraft('t', 'a.txt', draftOf('old', 'h'))
    editDraftText('t', 'a.txt', 'mine')
    const f = answer(200, { text: 'theirs', hash: 'h2' })
    vi.stubGlobal('fetch', f)
    await expect(loadFile('t', 'a.txt')).resolves.toEqual({ status: 'ready' })
    expect(f).not.toHaveBeenCalled()
    expect(draftAt('t', 'a.txt')?.text).toBe('mine')
  })

  it('tells a file it cannot show from one it failed to read, and shows pictures without reading them', async () => {
    vi.stubGlobal('fetch', refusal(415, 'unsupported', 'x.bin 不是文字檔'))
    await expect(loadFile('t', 'x.bin')).resolves.toEqual({ status: 'unsupported', message: 'x.bin 不是文字檔' })
    vi.stubGlobal('fetch', refusal(404, 'not_found', '找不到'))
    await expect(loadFile('t', 'gone.txt')).resolves.toEqual({ status: 'error', message: '找不到' })
    const f = vi.fn()
    vi.stubGlobal('fetch', f)
    await expect(loadFile('t', 'a/b.PNG')).resolves.toEqual({ status: 'image' })
    expect(f).not.toHaveBeenCalled()
  })
})

describe('saving', () => {
  it('sends the text with the line ends the file had and the hash it was read with', async () => {
    setDraft('t', 'a.txt', draftOf('a\r\n', 'h1'))
    editDraftText('t', 'a.txt', 'a\nb\n')
    const f = answer(200, { hash: 'h2' })
    vi.stubGlobal('fetch', f)
    await expect(saveDraft('t', 'a.txt')).resolves.toEqual({ ok: true })
    const [path, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(path).toBe('/api/v1/teams/t/file')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(init.body as string)).toEqual({ path: 'a.txt', text: 'a\r\nb\r\n', hash: 'h1' })
    expect(draftAt('t', 'a.txt')).toMatchObject({ text: 'a\nb\n', base: 'a\nb\n', hash: 'h2' })
  })

  it('keeps the draft and its old hash when the file changed elsewhere', async () => {
    setDraft('t', 'a.txt', draftOf('a', 'h1'))
    editDraftText('t', 'a.txt', 'mine')
    vi.stubGlobal('fetch', refusal(409, 'conflict', '檔案已在別處被修改，請重新讀取'))
    await expect(saveDraft('t', 'a.txt')).resolves.toEqual({ ok: false, conflict: true, message: '檔案已在別處被修改，請重新讀取' })
    expect(draftAt('t', 'a.txt')).toMatchObject({ text: 'mine', base: 'a', hash: 'h1' })
  })

  it('reports other failures without calling them a conflict', async () => {
    setDraft('t', 'a.txt', draftOf('a', 'h1'))
    editDraftText('t', 'a.txt', 'mine')
    vi.stubGlobal('fetch', refusal(502, 'unavailable', '寫不進去'))
    await expect(saveDraft('t', 'a.txt')).resolves.toEqual({ ok: false, conflict: false, message: '寫不進去' })
    expect(draftAt('t', 'a.txt')?.text).toBe('mine')
  })
})

describe('the tree', () => {
  const level = (dirs: Record<string, DirState>, expanded: string[] = [], open: string | null = null) => render(
    <Level teamId="t" path="" dirs={dirs} expanded={expanded} open={open} creating={null}
      onToggle={() => {}} onCreate={() => {}} onCancelCreate={() => {}} onCreated={() => {}} />,
  )

  it('shows a folder being read, an empty one and one that failed', () => {
    expect(level({})).toContain('讀取中…')
    expect(level({ '': { status: 'ok', entries: [], truncated: false } })).toContain('空資料夾')
    expect(level({ '': { status: 'error', message: '找不到專案資料夾' } })).toContain('role="alert">找不到專案資料夾')
  })

  it('lists folders that open in place, files marked while unsaved, and says when the list was cut short', () => {
    setDraft('t', 'b.txt', draftOf('b', 'h'))
    editDraftText('t', 'b.txt', 'changed')
    const html = level({
      '': { status: 'ok', entries: [{ name: 'src', path: 'src', kind: 'dir' }, { name: 'a.txt', path: 'a.txt', kind: 'file' }, { name: 'b.txt', path: 'b.txt', kind: 'file' }], truncated: true },
      src: { status: 'ok', entries: [{ name: 'main.go', path: 'src/main.go', kind: 'file' }], truncated: false },
    }, ['src'], 'a.txt')
    expect(html).toContain('data-path="src" aria-expanded="true"')
    expect(html).toContain('data-path="src/main.go"')
    expect(html).toContain('data-path="a.txt" aria-current="true"')
    expect(html.match(/fx-files-dot/g)).toHaveLength(1)
    expect(html.indexOf('fx-files-dot')).toBeGreaterThan(html.indexOf('data-path="b.txt"'))
    expect(html).toContain('只列出前 5000 項')
    expect(html).toContain('aria-label="新增檔案"')
    expect(html).toContain('aria-label="新增資料夾"')
  })

  it('does not read a folder that is closed', () => {
    const html = level({ '': { status: 'ok', entries: [{ name: 'node_modules', path: 'node_modules', kind: 'dir' }], truncated: false } })
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('讀取中…')
  })
})

describe('the open file', () => {
  const pane = (state: Parameters<typeof FilePane>[0]['state'], path = 'a.txt') =>
    render(<FilePane teamId="t" path={path} state={state} onReread={() => {}} onImageError={() => {}} />)

  it('edits text, saving only once something changed', () => {
    setDraft('t', 'a.txt', draftOf('hello', 'h'))
    expect(pane({ status: 'ready' })).toMatch(/<button type="button" class="fx-save" disabled="">儲存<\/button>/)
    expect(pane({ status: 'ready' })).toContain('hello</textarea>')
    editDraftText('t', 'a.txt', 'hello!')
    expect(pane({ status: 'ready' })).toMatch(/<button type="button" class="fx-save">儲存<\/button>/)
    expect(pane({ status: 'ready' })).toContain('fx-files-dot')
  })

  it('shows a picture, says why a file cannot be shown, and shows read errors', () => {
    expect(pane({ status: 'image' }, 'p/x.png')).toContain('src="/api/v1/teams/t/image?path=p%2Fx.png"')
    const no = pane({ status: 'unsupported', message: 'x.bin 不是文字檔' }, 'x.bin')
    expect(no).toContain('無法預覽')
    expect(no).toContain('x.bin 不是文字檔')
    expect(no).toContain('在 Finder 顯示')
    expect(no).not.toContain('fx-save')
    expect(pane({ status: 'error', message: '找不到' })).toContain('role="alert">找不到')
    expect(pane({ status: 'loading' })).toContain('讀取中…')
  })
})

it('knows the folder a path is in', () => {
  expect(parentOf('a/b/c.txt')).toBe('a/b')
  expect(parentOf('c.txt')).toBe('')
})

it('puts the tab right after the terminal, outside the simulator', async () => {
  vi.resetModules()
  vi.doMock('./core/mode', () => ({ MOCK: false }))
  try {
    const { TABS } = await import('./DrawerTabs')
    const ids = TABS.map((x) => x.id)
    expect(ids.indexOf('files')).toBe(ids.indexOf('terminal') + 1)
    expect(TABS.find((x) => x.id === 'files')?.label).toBe('檔案瀏覽')
  } finally {
    vi.doUnmock('./core/mode')
    vi.resetModules()
  }
})
