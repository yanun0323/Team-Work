import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { shadowHalf } from './Ambient'
import { sunNormalBias, TagWork } from './World'

it('keeps the sun normal bias at a shadow texel or more as the town grows', () => {
  for (const span of [40, 124, 300]) {
    const half = shadowHalf(span)
    expect(sunNormalBias(half)).toBeGreaterThanOrEqual((half * 2) / 2048)
  }
  expect(sunNormalBias(shadowHalf(300))).toBeGreaterThan(sunNormalBias(shadowHalf(124)))
  expect(sunNormalBias(1)).toBe(0.06)
})

it('spins a count of the chats and tasks under way after a name, nothing while idle, and 9+ past nine', () => {
  const tag = (chats: number, tasks: number) => renderToStaticMarkup(createElement(TagWork, { chats, tasks }))
  expect(tag(0, 0)).toBe('')
  expect(tag(1, 2)).toContain('<span aria-hidden="true">3</span>')
  expect(tag(4, 5)).toContain('<span aria-hidden="true">9</span>')
  expect(tag(4, 6)).toContain('<span aria-hidden="true">9+</span>')
  expect(tag(4, 6)).toContain('10 件工作進行中')
})
