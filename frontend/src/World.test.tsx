import { expect, it } from 'vitest'
import { shadowHalf } from './Ambient'
import { sunNormalBias } from './World'

it('keeps the sun normal bias at a shadow texel or more as the town grows', () => {
  for (const span of [40, 124, 300]) {
    const half = shadowHalf(span)
    expect(sunNormalBias(half)).toBeGreaterThanOrEqual((half * 2) / 2048)
  }
  expect(sunNormalBias(shadowHalf(300))).toBeGreaterThan(sunNormalBias(shadowHalf(124)))
  expect(sunNormalBias(1)).toBe(0.06)
})
