// The 交給… menu as the macOS app draws it, in WebKit: a company too big to scan opens it with a filter that takes the keys.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import './fusion.css'
import { FILTER_FROM } from './Controls'
import type { Replica } from './core/domain/types'
import { useStore } from './core/store'
import { HandOffMenu } from './HandOffMenu'

const NAMES = ['Ivy', 'Mira', 'Theo', 'Nova', 'Iris', 'Otto', 'Luca', 'Ada', 'Kai', 'Zoe', 'Remy', 'Ines']

let root: Root | null = null
let box: HTMLDivElement | null = null
let picks: string[] = []

const crewOf = (names: string[]): Replica[] => {
  const one = Object.values(useStore.getState().world.replicas)[0]
  return names.map((name) => ({ ...one, id: `r-${name}`, name }))
}

async function draw(names: string[]) {
  box = document.createElement('div')
  document.body.append(box)
  root = createRoot(box)
  await act(async () => root!.render(<HandOffMenu crew={crewOf(names)} onPick={(id) => picks.push(id)} />))
}

const button = () => box!.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!
const filter = () => box!.querySelector<HTMLInputElement>('input[role="combobox"]')
const rows = () => [...box!.querySelectorAll('[role="menuitem"] .fx-crew-name')].map((n) => n.textContent)
const active = () => box!.querySelector('[role="menuitem"].active .fx-crew-name')?.textContent

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  picks = []
})

afterEach(async () => {
  await act(async () => root?.unmount())
  box?.remove()
  root = null
  box = null
})

it('opens a big company with the focus in its filter, and narrows it by name', async () => {
  expect(NAMES.length).toBeGreaterThan(FILTER_FROM)
  await draw(NAMES)
  await userEvent.click(button())
  expect(document.activeElement).toBe(filter())
  expect(rows()).toHaveLength(NAMES.length)
  await userEvent.keyboard('I')
  expect(rows()).toEqual(['Ivy', 'Mira', 'Iris', 'Kai', 'Ines'])
  await userEvent.keyboard('zzz')
  expect(rows()).toEqual([])
  expect(box!.textContent).toContain('沒有符合的項目')
})

it('moves through who is left with the arrows, round the ends, and hands off with Enter', async () => {
  await draw(NAMES)
  await userEvent.click(button())
  await userEvent.keyboard('ir')
  expect(rows()).toEqual(['Mira', 'Iris'])
  expect(active()).toBe('Mira')
  await userEvent.keyboard('{ArrowDown}')
  expect(active()).toBe('Iris')
  await userEvent.keyboard('{ArrowDown}')
  expect(active()).toBe('Mira')
  await userEvent.keyboard('{ArrowUp}{Enter}')
  expect(picks).toEqual(['r-Iris'])
  expect(filter()).toBeNull()
})

it('empties the filter on the first Escape and closes on the second, without letting it out', async () => {
  await draw(NAMES)
  const outside = vi.fn()
  const escape = (e: KeyboardEvent) => e.key === 'Escape' && outside()
  document.addEventListener('keydown', escape)
  try {
    await userEvent.click(button())
    await userEvent.keyboard('kai{Escape}')
    expect(filter()?.value).toBe('')
    expect(rows()).toHaveLength(NAMES.length)
    await userEvent.keyboard('{Escape}')
    expect(filter()).toBeNull()
    expect(document.activeElement).toBe(button())
    expect(picks).toEqual([])
    expect(outside).not.toHaveBeenCalled()
  } finally {
    document.removeEventListener('keydown', escape)
  }
})

it('leaves the Enter that ends a word in the input method to it', async () => {
  await draw(NAMES)
  await userEvent.click(button())
  await act(async () => {
    filter()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true }))
  })
  expect(picks).toEqual([])
  expect(filter()).not.toBeNull()
})

it('hands off with a click on someone the filter left', async () => {
  await draw(NAMES)
  await userEvent.click(button())
  await userEvent.keyboard('o')
  const theo = [...box!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((b) => b.textContent?.includes('Theo'))!
  await userEvent.click(theo)
  expect(picks).toEqual(['r-Theo'])
})

it('keeps a small company as it was, with no filter and the focus on the first one', async () => {
  await draw(NAMES.slice(0, 3))
  await userEvent.click(button())
  expect(filter()).toBeNull()
  const first = box!.querySelector('[role="menuitem"]')
  expect(document.activeElement).toBe(first)
  await userEvent.keyboard('{ArrowDown}{Enter}')
  expect(picks).toEqual(['r-Mira'])
})
