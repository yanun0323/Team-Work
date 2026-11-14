import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { cornersAway, TagWork } from './World'

it('spins a count of the chats and tasks under way after a name, nothing while idle, and 9+ past nine', () => {
  const tag = (chats: number, tasks: number) => renderToStaticMarkup(createElement(TagWork, { chats, tasks }))
  expect(tag(0, 0)).toBe('')
  expect(tag(1, 2)).toContain('<span aria-hidden="true">3</span>')
  expect(tag(4, 5)).toContain('<span aria-hidden="true">9</span>')
  expect(tag(4, 6)).toContain('<span aria-hidden="true">9+</span>')
  expect(tag(4, 6)).toContain('10 件工作進行中')
})

it('keeps the top left in view beside a drawer on the right, until a sheet covers the left, the help opens, or no room is left', () => {
  const none = { help: false, drawer: false, sheets: false, narrow: false }
  expect(cornersAway(none)).toEqual({ left: false, right: false })
  // a company, the airport, the tower, the staffing agency or the profile: only the right half
  expect(cornersAway({ ...none, drawer: true })).toEqual({ left: false, right: true })
  // a sheet out on the left of it
  expect(cornersAway({ ...none, drawer: true, sheets: true })).toEqual({ left: true, right: true })
  // the drawer takes up the room beside it on a narrow screen
  expect(cornersAway({ ...none, drawer: true, narrow: true })).toEqual({ left: true, right: true })
  expect(cornersAway({ ...none, narrow: true })).toEqual({ left: false, right: false })
  // the help covers everything
  expect(cornersAway({ ...none, help: true })).toEqual({ left: true, right: true })
})
