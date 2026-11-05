import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Tool = typeof import('./gitTool')
type Install = typeof import('./GitInstall')

const reply = (status: number, body?: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status })

/** The real thing, outside the simulator, with the backend answering `answer`. */
async function load(answer: (path: string, init?: RequestInit) => Response) {
  vi.resetModules()
  vi.doMock('./core/mode', () => ({ MOCK: false }))
  const fetch = vi.fn(async (path: string, init?: RequestInit) => answer(path, init))
  vi.stubGlobal('fetch', fetch)
  const tool: Tool = await import('./gitTool')
  const ui: Install = await import('./GitInstall')
  return { tool, ui, fetch }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('window', { setInterval, clearInterval, setTimeout, clearTimeout, addEventListener: vi.fn(), removeEventListener: vi.fn() })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.doUnmock('./core/mode')
  vi.resetModules()
})

describe('installing git', () => {
  it('is ready at once in the simulator, which asks nothing', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const tool: Tool = await import('./gitTool')
    await tool.checkGit()
    expect(tool.gitState().phase).toBe('ready')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('plays a clean Mac in the simulator, and pretends to install git', async () => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const tool: Tool = await import('./gitTool')
    const ui: Install = await import('./GitInstall')
    const { CleanMacDebug } = await import('./CleanMacDebug')
    expect(renderToStaticMarkup(<CleanMacDebug />)).toContain('aria-pressed="false"')

    tool.simulateNoGit(true)
    expect(tool.gitState().phase).toBe('missing')
    expect(renderToStaticMarkup(<CleanMacDebug />)).toContain('aria-pressed="true"')
    expect(renderToStaticMarkup(<ui.GitGate>app</ui.GitGate>)).toContain('缺少必要套件')

    await tool.installGit()
    expect(tool.gitState().phase).toBe('waiting')
    await vi.advanceTimersByTimeAsync(tool.SIMULATED_INSTALL_MS)
    expect(tool.gitState().phase).toBe('ready')
    expect(fetch).not.toHaveBeenCalled()

    // turned off halfway, the pretend install does not finish later
    tool.simulateNoGit(true)
    await tool.installGit()
    tool.simulateNoGit(false)
    tool.simulateNoGit(true)
    await vi.advanceTimersByTimeAsync(tool.SIMULATED_INSTALL_MS)
    expect(tool.gitState().phase).toBe('missing')
  })

  it('stops the whole app while git is missing, under a note with the button that installs it', async () => {
    const { tool, ui } = await load(() => reply(200, { installed: false, installable: true }))
    // not known yet: the app runs
    expect(renderToStaticMarkup(<ui.GitGate><button>app</button></ui.GitGate>)).toBe('<div class="fx-app"><button>app</button></div>')
    await tool.checkGit()
    expect(tool.gitState().phase).toBe('missing')
    const html = renderToStaticMarkup(<ui.GitGate><button>app</button></ui.GitGate>)
    expect(html).toContain('<div class="fx-app fx-halted" aria-hidden="true" inert=""><button>app</button></div>')
    expect(html).toContain('缺少必要套件')
    expect(html).toContain('>安裝</button>')
  })

  it('stops the app with no button where it cannot install git itself, and lets it run once git is there', async () => {
    const { tool, ui } = await load(() => reply(200, { installed: false, installable: false }))
    await tool.checkGit()
    const html = renderToStaticMarkup(<ui.GitGate>app</ui.GitGate>)
    expect(html).toContain('這台電腦還沒有 git')
    expect(html).not.toContain('<button')
    tool.resetGit({ phase: 'ready' })
    expect(renderToStaticMarkup(<ui.GitGate>app</ui.GitGate>)).toBe('<div class="fx-app">app</div>')
  })

  it('shows nothing where git is there, or where the app cannot install it', async () => {
    const { tool, ui } = await load(() => reply(200, { installed: true, version: '2.39.5', installable: true }))
    await tool.checkGit()
    expect(tool.gitState().phase).toBe('ready')
    expect(renderToStaticMarkup(<ui.GitInstall />)).toBe('')
    tool.resetGit({ phase: 'missing', installable: false })
    expect(renderToStaticMarkup(<ui.GitInstall />)).toBe('')
  })

  it('opens the installer with the user\'s word, then waits until git is found', async () => {
    let installed = false
    const { tool, ui, fetch } = await load((path) => {
      if (path === '/api/v1/git/install') return reply(204)
      return reply(200, { installed, installable: true })
    })
    await tool.checkGit()
    await tool.installGit()
    const install = fetch.mock.calls.find(([path]) => path === '/api/v1/git/install')!
    expect(install[1]).toMatchObject({ method: 'POST', body: '{"consent":true}' })
    expect(tool.gitState().phase).toBe('waiting')
    expect(renderToStaticMarkup(<ui.GitInstall />)).toContain('請在 Apple 的視窗完成安裝')

    await vi.advanceTimersByTimeAsync(tool.POLL_MS)
    expect(tool.gitState().phase).toBe('waiting')
    installed = true
    await vi.advanceTimersByTimeAsync(tool.POLL_MS)
    expect(tool.gitState().phase).toBe('ready')
    // and asks no more
    const asked = fetch.mock.calls.length
    await vi.advanceTimersByTimeAsync(tool.POLL_MS * 3)
    expect(fetch.mock.calls.length).toBe(asked)
  })

  it('stops waiting on a window long cancelled', async () => {
    const { tool } = await load((path) => (path === '/api/v1/git/install' ? reply(204) : reply(200, { installed: false, installable: true })))
    await tool.installGit()
    await vi.advanceTimersByTimeAsync(tool.WAIT_MS + tool.POLL_MS)
    expect(tool.gitState().phase).toBe('missing')
  })

  it('shows why the installer did not open', async () => {
    const { tool, ui } = await load((path) => (path === '/api/v1/git/install'
      ? reply(502, { error: { code: 'unavailable', message: '無法開啟安裝視窗' } })
      : reply(200, { installed: false, installable: true })))
    await tool.checkGit()
    await tool.installGit()
    expect(tool.gitState()).toMatchObject({ phase: 'missing', error: '無法開啟安裝視窗' })
    expect(renderToStaticMarkup(<ui.GitInstall />)).toContain('無法開啟安裝視窗')
  })
})
