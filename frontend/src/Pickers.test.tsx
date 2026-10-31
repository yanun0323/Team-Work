import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { Select } from './Controls'

it('shows the picked value its own way when closed', () => {
  const html = renderToStaticMarkup(<Select label="員工" value="a" options={['a']} shownAs={() => <i>Mira</i>} onChange={() => {}} />)
  expect(html).toContain('<i>Mira</i>')
  expect(html).not.toContain('role="listbox"')
})
