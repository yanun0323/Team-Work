import { renderToStaticMarkup } from 'react-dom/server'
import { tabOr, type Tab } from './DrawerTabs'
import { expect, it } from 'vitest'
import { version } from '../package.json'
import { useStore } from './core/store'
import { airportTabOr, DEFAULT_PREFS, ordered, type AirportTab } from './prefs'
import { AdvancedSection, PrefsPage, QuitTool, Settings, ReloadSettings, ResetSettings, SystemSection } from './Settings'

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
  expect(DEFAULT_PREFS).toEqual({ muteInBackground: true, musicStyle: 'bossa', soundNotice: true, musicVolume: 100, effectsVolume: 100, musicMuted: false, effectsMuted: false, soundTakeoff: true, soundLanding: true, soundFlyover: true, soundUI: true, logOrder: 'newestFirst', detail: true, shadows: true, crowd: true, planes: true, clouds: true, keepTerminals: false, autoView: 'panZoom', zoomSensitivity: 100, terminalCommand: '', defaultTab: 'tasks', defaultAirportTab: 'providers' })
  expect(ordered([1, 2, 3], 'newestFirst')).toEqual([3, 2, 1])
  expect(ordered([1, 2, 3], 'newestLast')).toEqual([1, 2, 3])
})

it('leaves the power button to the app', () => {
  expect(renderToStaticMarkup(<Settings leaving={false} onGone={() => {}} />)).not.toContain('aria-label="退出"')
  expect(renderToStaticMarkup(<QuitTool />)).toContain('aria-label="退出"')
})


it('offers a keyboard-accessible reload action with persistent announcement regions', () => {
  const html = renderToStaticMarkup(<ReloadSettings />)
  expect(html).toContain('<button type="button" class="fx-save">重新載入設定</button>')
  expect(html).toContain('<button type="button" class="fx-save">開啟設定檔資料夾</button>')
  expect(html).toContain('role="status"')
  expect(html).toContain('role="alert"')
})

it('ends the settings page with the reset button', () => {
  expect(renderToStaticMarkup(<ResetSettings />)).toContain('<button type="button" class="fx-save">重設回預設值</button>')
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
  expect(at('語言')).toBeLessThan(at('預設機場頁籤'))
  expect(at('預設機場頁籤')).toBeLessThan(at('預設公司頁籤'))
  expect(at('>一般<')).toBeLessThan(at('語言'))
  expect(at('預設公司頁籤')).toBeLessThan(at('>功能<'))
  expect(at('>功能<')).toBeLessThan(at('>遊戲物件<'))
})


it('offers sound inside preferences, not as an airport tab with separate labeled volumes and effect switches', () => {
  expect(airportTabOr('sound' as AirportTab)).toBe('prefs')
  const settings = renderToStaticMarkup(<Settings leaving={false} onGone={() => {}} />)
  expect(settings).not.toContain('id="fx-settings-tab-sound"')
  const html = renderToStaticMarkup(<PrefsPage />)
  expect(html.match(/type="range"/g)).toHaveLength(3)
  for (const name of ['音樂風格', '輕快波莎', '告示牌通知', '背景音樂', '音效', '飛機音效', '介面操作']) expect(html).toContain(name)
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
  expect(html.indexOf('告示牌通知')).toBeGreaterThan(mute)
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
  expect(html).toContain('<span>全域 AGENTS.md</span>')
  expect(html).toMatch(/<textarea[^>]* disabled/)
  expect(html).toContain('role="alert"')
})
