import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { BlueprintIcon, pinLook } from './BlueprintIcon'
import { blueprintOf } from './DrawerDetail'
import type { Blueprint, Look } from './core/domain/types'
import { styleOf } from './figureStyle'

const bare: Look = { skin: '#f1c9a5', hair: '#2b1d14', shirt: '#4f7cff', pants: '#2d3550', extra: 'glasses' }
const draw = (look: Look, name: string) => renderToStaticMarkup(<BlueprintIcon look={look} name={name} size={40} />).replace(/<title>.*?<\/title>|aria-label="[^"]*"/g, '')

it('draws a blueprint with no style the same once its look is pinned, whatever name it is shown under', () => {
  const pinned = pinLook(bare, 'Researcher')
  expect(pinned.style).toBeTypeOf('number')
  expect(draw(pinned, '藍圖樣式')).toBe(draw(bare, 'Researcher'))
  // a look that has a style keeps it
  expect(pinLook({ ...bare, style: 7 }, 'Researcher').style).toBe(7)
})

const EXTRAS: Look['extra'][] = ['none', 'glasses', 'cap', 'headset', 'sunglasses', 'beanie', 'bow']

it('draws every face in blue, white and dashed lines only', () => {
  for (const extra of EXTRAS) {
    for (let style = 0; style < 200; style++) {
      const svg = draw({ ...bare, extra, style }, 'x')
      const colours = new Set([...svg.matchAll(/(?:fill|stroke)="([^"]+)"/g)].map((m) => m[1]))
      expect([...colours].filter((c) => c !== 'none').sort()).toEqual(['#407bcf', '#fff'].sort())
      expect(svg).toContain('stroke-dasharray')
    }
  }
})

it('draws the cut of the employee face from the same seed', () => {
  const seedWith = (hair: string) => { let s = 0; while (styleOf(s).hair !== hair) s++; return s }
  const whiteOf = (style: number) => draw({ ...bare, extra: 'none', style }, 'x')
  // the top corner of the head is hair on a short cut and bare on a bald head
  expect(whiteOf(seedWith('short'))).toContain('M0,0h1v1h-1z')
  expect(whiteOf(seedWith('bald'))).not.toContain('M0,0h1v1h-1z')
})

it('keeps the eyes apart from the hair beside them', () => {
  let style = 0
  while (styleOf(style).hair !== 'bob') style++
  const svg = draw({ ...bare, extra: 'none', style }, 'x')
  expect(svg).toContain('M2,4h1v1h-1z') // the eye
  expect(svg).not.toContain('M1,4h1v1h-1z') // the hair beside it
  expect(svg).toContain('M0,4h1v1h-1z') // the hair past that
})

it('saves the look picked on the form over the one the blueprint had', () => {
  const prev = { id: 'bp1', name: 'Dev', autoUpdate: true, look: { ...bare, style: 1 } } as Blueprint
  const rolled = { ...bare, extra: 'cap' as const, style: 99 }
  const saved = blueprintOf('bp1', prev, rolled, { ...prev, name: 'Dev 2' })
  expect(saved.look).toEqual(rolled)
  expect(saved.name).toBe('Dev 2')
  expect(saved.autoUpdate).toBe(true)
})
