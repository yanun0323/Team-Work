import { expect, it } from 'vitest'
import { labelDepth } from './labels'

it('puts a nearer label over a farther one', () => {
  expect(labelDepth(0.2, false)).toBeGreaterThan(labelDepth(0.6, false))
  expect(labelDepth(-1, false)).toBeGreaterThan(labelDepth(1, false))
})

it('puts a lifted label over every other, even a nearer one', () => {
  expect(labelDepth(1, true)).toBeGreaterThan(labelDepth(-1, false))
  expect(labelDepth(0.2, true)).toBeGreaterThan(labelDepth(0.6, true))
})
