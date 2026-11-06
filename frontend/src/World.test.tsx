import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { TagWork } from './World'

it('spins a count of the chats and tasks under way after a name, nothing while idle, and 9+ past nine', () => {
  const tag = (chats: number, tasks: number) => renderToStaticMarkup(createElement(TagWork, { chats, tasks }))
  expect(tag(0, 0)).toBe('')
  expect(tag(1, 2)).toContain('<span aria-hidden="true">3</span>')
  expect(tag(4, 5)).toContain('<span aria-hidden="true">9</span>')
  expect(tag(4, 6)).toContain('<span aria-hidden="true">9+</span>')
  expect(tag(4, 6)).toContain('10 件工作進行中')
})
