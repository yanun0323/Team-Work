import { renderToStaticMarkup } from 'react-dom/server'
import { tabOr, type Tab } from './DrawerTabs'
import { expect, it } from 'vitest'
import { version } from '../package.json'
import { useStore } from './core/store'
import { createAirportChat } from './core/domain/sim'
import { airportTabOr, DEFAULT_PREFS, ordered, type AirportTab, usePrefs } from './prefs'
import { AdvancedSection, ChatTitleFields, CompactSection, PrefsPage, QuitTool, Settings, ReloadSettings, ResetSettings, SystemSection } from './Settings'

it('is a drawer headed as the airport, its model providers listed under the first tab', () => {
  const html = renderToStaticMarkup(<Settings leaving={false} onGone={() => {}} />)
  expect(html).toContain('<aside id="fx-settings" class="fx-drawer"')
  expect(html).toContain('>機場</h1>')
  expect(html).toContain('>小島管理中心</p>')
  expect(html).not.toContain(`v${version}`)
  expect(html).toContain('role="tablist"')
  expect(html).toContain('id="fx-settings-tab-providers" aria-controls="fx-settings-panel" aria-selected="true"')
  expect(html).toContain('id="fx-settings-tab-blueprints" aria-controls="fx-settings-panel" aria-selected="false"')
  expect(html).toContain('id="fx-settings-tab-about" aria-controls="fx-settings-panel" aria-selected="false"')
  // the preferences sit just left of 關於
  expect(html.indexOf('id="fx-settings-tab-prefs"')).toBeGreaterThan(html.indexOf('id="fx-settings-tab-blueprints"'))
  expect(html.indexOf('id="fx-settings-tab-prefs"')).toBeLessThan(html.indexOf('id="fx-settings-tab-about"'))
  expect(html).toContain('＋ 新增模型供應商')
  const providers = Object.values(useStore.getState().world.providers)
  expect(providers.length).toBeGreaterThan(0)
  for (const p of providers) expect(html).toContain(`<b>${p.name}</b>`)
})

it('starts with every preference on and the newest log line first', () => {
  expect(DEFAULT_PREFS).toEqual({ muteInBackground: true, systemNotices: true, musicStyle: 'bossa', soundNotice: true, soundTutorial: true, soundOpenTeam: true, soundOpenAirport: true, soundWaves: true, musicVolume: 50, effectsVolume: 100, musicMuted: false, effectsMuted: false, soundTakeoff: true, soundLanding: true, soundFlyover: true, soundUI: true, logOrder: 'newestFirst', detail: true, shadows: true, crowd: true, planes: true, clouds: true, daylight: 'minecraft', keepTerminals: false, mapClick: 'sheets', autoView: 'panZoom', busyAnimation: 'money', zoomSensitivity: 100, terminalCommand: '', defaultTab: 'tasks', defaultAirportTab: 'providers', autoTab: 'chats', chatTitleModel: '', chatTitleEffort: '', imageProvider: '', codexSkills: true, claudeSkills: true, hiddenBlueprints: [], hiddenWorkflows: [], compact1M: 40, compact256K: 90, compact128K: 95, compactSmall: 95 })
  expect(ordered([1, 2, 3], 'newestFirst')).toEqual([3, 2, 1])
  expect(ordered([1, 2, 3], 'newestLast')).toEqual([1, 2, 3])
})

it('opens the airport on its chats while one waits, unless told not to', () => {
  const world = useStore.getState().world
  const html = () => renderToStaticMarkup(<Settings leaving={false} onGone={() => {}} />)
  const onChats = 'id="fx-settings-tab-chats" aria-controls="fx-settings-panel" aria-selected="true"'
  const c = createAirportChat(world, { model: 'm', effort: 'default', text: '嗨' })
  c.unread = true
  try {
    expect(html()).toContain(onChats)
    usePrefs.setState({ autoTab: 'off' })
    expect(html()).not.toContain(onChats)
  } finally {
    usePrefs.setState({ autoTab: 'chats' })
    delete world.chats[c.id]
  }
})

it('leaves the power button to the app', () => {
  expect(renderToStaticMarkup(<Settings leaving={false} onGone={() => {}} />)).not.toContain('aria-label="退出"')
  expect(renderToStaticMarkup(<QuitTool />)).toContain('aria-label="退出"')
  expect(renderToStaticMarkup(<Settings leaving={false} onGone={() => {}} />)).not.toContain('aria-label="檢查更新"')
})



it('offers a keyboard-accessible reload action with persistent announcement regions', () => {
  const html = renderToStaticMarkup(<ReloadSettings />)
  expect(html).toContain('<button type="button" class="fx-save">重新載入設定</button>')
  expect(html).toContain('<button type="button" class="fx-save">開啟設定檔資料夾</button>')
  expect(html).toContain('role="status"')
  expect(html).toContain('role="alert"')
})

it('ends the settings page with the reset button', () => {
  expect(renderToStaticMarkup(<ResetSettings />)).toContain('<button type="button" class="fx-save fx-danger">重設回預設值</button>')
  expect(renderToStaticMarkup(<PrefsPage />)).toContain('>重設回預設值</button></div></div>')
})

it('opens a company on the chosen tab, or on 任務 where that tab does not exist', () => {
  expect(tabOr('crew')).toBe('crew')
  expect(tabOr('nope' as Tab)).toBe('tasks')
})

it('opens the airport on the chosen tab, or on 模型供應商 where that tab does not exist', () => {
  expect(airportTabOr('about')).toBe('about')
  expect(airportTabOr('nope' as AirportTab)).toBe('providers')
})

it('lists the settings groups in order, with the general ones first', () => {
  const html = renderToStaticMarkup(<PrefsPage />)
  const at = (x: string) => html.indexOf(x)
  expect(at('語言')).toBeLessThan(at('預設機場頁面'))
  expect(at('預設機場頁面')).toBeLessThan(at('預設公司頁面'))
  expect(at('>一般<')).toBeLessThan(at('語言'))
  expect(at('預設公司頁面')).toBeLessThan(at('>功能<'))
  expect(at('>功能<')).toBeLessThan(at('>遊戲物件<'))
})


it('offers sound inside preferences, not as an airport tab with separate labeled volumes and effect switches', () => {
  expect(airportTabOr('sound' as AirportTab)).toBe('prefs')
  const settings = renderToStaticMarkup(<Settings leaving={false} onGone={() => {}} />)
  expect(settings).not.toContain('id="fx-settings-tab-sound"')
  const html = renderToStaticMarkup(<PrefsPage />)
  expect(html.match(/type="range"/g)).toHaveLength(3)
  for (const name of ['音樂風格', '輕快波莎', '試聽 通知', '背景音樂', '音效', '飛機音效', '介面操作']) expect(html).toContain(name)
  expect(html).toContain('aria-valuetext="100%"')
  expect(html).toContain('aria-label="試聽 飛機音效"')
  expect(html).toContain('aria-label="靜音 背景音樂"')
  expect(html).toContain('aria-label="靜音 音效"')
  expect(html.match(/aria-label="靜音 /g)).toHaveLength(2)
  for (const old of ['飛機起飛', '飛機降落', '飛機飛越']) expect(html).not.toContain(old)
})

it('merges sound into one 音樂 group that starts with muting in the background, on by default', () => {
  const html = renderToStaticMarkup(<PrefsPage />)
  expect(html).not.toContain('>聲音<')
  const group = html.indexOf('>音樂<')
  const mute = html.indexOf('背景執行時靜音')
  expect(mute).toBeGreaterThan(group)
  expect(mute).toBeLessThan(html.indexOf('音樂風格'))
  expect(html.indexOf('試聽 通知')).toBeGreaterThan(mute)
  expect(DEFAULT_PREFS.muteInBackground).toBe(true)
})

it('offers auto view in the 操作 group, panning and zooming by default', () => {
  const html = renderToStaticMarkup(<PrefsPage />)
  const at = html.indexOf('自動檢視')
  expect(at).toBeGreaterThan(html.indexOf('>操作<'))
  expect(at).toBeLessThan(html.indexOf('>功能<'))
  expect(html).toContain('位移和縮放')
  expect(DEFAULT_PREFS.autoView).toBe('panZoom')
})

it('offers zoom sensitivity under 操作, at the normal speed', () => {
  const html = renderToStaticMarkup(<PrefsPage />)
  const at = html.indexOf('縮放靈敏度')
  expect(at).toBeGreaterThan(html.indexOf('>操作<'))
  expect(at).toBeLessThan(html.indexOf('>功能<'))
  expect(html).toContain('min="20" max="300"')
})

it('offers the terminal startup command under 進階, empty by default', () => {
  const html = renderToStaticMarkup(<AdvancedSection />)
  expect(html).toContain('進階')
  expect(html).toContain('終端機預設指令')
  expect(html).toContain('value=""')
})

it('offers the global AGENTS.md under 系統, locked until the file has been read', () => {
  const html = renderToStaticMarkup(<SystemSection />)
  expect(html).toContain('>系統</h4>')
  expect(html).toContain('<span>全域員工規則</span>')
  expect(html).toMatch(/<textarea[^>]* disabled/)
  expect(html).toContain('role="alert"')
})

it('names chats only when turned on, then with a model and level of its own', () => {
  const off = renderToStaticMarkup(<ChatTitleFields model="" effort="" onChange={() => {}} />)
  expect(off).toContain('自動命名對話')
  expect(off).not.toContain('思考等級')
  const on = renderToStaticMarkup(<ChatTitleFields model="gone-model" effort="default" onChange={() => {}} />)
  expect(on).toContain('思考等級')
  // a model no provider offers any more still shows as chosen
  expect(on).toContain('gone-model')
  expect(renderToStaticMarkup(<SystemSection />)).toContain('自動命名對話')
})

it('fades a hidden blueprint in its place, with an eye on each row to hide or show it', () => {
  const set = (p: Partial<typeof DEFAULT_PREFS>) => { usePrefs.setState(p); Object.assign(usePrefs.getInitialState(), usePrefs.getState()) }
  const html = () => renderToStaticMarkup(<Settings leaving={false} onGone={() => {}} />)
  set({ defaultAirportTab: 'blueprints', autoTab: 'off' })
  try {
    const shown = html()
    const rows = shown.match(/class="fx-hidable( fx-hidden-item)?"/g)?.length ?? 0
    expect(rows).toBeGreaterThan(1)
    // the airport staff's always looks hidden, and has no eye: it cannot be hidden or shown
    expect(shown.match(/fx-hidden-item/g)).toHaveLength(1)
    expect(shown.match(/aria-pressed="false" aria-label="隱藏"/g)).toHaveLength(rows - 1)
    set({ hiddenBlueprints: ['preset-assistant'] })
    const after = html()
    // the same rows in the same order, one of them faded and its eye struck through
    expect(after.match(/class="fx-hidable( fx-hidden-item)?"/g)).toHaveLength(rows)
    expect(after.match(/fx-hidden-item/g)).toHaveLength(2)
    expect(after.match(/aria-pressed="true" aria-label="隱藏"/g)).toHaveLength(1)
    expect(after.replace(/ fx-hidden-item/, '').replace(/aria-pressed="true"/, 'aria-pressed="false"').replace(/title="取消隱藏"/, 'title="隱藏"').replace('<path d="M2.5 13.5l11-11" stroke="currentColor" stroke-width="1.5"></path>', '')).toBe(shown)
  } finally {
    set({ defaultAirportTab: 'providers', autoTab: 'chats', hiddenBlueprints: [] })
  }
})

it('sets how full a chat may get by the size of its model, and offers the defaults back once changed', () => {
  const html = () => renderToStaticMarkup(<CompactSection />)
  expect(html()).toContain('>自動整理對話</h4>')
  for (const label of ['1M+', '256K+', '128K+', '&lt; 128K']) expect(html()).toContain(`>${label}</label>`)
  expect(html()).toContain('min="10" max="100"')
  expect(html()).toContain('>40%</output>')
  expect(html()).not.toContain('恢復預設')
  // the server render reads the store's initial state
  Object.assign(usePrefs.getInitialState(), { compact1M: 60 })
  try {
    expect(html()).toContain('>60%</output>')
    expect(html()).toContain('>恢復預設</button>')
  } finally {
    Object.assign(usePrefs.getInitialState(), { compact1M: 40 })
  }
})
