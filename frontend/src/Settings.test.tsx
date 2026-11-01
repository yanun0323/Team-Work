import { renderToStaticMarkup } from 'react-dom/server'
import { tabOr, type Tab } from './DrawerTabs'
import { expect, it } from 'vitest'
import { version } from '../package.json'
import { useStore } from './core/store'
import { airportTabOr, DEFAULT_PREFS, ordered, type AirportTab } from './prefs'
import { PrefsPage, QuitTool, Settings, ReloadSettings } from './Settings'

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
  expect(DEFAULT_PREFS).toEqual({ logOrder: 'newestFirst', detail: true, shadows: true, crowd: true, planes: true, clouds: true, keepTerminals: false, defaultTab: 'tasks', defaultAirportTab: 'providers' })
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
  expect(html).toContain('role="status"')
  expect(html).toContain('role="alert"')
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
