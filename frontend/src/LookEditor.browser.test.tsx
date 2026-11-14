// The look editor as the macOS app draws it, in WebKit: a pick shows at once and is saved a moment later, and the
// name is saved on Enter, never while blank.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import './fusion.css'
import './core/store'
import { LookEditor, SAVE_LOOK_MS } from './LookEditor'
import { useMe } from './core/towers'

const me = { id: 'mac', name: '小安', protocol: 2 }
let root: Root | null = null
let box: HTMLDivElement | null = null

beforeEach(async () => {
  useMe.setState({ me })
  box = document.createElement('div')
  document.body.append(box)
  root = createRoot(box)
  await act(async () => root!.render(<LookEditor me={me} />))
})

afterEach(() => {
  act(() => root?.unmount())
  box?.remove()
  root = box = null
  useMe.setState({ me: null })
})

const settle = () => act(() => new Promise((done) => setTimeout(done, SAVE_LOOK_MS + 100)))
const radio = (name: string) => box!.querySelector<HTMLInputElement>(`input[type="radio"][aria-label="${name}"]`)!
const option = (text: string) => [...box!.querySelectorAll<HTMLLabelElement>('.fx-look-pick')].find((l) => l.textContent === text)!

it('saves the parts picked, each kept as the next is picked', async () => {
  await userEvent.click(radio('麻花辮'))
  expect(radio('麻花辮').checked).toBe(true)
  await userEvent.click(option('實驗袍'))
  await userEvent.click(radio('眼鏡'))
  await userEvent.click(option('靴子'))
  await userEvent.click(radio('#e85d4a'))
  await settle()
  const look = useMe.getState().me!.look!
  expect(look.parts).toMatchObject({ hair: 'braid', top: 'labcoat', shoes: 'boots', shoeColor: '#e85d4a' })
  expect(look.extra).toBe('glasses')
})

it('goes through the options of a part by the arrow keys', async () => {
  radio('短髮').focus()
  await userEvent.keyboard('{ArrowRight}')
  await settle()
  expect(useMe.getState().me!.look!.parts!.hair).toBe('long')
})

it('renames on Enter, and says so when the name is blank', async () => {
  const field = box!.querySelector<HTMLInputElement>('input.fx-control')!
  await userEvent.clear(field)
  await userEvent.type(field, '{Enter}')
  expect(box!.querySelector('[role="alert"]')?.textContent).toBe('請輸入名稱')
  expect(useMe.getState().me!.name).toBe('小安')
  await userEvent.type(field, '阿安{Enter}')
  await act(async () => {})
  expect(box!.querySelector('[role="alert"]')).toBeNull()
  expect(useMe.getState().me!.name).toBe('阿安')
})
