import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { SemanticSearchView, share, statusLine, type SemanticViewProps } from './SemanticSearch'
import { OFF, type SemanticStatus } from './semanticStatus'
import { PrefsPage } from './Settings'

const status = (p: Partial<SemanticStatus> = {}, progress: Partial<SemanticStatus['progress']> = {}): SemanticStatus =>
  ({ ...OFF, ...p, progress: { ...OFF.progress, ...progress } })
const on = (state: SemanticStatus['state'], progress: Partial<SemanticStatus['progress']> = {}, p: Partial<SemanticStatus> = {}) =>
  status({ enabled: true, active: state !== 'restart_required', requiresRestart: state === 'restart_required', state, ...p }, progress)
const noop = () => {}
const view = (p: Partial<SemanticViewProps> = {}) => renderToStaticMarkup(
  <SemanticSearchView status={OFF} loadError="" saving={false} saveError="" bridge restart="idle" restartError="" busy={false}
    onToggle={noop} onRetry={noop} onRestart={noop} onRestartBlur={noop} {...p} />)

it('shows nothing while loading, and nothing at all where the computer cannot run it', () => {
  expect(view({ status: null })).toBe('')
  expect(view({ status: status({ supported: false, state: 'unsupported' }) })).toBe('')
  expect(view({ status: status({ state: 'unsupported' }) })).toBe('')
})

it('is a switch, off, under experimental features', () => {
  const html = view()
  expect(html).toContain('實驗性功能')
  expect(html).toContain('語意搜尋')
  expect(html).toMatch(/<input[^>]*type="checkbox"[^>]*>/)
  expect(html).not.toContain('checked')
  expect(html).not.toContain('<button')
})

it('cannot be switched again while saving, and says why saving failed', () => {
  expect(view({ saving: true })).toMatch(/<input[^>]*disabled=""/)
  const html = view({ saveError: '設定存不進去' })
  expect(html).toContain('role="alert"><p>設定存不進去</p>')
  expect(html).not.toContain('checked')
})

it('asks for a restart, with a button only where the app can do it, and asks before doing it', () => {
  const s = on('restart_required')
  expect(view({ status: s })).toContain('checked')
  expect(view({ status: s })).toContain('重新啟動後生效')
  expect(view({ status: s })).toMatch(/<button[^>]*>重新啟動<\/button>/)
  expect(view({ status: s, restart: 'asking' })).toContain('確定重新啟動')
  expect(view({ status: s, restart: 'asking', busy: true })).toContain('工作會中斷，確定重新啟動')
  expect(view({ status: s, restart: 'going' })).toMatch(/<button[^>]*disabled=""[^>]*>重新啟動中…<\/button>/)
  expect(view({ status: s, restartError: '無法啟動新的 App' })).toContain('<p>無法啟動新的 App</p>')
  const browser = view({ status: s, bridge: false })
  expect(browser).toContain('重新啟動 Team Work 後生效')
  expect(browser).not.toContain('<button')
})

it('says how far the model has got, step by step', () => {
  const down = on('downloading', { downloadedBytes: 120_000_000, totalBytes: 632_000_000 })
  expect(statusLine(down, true)).toBe('下載模型中 120 / 632 MB')
  expect(share(down)).toBeCloseTo(120 / 632)
  const unknown = on('downloading', { downloadedBytes: 5_000_000, totalBytes: null })
  expect(statusLine(unknown, true)).toBe('下載模型中 5 MB')
  expect(share(unknown)).toBeNull()

  // compiling has no share to tell: a bar that only says it is busy
  const compiling = view({ status: on('compiling') })
  expect(compiling).toContain('編譯模型中')
  expect(compiling).toMatch(/<progress class="fx-labs-bar" aria-label="編譯模型中"><\/progress>/)

  const indexing = on('indexing', { completedFiles: 30, pendingFiles: 70 })
  expect(statusLine(indexing, true)).toBe('建立索引中 30 / 100 個檔案')
  expect(share(indexing)).toBeCloseTo(0.3)
  expect(view({ status: indexing })).toMatch(/role="status"[^>]*><p>建立索引中 30 \/ 100 個檔案<\/p><progress[^>]*value="0.3"/)

  const ready = view({ status: on('ready', { completedFiles: 100, chunks: 900 }) })
  expect(ready).toContain('可以使用')
  expect(ready).not.toContain('<progress')
  expect(ready).not.toContain('<button')
  // no eligible files is still ready
  expect(statusLine(on('ready'), true)).toBe('可以使用')
  expect(share(on('indexing'))).toBeNull()
})

it('shows a short reason when there is one', () => {
  expect(view({ status: on('ready', {}, { reason: '模型已就緒' }) })).toContain('模型已就緒')
})

it('says what went wrong and where the details are, keeping the switch so it can be turned off', () => {
  const html = view({ status: on('error', {}, { error: { code: 'checksum_mismatch', message: '模型檔案檢查碼不符', stage: 'verify', log: 'backend.log' } }) })
  expect(html).toContain('role="alert"><p>模型檔案檢查碼不符，詳情見 backend.log</p>')
  expect(html).toContain('checked')
})

it('when the status cannot be read, says so and offers to try again rather than claiming it is unsupported', () => {
  const html = view({ status: null, loadError: '連不上後端' })
  expect(html).toContain('實驗性功能')
  expect(html).toContain('<p>連不上後端</p>')
  expect(html).toMatch(/<button[^>]*>重試<\/button>/)
  expect(html).not.toContain('checkbox')
})

it('has no switch on the settings page before the status arrives', () => {
  expect(renderToStaticMarkup(<PrefsPage />)).not.toContain('語意搜尋')
})
