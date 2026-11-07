// Isolated chat benchmark: synthetic history only, no backend or model calls.
// Start Vite in its default (non-mock) mode, then:
// PERF_TOOLS=/path/to/playwright node scripts/chat-perf.mjs http://127.0.0.1:5173 [message-count]
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'

assert(process.env.PERF_TOOLS, '請將 PERF_TOOLS 設為已安裝 Playwright 的套件目錄')
const require = createRequire(join(process.env.PERF_TOOLS, 'package.json'))
const { chromium } = require('playwright-core')
const [url = 'http://127.0.0.1:5173', count = '1000'] = process.argv.slice(2)
assert(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname), '只允許本機開發伺服器')
assert(Number.isInteger(+count) && +count > 0 && +count <= 10000, '訊息數須介於 1–10000')
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  const requests = []
  await page.route('**/api/**', (route) => {
    requests.push({ url: route.request().url(), body: route.request().postDataJSON() })
    return route.fulfill({ json: {} })
  })
  await page.routeWebSocket('**/*', (socket) => socket.close())
  // Do not mount the app or its scene: measure the real chat component and production clock in isolation.
  await page.route(url, (route) => route.fulfill({ contentType: 'text/html', body: '<html><head><link rel="stylesheet" href="/src/fusion.css"><style>#test { display:flex; flex-direction:column; height:760px; width:620px; }</style></head><body><div id="test"></div></body></html>' }))
  await page.goto(url)
  await page.evaluate(async (n) => {
    const { default: RefreshRuntime } = await import('/@react-refresh')
    RefreshRuntime.injectIntoGlobalHook(window)
    window.$RefreshReg$ = () => {}
    window.$RefreshSig$ = () => (type) => type
    window.__vite_plugin_react_preamble_installed__ = true
    const { default: React } = await import('/node_modules/.vite/deps/react.js')
    const { default: { createRoot } } = await import('/node_modules/.vite/deps/react-dom_client.js')
    const { MOCK } = await import('/src/core/mode.ts')
    if (MOCK) throw Error('請使用非 mock 模式的 Vite')
    const { ChatSheet } = await import('/src/ChatSheet.tsx')
    const { useStore, useSimLoop } = await import('/src/core/store.ts')
    const { emptyWorld } = await import('/src/core/backend.ts')
    const { AIRPORT_STAFF_LOOK } = await import('/src/core/domain/sim.ts')
    const w = emptyWorld()
    w.providers.p = { id: 'p', name: 'Test', kind: 'openai', auth: { kind: 'apiKey', keyHint: '' }, baseUrl: '', models: ['gpt-5'] }
    w.chats.c = { id: 'c', teamId: '', replicaId: '', name: '', look: AIRPORT_STAFF_LOOK, model: 'gpt-5', tokens: 0, createdAt: 0,
      messages: Array.from({ length: n }, (_, i) => ({ from: i % 2 ? 'agent' : 'user', at: i, text: `訊息 ${i}\n\n這是固定的 **效能測試** 內容。\n\n- 第一項\n- 第二項` })) }
    useStore.getState().receive({ type: 'snapshot', world: w })
    const stats = window.perf = { commits: 0, renderMs: 0, worldChanges: 0, mounted: false }
    useStore.subscribe((s, p) => { if (s.world !== p.world) stats.worldChanges++ })
    const noop = () => {}
    const props = { id: 'c', teamId: '', title: React.createRef(), tid: 'chat', creating: false, crewOpen: false, image: null, chat: null, task: null, made: null,
      onCrew: noop, onFile: noop, onSkill: noop, onImage: noop, onTask: noop, onHandOff: noop, onOpenChat: noop, onOpenTask: noop, onOpenMade: noop, onProvider: noop, onGoneChat: noop }
    function View() {
      useSimLoop()
      return React.createElement(React.Profiler, { id: 'chat', onRender: (_id, _phase, ms) => { stats.commits++; stats.renderMs += ms; stats.mounted = true } }, React.createElement(ChatSheet, props))
    }
    const root = createRoot(document.getElementById('test'))
    window.showChat = (id, teamId = '') => { props.id = id; props.teamId = teamId; root.render(React.createElement(View)) }
    root.render(React.createElement(View))
  }, +count)
  await page.waitForFunction((n) => window.perf?.mounted, null, { timeout: 120000 })
  await page.waitForTimeout(1000)
  await page.evaluate(() => Object.assign(window.perf, { commits: 0, renderMs: 0, worldChanges: 0 }))
  const session = await page.context().newCDPSession(page)
  await session.send('Performance.enable')
  const before = await session.send('Performance.getMetrics')
  await page.waitForTimeout(3000)
  const after = await session.send('Performance.getMetrics')
  const stats = await page.evaluate(() => ({ ...window.perf, messages: document.querySelectorAll('.fx-chat-msg').length }))
  const metric = (sample, name) => sample.metrics.find((m) => m.name === name)?.value ?? 0
  console.log(JSON.stringify({ 訊息數: stats.messages, 閒置秒數: 3, 對話提交次數: stats.commits, React繪製毫秒: Math.round(stats.renderMs), 世界更新次數: stats.worldChanges,
    主執行緒工作毫秒: Math.round((metric(after, 'TaskDuration') - metric(before, 'TaskDuration')) * 1000), JS堆積MiB: +(metric(after, 'JSHeapUsedSize') / 1048576).toFixed(1) }, null, 2))
  assert.deepEqual(errors, [], '頁面不應發生錯誤')
  assert.equal(stats.messages, Math.min(100, +count), '首次只繪製最新 100 則')
  assert.equal(stats.worldChanges, 0, '閒置時不應更新 world')
  assert.equal(stats.commits, 0, '閒置時不應重繪對話')

  // Actions on a sliced history must send the original index, not the displayed row number.
  if (+count > 100) {
    const row = page.locator('.fx-chat-user').first()
    const original = Number(await row.getAttribute('data-message-index'))
    assert(original >= +count - 100)
    await row.getByRole('button', { name: '編輯這則訊息', exact: true }).click()
    assert.equal(requests.find((r) => r.url.endsWith('/rewind'))?.body.index, original)
    assert((await page.getByRole('combobox', { name: '訊息', exact: true }).inputValue()).startsWith(`訊息 ${original}\n`))
    await row.getByRole('button', { name: '從這則訊息複製出新對話', exact: true }).click()
    await page.waitForTimeout(100)
    assert.equal(requests.find((r) => new URL(r.url).pathname.endsWith('/handoff'))?.body.index, original)
  }

  // Exercise the real sheet after idling: local input, incoming stream, then its persisted message and unread state.
  await page.getByRole('combobox', { name: '訊息', exact: true }).fill('保留的草稿')
  await page.evaluate(async () => {
    const { useStore } = await import('/src/core/store.ts')
    const c = useStore.getState().world.chats.c
    useStore.getState().receive({ type: 'patch', upserts: [{ kind: 'chat', id: 'c', data: { ...c, replyAt: Date.now() / 1000 } }] })
    useStore.getState().receive({ type: 'delta', subId: 'c', text: '串流驗證文字' })
  })
  await page.getByText('串流驗證文字', { exact: true }).waitFor()
  await page.evaluate(async () => {
    const { useStore } = await import('/src/core/store.ts')
    const c = useStore.getState().world.chats.c
    useStore.getState().receive({ type: 'patch', upserts: [{ kind: 'chat', id: 'c', data: { ...c, replyAt: undefined, unread: true,
      messages: [...c.messages, { from: 'agent', text: '串流驗證文字', at: Date.now() / 1000 }] } }] })
  })
  await page.waitForFunction((n) => document.querySelectorAll('.fx-chat-msg').length === Math.min(100, n) + 1 && !document.querySelector('.fx-chat-writing'), +count)
  assert.equal(await page.getByRole('combobox', { name: '訊息', exact: true }).inputValue(), '保留的草稿')
  assert.deepEqual(errors, [], '頁面不應發生錯誤')
  if (+count > 100) {
    const more = page.getByRole('button', { name: '顯示更早訊息', exact: true })
    await more.focus()
    const first = page.locator('.fx-chat-msg').first()
    const text = await first.locator('.fx-md').innerText()
    const beforeTop = await first.evaluate((el) => el.getBoundingClientRect().top)
    await more.press('Enter')
    await page.waitForFunction((n) => document.querySelectorAll('.fx-chat-msg').length === Math.min(200, n) + 1, +count)
    const afterTop = await page.locator('.fx-chat-msg').filter({ has: page.locator('.fx-md', { hasText: text }) }).first().evaluate((el) => el.getBoundingClientRect().top)
    assert(Math.abs(afterTop - beforeTop) < 2, `展開後閱讀位置偏移 ${afterTop - beforeTop}px`)
    let shown = Math.min(200, +count)
    while (shown < +count) {
      await more.click()
      shown = Math.min(shown + 100, +count)
      await page.waitForFunction((n) => document.querySelectorAll('.fx-chat-msg').length === n + 1, shown)
    }
    assert.equal(await more.count(), 0)
    assert((await page.locator('.fx-chat-msg').first().innerText()).includes('訊息 0'))
  }
  // Switching sheets resets the window, and a rewind past its start must not leave an empty log.
  await page.evaluate(async () => {
    const { useStore } = await import('/src/core/store.ts')
    const c = useStore.getState().world.chats.c
    useStore.getState().receive({ type: 'patch', upserts: [{ kind: 'chat', id: 'other', data: { ...c, id: 'other' } }] })
    window.showChat('other')
  })
  await page.waitForFunction((n) => document.querySelectorAll('.fx-chat-msg').length === Math.min(100, n + 1), +count)
  await page.evaluate(async () => {
    const { useStore } = await import('/src/core/store.ts')
    const c = useStore.getState().world.chats.other
    useStore.getState().receive({ type: 'patch', upserts: [{ kind: 'chat', id: 'other', data: { ...c, messages: c.messages.slice(0, 3) } }] })
  })
  await page.waitForFunction((n) => document.querySelectorAll('.fx-chat-msg').length === Math.min(3, n + 1), +count)
  assert.equal(await page.getByRole('button', { name: '顯示更早訊息', exact: true }).count(), 0)
  // A page can start with a tool or compaction marker, not just a text bubble.
  await page.evaluate(async () => {
    const { useStore } = await import('/src/core/store.ts')
    const c = useStore.getState().world.chats.c
    useStore.getState().receive({ type: 'patch', upserts: [{ kind: 'chat', id: 'tools', data: { ...c, id: 'tools',
      messages: Array.from({ length: 205 }, (_, i) => ({ from: 'tool', text: i === 105 ? 'auto_compact' : `read_file ${i}`, at: i })),
      joins: [{ before: 105, replicaId: 'guest', name: '測試來賓' }],
      handoffs: [{ before: 105, replicaId: '', name: '測試交接者' }] } }] })
    window.showChat('tools')
  })
  await page.waitForFunction(() => document.querySelectorAll('[data-message-index]').length === 100)
  assert.equal(await page.locator('[data-message-index]').first().getAttribute('data-message-index'), '105')
  assert.equal(await page.getByText('測試來賓 加入對話', { exact: true }).count(), 1)
  assert.equal(await page.getByText('已整理較早的對話', { exact: true }).count(), 1)
  const more = page.getByRole('button', { name: '顯示更早訊息', exact: true })
  await more.focus()
  const marker = page.locator('[data-message-index="105"]')
  const top = await marker.evaluate((el) => el.getBoundingClientRect().top)
  await more.press('Enter')
  await page.waitForFunction(() => document.querySelectorAll('[data-message-index]').length === 200)
  assert(Math.abs(await marker.evaluate((el) => el.getBoundingClientRect().top) - top) < 2)
  await more.click()
  await page.waitForFunction(() => document.querySelectorAll('[data-message-index]').length === 205)
  assert.equal(await page.getByText('測試來賓 加入對話', { exact: true }).count(), 1)
  await page.evaluate(async () => {
    const { useStore } = await import('/src/core/store.ts')
    const c = useStore.getState().world.chats.tools
    useStore.getState().receive({ type: 'patch', upserts: [{ kind: 'chat', id: 'tools', data: { ...c, messages: [], joins: [], handoffs: [] } }] })
  })
  await page.waitForFunction(() => !document.querySelector('[data-message-index]'))
  assert.equal(await more.count(), 0)
  // The first visible message in a meeting still needs its speaker, even midway through a turn.
  await page.evaluate(async () => {
    const { useStore } = await import('/src/core/store.ts')
    const c = useStore.getState().world.chats.c
    useStore.getState().receive({ type: 'patch', upserts: [{ kind: 'chat', id: 'meeting', data: { ...c, id: 'meeting', teamId: 't', replicaId: 'chair', name: '主持員工',
      guests: [{ replicaId: 'guest', name: '來賓員工', look: c.look, model: c.model }],
      messages: Array.from({ length: 150 }, (_, i) => ({ from: 'agent', by: 'guest', text: `會議 ${i}`, at: i })) } }] })
    window.showChat('meeting', 't')
  })
  await page.waitForFunction(() => document.querySelector('[data-message-index="50"]'))
  assert.equal(await page.locator('.fx-room-speaker').count(), 1)
  assert((await page.locator('.fx-room-speaker').innerText()).includes('來賓員工'))
  await more.click()
  await page.waitForFunction(() => document.querySelectorAll('[data-message-index]').length === 150)
  assert.equal(await page.locator('.fx-room-speaker').count(), 1)
  // Exercise the actual paged wire contract, not only the legacy/full-history fallback above.
  const pageRequests = []
  let pageVersion = 'p1'
  let pageCount = 250
  await page.route('**/chats/paged/messages?**', async (route) => {
    const u = new URL(route.request().url())
    pageRequests.push(u)
    if (u.searchParams.get('version') !== pageVersion) return route.fulfill({ status: 409, json: { error: { code: 'conflict', message: 'changed' } } })
    const before = Number(u.searchParams.get('before'))
    const start = Math.max(0, before - Number(u.searchParams.get('limit')))
    await route.fulfill({ json: { version: pageVersion, total: pageCount, start,
      messages: Array.from({ length: before - start }, (_, i) => ({ from: (start + i) % 2 ? 'agent' : 'user', at: start + i, text: `分頁 ${start + i}` })), handoffs: [], joins: [] } })
  })
  await page.evaluate(async () => {
    const { useStore } = await import('/src/core/store.ts')
    const c = useStore.getState().world.chats.c
    useStore.getState().receive({ type: 'patch', upserts: [{ kind: 'chat', id: 'paged', data: { ...c, id: 'paged', messages: [], history: {
      version: 'p1', count: 250, changedFrom: 0, preview: 'first', sortAt: 0, hasAttachment: false, hasFileMention: false,
    } } }] })
    window.showChat('paged')
  })
  await page.waitForFunction(() => document.querySelector('[data-message-index="150"]') && document.querySelectorAll('[data-message-index]').length === 100)
  assert.equal(pageRequests.length, 1)
  await more.focus()
  const pagedAnchor = page.locator('[data-message-index="150"]')
  const pagedTop = await pagedAnchor.evaluate((el) => el.getBoundingClientRect().top)
  await more.press('Enter')
  await page.waitForFunction(() => document.querySelectorAll('[data-message-index]').length === 200)
  assert(Math.abs(await pagedAnchor.evaluate((el) => el.getBoundingClientRect().top) - pagedTop) < 2, '非同步展開後應保留閱讀位置')
  pageVersion = 'p2'; pageCount = 251
  await page.evaluate(async () => {
    const { useStore } = await import('/src/core/store.ts')
    const c = useStore.getState().world.chats.paged
    useStore.getState().receive({ type: 'patch', upserts: [{ kind: 'chat', id: c.id, data: { ...c, history: { ...c.history, version: 'p2', previous: 'p1', changedFrom: 250, count: 251 } } }] })
  })
  await page.waitForFunction(() => document.querySelectorAll('[data-message-index]').length === 201)
  assert.equal(pageRequests.at(-1).searchParams.get('limit'), '1')
  assert.equal(await page.evaluate(async () => (await import('/src/core/store.ts')).useStore.getState().world.chats.paged.messages.length), 0)
  await page.evaluate(() => window.showChat('other'))
  await page.waitForFunction(() => !document.querySelector('[data-message-index="250"]'))
  await page.evaluate(() => window.showChat('paged'))
  await page.waitForFunction(() => document.querySelector('[data-message-index="250"]') && document.querySelectorAll('[data-message-index]').length === 100)
  assert.equal(pageRequests.at(-1).searchParams.get('limit'), '100')
  assert.deepEqual(errors, [], '頁面不應發生錯誤')
  console.log('對話操作通過：分頁協定、增量讀取、釋放後重開、捲動位置及舊格式操作。')
} finally { await browser.close() }
