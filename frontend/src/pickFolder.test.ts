import { describe, expect, it } from 'vitest'
import { pickedPath } from './pickFolder'

describe('a folder picked in the file browser', () => {
  it('goes beside the folder typed, else under ~/code/', () => {
    expect(pickedPath('', 'shop')).toBe('~/code/shop')
    expect(pickedPath('my-app', 'shop')).toBe('~/code/shop')
    expect(pickedPath('~/work/old-app', 'shop')).toBe('~/work/shop')
    expect(pickedPath('~/work/old-app/', 'shop')).toBe('~/work/shop')
  })
})
