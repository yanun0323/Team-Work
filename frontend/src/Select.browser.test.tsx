// The pick-list as the macOS app draws it, in WebKit: a long list opens with a filter that takes the keys.
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import './fusion.css'
import { FILTER_FROM, Select } from './Controls'

const MODELS = ['claude-opus-4', 'claude-sonnet-4', 'claude-haiku-4', 'gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'o3', 'o4-mini',
  'gemini-2.5-pro', 'gemini-2.5-flash', 'deepseek-chat', 'qwen3-coder']

let root: Root | null = null
let box: HTMLDivElement | null = null
let picks: string[] = []

function Pick({ options, several }: { options: string[]; several?: boolean }) {
  const [value, setValue] = useState(options[0])
  const [many, setMany] = useState<string[]>([])
  return (
    <Select
      label="模型" value={value} options={options}
      picked={several ? (o) => many.includes(o) : undefined}
      onChange={(v) => {
        picks.push(v)
        if (several) setMany((m) => (m.includes(v) ? m.filter((x) => x !== v) : [...m, v]))
        else setValue(v)
      }}
    />
  )
}

async function draw(options: string[], several?: boolean) {
  box = document.createElement('div')
  document.body.append(box)
  root = createRoot(box)
  await act(async () => root!.render(<Pick options={options} several={several} />))
}

const button = () => box!.querySelector<HTMLButtonElement>('button[role="combobox"]')!
const filter = () => box!.querySelector<HTMLInputElement>('input[role="combobox"]')
const rows = () => [...box!.querySelectorAll<HTMLLIElement>('[role="option"]')].map((li) => li.textContent)
const active = () => box!.querySelector('[role="option"].active')?.textContent

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

it('opens a long list with the focus in its filter, and narrows it to every word typed', async () => {
  expect(MODELS.length).toBeGreaterThan(FILTER_FROM)
  await draw(MODELS)
  await userEvent.click(button())
  expect(document.activeElement).toBe(filter())
  expect(rows()).toHaveLength(MODELS.length)

  await userEvent.keyboard('GPT 5 m')
  expect(rows()).toEqual(['gpt-5-mini'])
  await userEvent.clear(filter()!)
  await userEvent.keyboard('zzz')
  expect(rows()).toEqual([])
  expect(box!.textContent).toContain('沒有符合的項目')
})

it('moves through what is left with the arrows and picks with Enter, back on the button', async () => {
  await draw(MODELS)
  await userEvent.click(button())
  await userEvent.keyboard('gemini')
  expect(active()).toBe('gemini-2.5-pro')
  await userEvent.keyboard('{ArrowDown}')
  expect(active()).toBe('gemini-2.5-flash')
  await userEvent.keyboard('{ArrowDown}')
  expect(active()).toBe('gemini-2.5-flash')
  await userEvent.keyboard('{Enter}')
  expect(picks).toEqual(['gemini-2.5-flash'])
  expect(filter()).toBeNull()
  expect(document.activeElement).toBe(button())
  expect(button().textContent).toContain('gemini-2.5-flash')
})

it('empties the filter on the first Escape and closes on the second, without letting it out', async () => {
  await draw(MODELS)
  const outside = vi.fn()
  const escape = (e: KeyboardEvent) => e.key === 'Escape' && outside()
  document.addEventListener('keydown', escape)
  try {
    await userEvent.click(button())
    await userEvent.keyboard('o3{Escape}')
    expect(filter()?.value).toBe('')
    expect(rows()).toHaveLength(MODELS.length)
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
  await draw(MODELS)
  await userEvent.click(button())
  await act(async () => {
    filter()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true }))
  })
  expect(picks).toEqual([])
  expect(filter()).not.toBeNull()
})

it('opens with the letter typed on the closed list already in its filter', async () => {
  await draw(MODELS)
  button().focus()
  await userEvent.keyboard('q')
  expect(filter()?.value).toBe('q')
  expect(rows()).toEqual(['qwen3-coder'])
})

it('stays open on a list of several, picking from what the filter leaves', async () => {
  await draw(MODELS, true)
  await userEvent.click(button())
  await userEvent.keyboard('claude{Enter}{ArrowDown}{Enter}')
  expect(picks).toEqual(['claude-opus-4', 'claude-sonnet-4'])
  expect(filter()).not.toBeNull()
})

it('keeps a short list as it was, with no filter', async () => {
  await draw(['low', 'medium', 'high'])
  button().focus()
  await userEvent.keyboard('{ArrowDown}')
  expect(rows()).toEqual(['low', 'medium', 'high'])
  expect(filter()).toBeNull()
  expect(document.activeElement).toBe(button())
  await userEvent.keyboard('h')
  expect(active()).toBe('high')
})
