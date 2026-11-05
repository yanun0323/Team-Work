// What the Mac's modifier combinations do in a company terminal, for the ones xterm.js leaves out or sends in a
// form a stock shell ignores. Sequences follow the "natural text editing" preset of iTerm2.

import { composing } from './ime'

export type TerminalAction = 'clear' | 'scrollTop' | 'scrollBottom'

const KEYS: Record<string, { send: string } | { run: TerminalAction }> = {
  // a newline in the command being typed, and in programs that take it as Alt+Enter
  'shift+Enter': { send: '\x1b\r' },
  // a word at a time
  'alt+ArrowLeft': { send: '\x1bb' },
  'alt+ArrowRight': { send: '\x1bf' },
  'alt+Delete': { send: '\x1bd' },
  // the whole line
  'meta+ArrowLeft': { send: '\x01' },
  'meta+ArrowRight': { send: '\x05' },
  'meta+Backspace': { send: '\x15' },
  'meta+Delete': { send: '\x0b' },
  // the screen, which the shell has no part in
  'meta+k': { run: 'clear' },
  'meta+ArrowUp': { run: 'scrollTop' },
  'meta+ArrowDown': { run: 'scrollBottom' },
}

type Combo = Pick<KeyboardEvent, 'key' | 'shiftKey' | 'altKey' | 'metaKey' | 'ctrlKey' | 'isComposing' | 'keyCode'>

/** What this key combination does, or undefined to let xterm.js and the browser have it. */
export function terminalKey(e: Combo) {
  // a shift held while picking a candidate belongs to the input method
  if (composing(e) || e.ctrlKey) return undefined
  const held = [e.shiftKey && 'shift', e.altKey && 'alt', e.metaKey && 'meta'].filter(Boolean)
  if (held.length !== 1) return undefined
  return KEYS[`${held[0]}+${e.key}`]
}

type Typed = Pick<KeyboardEvent, 'key' | 'altKey' | 'metaKey' | 'ctrlKey' | 'isComposing'>

/**
 * Whether a key pressed outside the terminal, with its tab showing, should move the keyboard into it: text
 * being typed, while nothing focused wants that text or, for Space, its own press. Only text moves it, so Tab,
 * Esc and the arrows keep working on the page.
 */
export function typesIntoTerminal(e: Typed, focused: Pick<Element, 'closest'> | null) {
  // 'Process' is an input method taking the key
  if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing || (e.key.length !== 1 && e.key !== 'Process')) return false
  if (focused?.closest('input, textarea, select, [contenteditable], [role="listbox"], [role="menu"], [role="combobox"]')) return false
  return !(e.key === ' ' && focused?.closest('button, a, summary'))
}
