import { expect, it } from 'vitest'
import { terminalKey, typesIntoTerminal } from './terminalKeys'

const press = (key: string, held: { shift?: boolean; alt?: boolean; meta?: boolean; ctrl?: boolean; composing?: boolean; keyCode?: number } = {}) => terminalKey({
  key, shiftKey: !!held.shift, altKey: !!held.alt, metaKey: !!held.meta, ctrlKey: !!held.ctrl, isComposing: !!held.composing,
  keyCode: held.keyCode ?? 0,
})

it('sends what a shell understands for the Mac editing combinations', () => {
  expect(press('Enter', { shift: true })).toEqual({ send: '\x1b\r' })
  expect(press('ArrowLeft', { alt: true })).toEqual({ send: '\x1bb' })
  expect(press('ArrowRight', { alt: true })).toEqual({ send: '\x1bf' })
  expect(press('Delete', { alt: true })).toEqual({ send: '\x1bd' })
  expect(press('ArrowLeft', { meta: true })).toEqual({ send: '\x01' })
  expect(press('ArrowRight', { meta: true })).toEqual({ send: '\x05' })
  expect(press('Backspace', { meta: true })).toEqual({ send: '\x15' })
  expect(press('Delete', { meta: true })).toEqual({ send: '\x0b' })
})

it('handles the screen itself for the Command combinations that have no shell meaning', () => {
  expect(press('k', { meta: true })).toEqual({ run: 'clear' })
  expect(press('ArrowUp', { meta: true })).toEqual({ run: 'scrollTop' })
  expect(press('ArrowDown', { meta: true })).toEqual({ run: 'scrollBottom' })
})

it('leaves everything else to xterm.js and the browser', () => {
  expect(press('Enter')).toBeUndefined()
  expect(press('ArrowLeft')).toBeUndefined()
  expect(press('ArrowLeft', { shift: true })).toBeUndefined()
  expect(press('c', { meta: true })).toBeUndefined()
  expect(press('v', { meta: true })).toBeUndefined()
  expect(press('ArrowLeft', { meta: true, shift: true })).toBeUndefined()
  expect(press('ArrowLeft', { alt: true, ctrl: true })).toBeUndefined()
  expect(press('Enter', { shift: true, composing: true })).toBeUndefined()
})

it('leaves the key that ends a composition to the input method, though WebKit already reports it as not composing', () => {
  expect(press('Enter', { shift: true, keyCode: 229 })).toBeUndefined()
  expect(press('ArrowLeft', { alt: true, keyCode: 229 })).toBeUndefined()
})

it('moves the keyboard into the terminal for text typed where nothing else wants it', () => {
  const key = (k: string, held: { ctrl?: boolean; alt?: boolean; meta?: boolean; composing?: boolean } = {}) => ({
    key: k, ctrlKey: !!held.ctrl, altKey: !!held.alt, metaKey: !!held.meta, isComposing: !!held.composing,
  })
  /** An element matching the selectors that hold any of these words. */
  const on = (...words: string[]) => ({ closest: (selector: string) => (words.some((w) => selector.includes(w)) ? ({} as Element) : null) })
  expect(typesIntoTerminal(key('a'), null)).toBe(true)
  expect(typesIntoTerminal(key('a'), on())).toBe(true)
  expect(typesIntoTerminal(key('a'), on('button'))).toBe(true)
  expect(typesIntoTerminal(key('Process'), on())).toBe(true)
  expect(typesIntoTerminal(key(' '), on())).toBe(true)
  expect(typesIntoTerminal(key(' '), on('button'))).toBe(false)
  expect(typesIntoTerminal(key('a'), on('input'))).toBe(false)
  expect(typesIntoTerminal(key('a'), on('textarea'))).toBe(false)
  expect(typesIntoTerminal(key('a'), on('listbox'))).toBe(false)
  for (const held of [{ ctrl: true }, { alt: true }, { meta: true }, { composing: true }]) expect(typesIntoTerminal(key('a', held), on())).toBe(false)
  for (const named of ['Tab', 'Escape', 'Enter', 'ArrowLeft', 'F6']) expect(typesIntoTerminal(key(named), on())).toBe(false)
})
