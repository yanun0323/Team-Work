import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { BlueprintIcon, pinLook } from './BlueprintIcon'
import { blueprintOf } from './DrawerDetail'
import type { Blueprint, Look } from './core/domain/types'

const bare: Look = { skin: '#f1c9a5', hair: '#2b1d14', shirt: '#4f7cff', pants: '#2d3550', extra: 'glasses' }
const draw = (look: Look, name: string) => renderToStaticMarkup(<BlueprintIcon look={look} name={name} size={40} />).replace(/<title>.*?<\/title>|aria-label="[^"]*"/g, '')

it('draws a blueprint with no style the same once its look is pinned, whatever name it is shown under', () => {
  const pinned = pinLook(bare, 'Researcher')
  expect(pinned.style).toBeTypeOf('number')
  expect(draw(pinned, '藍圖樣式')).toBe(draw(bare, 'Researcher'))
  // a look that has a style keeps it
  expect(pinLook({ ...bare, style: 7 }, 'Researcher').style).toBe(7)
})

it('saves the look picked on the form over the one the blueprint had', () => {
  const prev = { id: 'bp1', name: 'Dev', autoUpdate: true, look: { ...bare, style: 1 } } as Blueprint
  const rolled = { ...bare, extra: 'cap' as const, style: 99 }
  const saved = blueprintOf('bp1', prev, rolled, { ...prev, name: 'Dev 2' })
  expect(saved.look).toEqual(rolled)
  expect(saved.name).toBe('Dev 2')
  expect(saved.autoUpdate).toBe(true)
})
