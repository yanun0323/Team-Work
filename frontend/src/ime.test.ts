import { describe, expect, it } from 'vitest'
import { composing } from './ime'

describe('composing', () => {
  it('is true while a word is being picked', () => {
    expect(composing({ isComposing: true, keyCode: 229 })).toBe(true)
  })

  it('is true for the Enter that picks the word in Safari, after compositionend', () => {
    expect(composing({ isComposing: false, keyCode: 229 })).toBe(true)
  })

  it('is false for a plain Enter', () => {
    expect(composing({ isComposing: false, keyCode: 13 })).toBe(false)
  })
})
