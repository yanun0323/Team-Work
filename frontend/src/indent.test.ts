import { describe, expect, it } from 'vitest'
import { indentLines } from './indent'

describe('indenting lines', () => {
  it('indents the line under the caret, wherever the caret is in it', () => {
    expect(indentLines('a\nbc\nd', 4, 4)).toEqual({ text: 'a\n    bc\nd', start: 8, end: 8 })
  })

  it('indents every line the selection touches, and keeps them selected', () => {
    expect(indentLines('ab\ncd\nef', 1, 4)).toEqual({ text: '    ab\n    cd\nef', start: 5, end: 12 })
  })

  it('leaves the next line alone when the selection ends right after a line break', () => {
    expect(indentLines('ab\ncd', 0, 3)).toEqual({ text: '    ab\ncd', start: 4, end: 7 })
  })

  it('outdents by up to one indent, or one tab', () => {
    expect(indentLines('      a\n b\n\tc\nd', 0, 14, true)).toEqual({ text: '  a\nb\nc\nd', start: 0, end: 8 })
  })

  it('keeps the caret in its line when outdenting from inside the indent', () => {
    expect(indentLines('x\n  y', 3, 3, true)).toEqual({ text: 'x\ny', start: 2, end: 2 })
  })
})
