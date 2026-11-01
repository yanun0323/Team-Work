import { describe, expect, it, vi } from 'vitest'
import { FULL_INTRO, introFor, nextIntro, SHORT_INTRO } from './boot'

const storage = (value: string | null = null) => ({ getItem: vi.fn(() => value), setItem: vi.fn() })

describe('introFor', () => {
  it('plays the whole landing once, then the short one', () => {
    expect(introFor(false, false)).toBe(FULL_INTRO)
    expect(introFor(true, false)).toBe(SHORT_INTRO)
  })

  it('does not move the camera when motion is reduced', () => {
    expect(introFor(false, true)).toBeNull()
    expect(introFor(true, true)).toBeNull()
  })
})

describe('nextIntro', () => {
  it('remembers that the first landing has played', () => {
    const first = storage()
    expect(nextIntro(first, false)).toBe(FULL_INTRO)
    expect(first.setItem).toHaveBeenCalledOnce()
    expect(nextIntro(storage('1'), false)).toBe(SHORT_INTRO)
  })

  it('still starts when storage is unavailable', () => {
    const broken = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } }
    expect(nextIntro(broken, false)).toBe(FULL_INTRO)
  })
})
