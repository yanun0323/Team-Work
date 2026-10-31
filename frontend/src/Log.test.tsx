import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { LogList } from './DrawerDetail'

const lines = [
  { at: 60_000, kind: 'say', text: 'first' },
  { at: 120_000, kind: 'human', text: 'second' },
  { at: 180_000, kind: 'say', text: 'third' },
]
const order = (html: string) => [...html.matchAll(/first|second|third/g)].map((m) => m[0])

it('puts the newest log line first', () => {
  expect(order(renderToStaticMarkup(<LogList lines={lines} order="newestFirst" />))).toEqual(['third', 'second', 'first'])
})

it('puts the newest log line last when the preference says so', () => {
  expect(order(renderToStaticMarkup(<LogList lines={lines} order="newestLast" />))).toEqual(['first', 'second', 'third'])
})

it('renders what employees say as Markdown, and the user\'s own words as they are', () => {
  const html = renderToStaticMarkup(<LogList lines={[{ at: 0, kind: 'say', text: '**a**' }, { at: 0, kind: 'human', text: '**b**' }]} order="newestLast" />)
  expect(html).toContain('<strong>a</strong>')
  expect(html).toContain('<span>**b**</span>')
})

it('marks the user\'s own lines', () => {
  expect(renderToStaticMarkup(<LogList lines={lines} order="newestLast" />)).toContain('<strong class="fx-d-log-user">使用者</strong><span>second</span>')
})
