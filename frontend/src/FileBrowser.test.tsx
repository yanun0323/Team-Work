import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRef } from 'react'
import { Files, Level } from './FileBrowser'
import { fileKind } from './FileIcons'
import { FileDetail, FileEdit, loadFile, parentOf, saveDraft } from './FileSheets'
import { draftAt, draftOf, editDraftText, setDraft, useFileDrafts, type DirState } from './fileDrafts'

// rendered to a string, a store is read at its initial state: these renders show the state set up for them
const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => {
  Object.assign(useFileDrafts.getInitialState(), useFileDrafts.getState())
  return renderToStaticMarkup(el)
}
beforeEach(() => useFileDrafts.setState({ drafts: {}, views: {}, dirs: {}, leaving: null }))
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

const head = { title: createRef<HTMLHeadingElement>(), tid: 'h' }
const dirsOf = (dirs: Record<string, DirState>) => Object.fromEntries(Object.entries(dirs).map(([path, d]) => [`t\n${path}`, d]))

describe('the tab', () => {
  const level = (dirs: Record<string, DirState>, expanded: string[] = [], open: string | null = null) => {
    useFileDrafts.setState({ dirs: dirsOf(dirs) })
    return render(<Level teamId="t" path="" open={open} onOpen={() => {}} expanded={expanded} onToggle={() => {}} />)
  }

  it('has no way to make files or folders, only the tree', () => {
    const html = render(<Files teamId="t" open={null} onOpen={() => {}} />)
    expect(html).toContain('fx-files-level')
    expect(html).not.toContain('新增')
  })

  it('shows a folder being read, an empty one and one that failed', () => {
    expect(level({})).toContain('讀取中…')
    expect(level({ '': { status: 'ok', entries: [], truncated: false } })).toContain('空資料夾')
    expect(level({ '': { status: 'error', message: '找不到專案資料夾' } })).toContain('role="alert">找不到專案資料夾')
  })

  it('opens folders in place and files on a sheet, marks files while unsaved, and says when the list was cut short', () => {
    setDraft('t', 'b.txt', draftOf('b', 'h'))
    editDraftText('t', 'b.txt', 'changed')
    const html = level({
      '': { status: 'ok', entries: [{ name: 'src', path: 'src', kind: 'dir' }, { name: 'a.txt', path: 'a.txt', kind: 'file' }, { name: 'b.txt', path: 'b.txt', kind: 'file' }], truncated: true },
      src: { status: 'ok', entries: [{ name: 'main.go', path: 'src/main.go', kind: 'file' }], truncated: false },
    }, ['src'], 'file:a.txt')
    expect(html).toContain('data-path="src" aria-expanded="true"')
    expect(html).toContain('data-path="src/main.go"')
    expect(html).toContain('data-path="a.txt" aria-expanded="true" aria-controls="fx-detail"')
    expect(html).toContain('data-path="b.txt" aria-expanded="false"')
    expect(html.match(/fx-files-dot/g)).toHaveLength(1)
    expect(html.indexOf('fx-files-dot')).toBeGreaterThan(html.indexOf('data-path="b.txt"'))
    expect(html).toContain('只列出前 5000 項')
  })

  it('marks each row with an icon for what it is, and a folder open or shut by its icon', () => {
    const html = level({
      '': { status: 'ok', entries: [
        { name: 'src', path: 'src', kind: 'dir' }, { name: 'docs', path: 'docs', kind: 'dir' },
        { name: 'a.md', path: 'a.md', kind: 'file' }, { name: 'logo.PNG', path: 'logo.PNG', kind: 'file' }, { name: 'run.sh', path: 'run.sh', kind: 'file' },
      ], truncated: false },
      src: { status: 'ok', entries: [], truncated: false },
    }, ['src'])
    const iconAfter = (path: string) => html.slice(html.indexOf(`data-path="${path}"`)).match(/fx-files-icon-([a-z-]+)/)?.[1]
    expect(iconAfter('src')).toBe('folder-open')
    expect(iconAfter('docs')).toBe('folder')
    expect(iconAfter('a.md')).toBe('file')
    expect(iconAfter('logo.PNG')).toBe('media')
    expect(iconAfter('run.sh')).toBe('shell')
    expect(html).not.toMatch(/[▸▾]/)
  })

  it('shows what git ignores faintly', () => {
    const html = level({ '': { status: 'ok', entries: [
      { name: 'dist', path: 'dist', kind: 'dir', ignored: true }, { name: 'src', path: 'src', kind: 'dir' },
      { name: '.env', path: '.env', kind: 'file', ignored: true }, { name: 'a.go', path: 'a.go', kind: 'file' },
    ], truncated: false } })
    const classOf = (path: string) => html.match(new RegExp(`class="([^"]*)" data-path="${path.replace('.', '\\.')}"`))?.[1]
    expect(classOf('dist')).toContain('fx-files-ignored')
    expect(classOf('.env')).toContain('fx-files-ignored')
    expect(classOf('src')).not.toContain('fx-files-ignored')
    expect(classOf('a.go')).not.toContain('fx-files-ignored')
  })

  it('tells media and shell scripts from other files by name', () => {
    expect(['a.jpg', 'b.webp', 'c.svg', 'd.mp4', 'e.mp3'].map(fileKind)).toEqual(['media', 'media', 'media', 'media', 'media'])
    expect(['x.sh', 'y.bash', 'z.zsh', 'w.command'].map(fileKind)).toEqual(['shell', 'shell', 'shell', 'shell'])
    expect(['README.md', 'Makefile', 'main.go', 'sh'].map(fileKind)).toEqual(['text', 'text', 'text', 'text'])
  })

  it('gives each folder, and no file, a button to open it in Finder', () => {
    const html = level({ '': { status: 'ok', entries: [
      { name: 'src', path: 'src', kind: 'dir' }, { name: 'docs', path: 'docs', kind: 'dir' }, { name: 'a.go', path: 'a.go', kind: 'file' },
    ], truncated: false } })
    expect(html.match(/class="fx-files-finder"/g)).toHaveLength(2)
    const rowOf = (path: string) => html.slice(html.indexOf(`data-path="${path}"`)).split('</li>')[0]
    expect(rowOf('src')).toContain('aria-label="在 Finder 打開"')
    expect(rowOf('a.go')).not.toContain('fx-files-finder')
  })

  it('does not read a folder that is closed', () => {
    const html = level({ '': { status: 'ok', entries: [{ name: 'node_modules', path: 'node_modules', kind: 'dir' }], truncated: false } })
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('讀取中…')
  })
})

describe('the sheets', () => {
  it('show a file being read, with no way to edit it yet', () => {
    const html = render(<FileDetail {...head} teamId="t" path="docs/a.md" editing={false} onEdit={() => {}} />)
    expect(html).toContain('>a.md</h2>')
    expect(html).toContain('<code>docs/a.md</code>')
    expect(html).toContain('讀取中…')
    expect(html).not.toContain('aria-label="編輯"')
  })

  it('show a picture without reading it as text', () => {
    const html = render(<FileDetail {...head} teamId="t" path="p/x.png" editing={false} onEdit={() => {}} />)
    expect(html).toContain('讀取中…')
    expect(html).not.toContain('fx-files-text')
  })

  it('edit a file in a text box once it is read', () => {
    expect(render(<FileEdit {...head} teamId="t" path="a.txt" onDone={() => {}} />)).toContain('編輯 a.txt')
  })
})

it('knows the folder a path is in', () => {
  expect(parentOf('a/b/c.txt')).toBe('a/b')
  expect(parentOf('c.txt')).toBe('')
})

it('puts the tab right before the terminal, outside the simulator', async () => {
  vi.resetModules()
  vi.doMock('./core/mode', () => ({ MOCK: false }))
  try {
    const { TABS } = await import('./DrawerTabs')
    const ids = TABS.map((x) => x.id)
    expect(ids.indexOf('terminal')).toBe(ids.indexOf('files') + 1)
    expect(TABS.find((x) => x.id === 'files')?.label).toBe('檔案瀏覽')
  } finally {
    vi.doUnmock('./core/mode')
    vi.resetModules()
  }
})
