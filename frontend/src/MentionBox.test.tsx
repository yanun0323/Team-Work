import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { boxKey, MentionBox, tabIndents } from './MentionBox'

const noop = () => {}
const box = (props: Partial<Parameters<typeof MentionBox>[0]>) => renderToStaticMarkup(
  <MentionBox box={{ current: null }} value="" teamId="" label="訊息" onChange={noop} {...props} />,
)

const press = (key: string, holds: Partial<Record<'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey', boolean>> = {}) => ({ key, ...holds })
// a box with someone to send to and no list open, unless a test says otherwise
const at = (list = false, send = true) => ({ list, send })

describe('boxKey', () => {
  it('leaves Esc alone, but for an open list', () => {
    expect(boxKey(press('Escape'), '寫到一半', at())).toBe('pass')
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

describe('a box holding a draft', () => {
  it('keeps Esc away from the sheet under it, so the draft and the sheet both stay', () => {
    expect(box({ value: '寫到一半', onSend: noop })).toContain('data-esc="box"')
    // nothing to leave with nothing written, and a field that is not sent is none of Esc's business
    expect(box({ value: '', onSend: noop })).not.toContain('data-esc')
    expect(box({ value: 'a description' })).not.toContain('data-esc')
    // no hint under the box: it came and went with the focus, moving the send button out from under the click
    expect(box({ value: '寫到一半', onSend: noop })).not.toContain('fx-box-hint')
  })
})
