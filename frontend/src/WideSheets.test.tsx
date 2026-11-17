import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, it } from 'vitest'
import { usePrefs } from './prefs'
import { PrefsPage } from './Settings'
import { useUnderWide, useWideClass, WideCover, WideTool } from './WideSheets'

// renderToStaticMarkup reads the store's initial state, so keep it in step with what a test sets
const set = (wideSheets: boolean) => { usePrefs.setState({ wideSheets }); Object.assign(usePrefs.getInitialState(), usePrefs.getState()) }

afterEach(() => set(false))

function Sheet() {
  return <aside className={`fx-detail${useWideClass()}`}><WideTool /></aside>
}

it('keeps the sheets on the left half until the corner button or the setting widens them', () => {
  expect(renderToStaticMarkup(<Sheet />)).toContain('<aside class="fx-detail">')
  expect(renderToStaticMarkup(<Sheet />)).toContain('aria-pressed="false" aria-label="展開子介面"')
  set(true)
  expect(renderToStaticMarkup(<Sheet />)).toContain('<aside class="fx-detail fx-wide">')
  expect(renderToStaticMarkup(<Sheet />)).toContain('aria-pressed="true" aria-label="展開子介面"')
})

// as the drawers use it: what is on the drawer inert under the sheets, the cover over it
function Drawer({ open }: { open: boolean }) {
  const under = useUnderWide(open)
  return <aside><div className="fx-sheet" inert={under || undefined} />{under && <WideCover onClick={() => {}} />}</aside>
}

it('covers the drawer as a covered sheet, and makes what is on it inert, only while wide sheets are out', () => {
  const plain = '<aside><div class="fx-sheet"></div></aside>'
  expect(renderToStaticMarkup(<Drawer open />)).toBe(plain)
  set(true)
  expect(renderToStaticMarkup(<Drawer open={false} />)).toBe(plain)
  expect(renderToStaticMarkup(<Drawer open />)).toBe(
    '<aside><div class="fx-sheet" inert=""></div><button type="button" class="fx-detail-cover fx-wide-cover" aria-label="收起上面那張，回到這張"></button></aside>')
})

it('puts the sheets away on a click on the cover', () => {
  let away = 0
  WideCover({ onClick: () => away++ }).props.onClick()
  expect(away).toBe(1)
})

it('offers the setting under the airport preferences', () => {
  expect(renderToStaticMarkup(<PrefsPage />)).toContain('展開子介面')
})
