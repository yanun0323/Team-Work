import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { Select, Switcher } from './Controls'
import { unhidden } from './core/model'
import { useStore } from './core/store'
import { lastFlowId } from './draft'
import { usePrefs } from './prefs'

it('shows the picked value its own way when closed', () => {
  const html = renderToStaticMarkup(<Select label="員工" value="a" options={['a']} shownAs={() => <i>Mira</i>} onChange={() => {}} />)
  expect(html).toContain('<i>Mira</i>')
  expect(html).not.toContain('role="listbox"')
})

it('lays every choice out in view, with the current one checked', () => {
  const html = renderToStaticMarkup(<Switcher label="來源" value="b" options={['a', 'b']} labelOf={(o) => o.toUpperCase()} onChange={() => {}} />)
  expect(html).toContain('role="radiogroup"')
  expect(html.match(/type="radio"/g)).toHaveLength(2)
  expect(html.match(/checked=""/g)).toHaveLength(1)
  expect(html.indexOf('checked=""')).toBeGreaterThan(html.indexOf('>A<'))
  expect(html).not.toContain('role="combobox"')
})

it('starts a new task on a flow that is not hidden', () => {
  const w = useStore.getState().world
  const teamId = Object.keys(w.teams)[0]
  const first = lastFlowId(w, teamId)
  usePrefs.setState({ hiddenWorkflows: [first] })
  try {
    const next = lastFlowId(w, teamId)
    expect(next).not.toBe('')
    expect(next).not.toBe(first)
  } finally {
    usePrefs.setState({ hiddenWorkflows: [] })
  }
})

it('takes hidden ones out of a list to pick from', () => {
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  expect(unhidden(list, ['a', 'b'])).toEqual([{ id: 'c' }])
  expect(unhidden(list, ['a', 'b'], 'b')).toEqual([{ id: 'b' }, { id: 'c' }])
})
