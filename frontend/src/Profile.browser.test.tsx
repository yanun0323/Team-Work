// The profile drawer as the macOS app draws it, in WebKit: the milestones with no tabs, and its edit button taping the
// look editor beside it, as a detail sheet, and putting it away again.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import './fusion.css'
import './core/store'
import { Profile } from './Profile'
import { useMe } from './core/towers'

const me = { id: 'mac', name: '小安', protocol: 2 }
let root: Root | null = null
let box: HTMLDivElement | null = null

beforeEach(async () => {
  useMe.setState({ me })
  box = document.createElement('div')
  document.body.append(box)
  root = createRoot(box)
  await act(async () => root!.render(<Profile leaving={false} onGone={() => {}} />))
})

afterEach(() => {
  act(() => root?.unmount())
  box?.remove()
  root = box = null
  useMe.setState({ me: null })
})

const edit = () => box!.querySelector<HTMLButtonElement>('#fx-profile .fx-head-tools button')!
const sheet = () => box!.querySelector('.fx-detail:not(.leaving)')

it('shows the milestones at once, with no tabs', async () => {
  await act(async () => new Promise((done) => setTimeout(done, 50)))
  expect(box!.querySelector('[role="tablist"]')).toBeNull()
  expect(box!.querySelector('h1')!.textContent).toBe('小安')
  expect(box!.textContent).toContain('使用天數')
  expect(sheet()).toBeNull()
})

it('opens the look editor beside it from the edit button at the end of the title, and puts it away the same way', async () => {
  const title = box!.querySelector('#fx-profile .fx-title')!.getBoundingClientRect()
  // at the far end of the title row
  expect(Math.round(title.right - edit().getBoundingClientRect().right)).toBeLessThan(2)
  expect(edit().getAttribute('aria-expanded')).toBe('false')
  await userEvent.click(edit())
  expect(sheet()?.querySelector('h2')?.textContent).toBe('編輯角色')
  expect(sheet()?.querySelector('input[aria-label="麻花辮"]')).not.toBeNull()
  expect(edit().getAttribute('aria-expanded')).toBe('true')
  // the sheet sits to the left of the drawer
  expect(sheet()!.getBoundingClientRect().left).toBeLessThan(box!.querySelector('#fx-profile')!.getBoundingClientRect().left)
  await userEvent.click(edit())
  expect(sheet()).toBeNull()
  expect(edit().getAttribute('aria-expanded')).toBe('false')
})

it('puts the look editor away on Esc, leaving the profile open', async () => {
  await userEvent.click(edit())
  expect(sheet()).not.toBeNull()
  await userEvent.keyboard('{Escape}')
  expect(sheet()).toBeNull()
  expect(box!.querySelector('#fx-profile')).not.toBeNull()
})

it('covers the profile only while the wide editor is open and returns to it from the exposed strip', async () => {
  const cover = () => box!.querySelector<HTMLButtonElement>('#fx-profile > .fx-wide-cover')
  const page = box!.querySelector<HTMLElement>('#fx-profile > .fx-sheet')!
  await userEvent.click(edit())
  expect(cover()).toBeNull()
  await userEvent.click(sheet()!.querySelector<HTMLButtonElement>('.fx-wide-tool')!)
  try {
    expect(cover()).not.toBeNull()
    expect(page.inert).toBe(true)
    const rect = cover()!.getBoundingClientRect()
    const x = rect.right - 8, y = rect.top + rect.height / 2
    expect(document.elementFromPoint(x, y)).toBe(cover())
    await userEvent.click(cover()!, { position: { x: rect.width - 8, y: rect.height / 2 } })
    expect(sheet()).toBeNull()
    expect(cover()).toBeNull()
    expect(page.inert).toBe(false)
  } finally {
    if (!sheet()) await userEvent.click(edit())
    await userEvent.click(sheet()!.querySelector<HTMLButtonElement>('.fx-wide-tool')!)
  }
})
