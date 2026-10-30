import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { version } from '../package.json'
import { useStore } from './core/store'
import { DEFAULT_PREFS, ordered } from './prefs'
import { Settings } from './Settings'

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
  expect(DEFAULT_PREFS).toEqual({ logOrder: 'newestFirst', detail: true, shadows: true, crowd: true, planes: true, clouds: true })
  expect(ordered([1, 2, 3], 'newestFirst')).toEqual([3, 2, 1])
  expect(ordered([1, 2, 3], 'newestLast')).toEqual([1, 2, 3])
})
