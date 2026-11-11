import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { asksToLeave, boxKey, controlBefore, MentionBox, tabIndents } from './MentionBox'

const noop = () => {}
const box = (props: Partial<Parameters<typeof MentionBox>[0]>) => renderToStaticMarkup(
  <MentionBox box={{ current: null }} value="" teamId="" label="訊息" onChange={noop} {...props} />,
)

const press = (key: string, holds: Partial<Record<'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey', boolean>> = {}) => ({ key, ...holds })
// a box with someone to send to and no list open, unless a test says otherwise
const at = (list = false, send = true) => ({ list, send })

describe('boxKey', () => {
  it('leaves a draft for the controls around the box when Esc is pressed, keeping the draft and the sheet', () => {
    expect(boxKey(press('Escape'), '寫到一半', at())).toBe('leave')
    // a box with nothing in it lets Esc through, as before: the sheet closes
    expect(boxKey(press('Escape'), '', at())).toBe('pass')
    // an open list takes the first Esc, and the box the second
    expect(boxKey(press('Escape'), '@Iv', at(true))).toBe('close-list')
  })

  it('keeps Tab indenting while there is a draft, and lets it move the focus out of an empty box', () => {
    expect(boxKey(press('Tab'), 'a', at())).toBe('indent')
    expect(boxKey(press('Tab', { shiftKey: true }), 'a\nb', at())).toBe('outdent')
    expect(boxKey(press('Tab'), '', at())).toBe('pass')
    expect(boxKey(press('Tab', { shiftKey: true }), '', at())).toBe('pass')
    // a browser key, or the system's own, is not ours to take
    expect(boxKey(press('Tab', { ctrlKey: true }), 'a', at())).toBe('pass')
    expect(boxKey(press('Tab', { altKey: true }), 'a', at())).toBe('pass')
    expect(boxKey(press('Tab', { metaKey: true }), 'a', at())).toBe('pass')
    expect(boxKey(press('Tab'), 'a', at(true))).toBe('pick')
  })

  it('sends on Enter, picks from an open list first, and keeps Shift+Enter a new line', () => {
    expect(boxKey(press('Enter'), 'go', at())).toBe('send')
    expect(boxKey(press('Enter', { shiftKey: true }), 'go', at())).toBe('pass')
    expect(boxKey(press('Enter'), 'go', at(false, false))).toBe('pass')
    expect(boxKey(press('Enter'), '@Iv', at(true))).toBe('pick')
  })

  it('asks nothing of Tab or Esc in a plain field that does not send', () => {
    // a title or a description is not a draft to leave: Esc goes on to close the sheet, as before
    expect(boxKey(press('Escape'), 'a description', at(false, false))).toBe('pass')
    expect(boxKey(press('Escape'), 'a description', at(true, false))).toBe('close-list')
    expect(tabIndents('')).toBe(false)
    expect(tabIndents('a')).toBe(true)
  })
})

describe('controlBefore', () => {
  const made = (props: { sr?: boolean; shown?: boolean; tabIndex?: number } = {}) => ({
    tabIndex: props.tabIndex ?? 0,
    closest: (sel: string) => (sel === '.fx-sr' && props.sr ? {} : null),
    getClientRects: () => (props.shown === false ? [] : [{}]),
  })
  const withDoc = <T extends object>(el: T, list: object[]) => Object.assign(el, { ownerDocument: { querySelectorAll: () => list } }) as unknown as HTMLElement

  it('finds the control Tab would reach before the box, skipping what only a screen reader sees or cannot be reached', () => {
    const sr = made({ sr: true })
    const skipped = made({ tabIndex: -1 })
    const gone = made({ shown: false })
    const attach = made()
    const field = made()
    expect(controlBefore(withDoc(field, [sr, skipped, gone, attach, field, made()]))).toBe(attach)
    // nothing of the keyboard's before it: null, so the box blurs instead of the focus going nowhere
    expect(controlBefore(withDoc(field, [field, made()]))).toBeNull()
    expect(controlBefore(null)).toBeNull()
  })
})

describe('a box holding a draft', () => {
  it('keeps Esc away from the sheet under it, so the draft and the sheet both stay', () => {
    expect(box({ value: '寫到一半', onSend: noop })).toContain('data-esc="box"')
    // nothing to leave with nothing written, and a field that is not sent is none of Esc's business
    expect(box({ value: '', onSend: noop })).not.toContain('data-esc')
    expect(box({ value: 'a description' })).not.toContain('data-esc')
    // the hint under the box comes with the focus, so nothing is said before there are words to keep
    expect(box({ value: '寫到一半', onSend: noop })).not.toContain('fx-box-hint')
  })

  it('says, while a draft is being written, that Esc is the way out', () => {
    const told = (value: string, focused = true, list = false, send = true) => asksToLeave(value, { focused, list, send })
    expect(told('寫到一半')).toBe(true)
    // not before the box is written in, not with nothing written, not while a list takes Esc first, and not by a field
    // that is not sent
    expect(told('寫到一半', false)).toBe(false)
    expect(told('')).toBe(false)
    expect(told('寫到一半', true, true)).toBe(false)
    expect(told('寫到一半', true, false, false)).toBe(false)
  })
})
