import { expect, it } from 'vitest'
import type { Look } from './core/domain/types'
import { FACIALS, HAIR_CUTS } from './figureStyle'
import { headBoxesForTest } from './People'

const EXTRAS: Look['extra'][] = [
  'none', 'glasses', 'cap', 'headset', 'sunglasses', 'beanie', 'bow', 'strawhat', 'beret', 'bandana', 'headband', 'hairclip', 'flower',
]
const LOOK: Look = { skin: '#f1c7a5', hair: '#5a3a24', shirt: '#3f7fd0', pants: '#34405a', extra: 'none' }
const EPS = 1e-6
type Box = [number[], number[], string]

/**
 * Two boxes whose faces turned the same way lie in one plane and overlap: the renderer cannot tell which is in front,
 * and the overlap flickers between the two colours.
 */
function fighting(worn: Box[], rest: Box[]) {
  const out: string[] = []
  for (const [pa, sa, ca] of worn) for (const [pb, sb, cb] of rest) {
    if (ca === cb) continue
    for (let axis = 0; axis < 3; axis++) for (const side of [-1, 1]) {
      if (Math.abs(pa[axis] + (side * sa[axis]) / 2 - (pb[axis] + (side * sb[axis]) / 2)) > EPS) continue
      // the two faces overlap with some area on the other two axes
      const overlap = [0, 1, 2].filter((k) => k !== axis).every((k) =>
        Math.min(pa[k] + sa[k] / 2, pb[k] + sb[k] / 2) - Math.max(pa[k] - sa[k] / 2, pb[k] - sb[k] / 2) > EPS)
      if (overlap) out.push(`${ca} at ${pa} and ${cb} at ${pb}, along ${'xyz'[axis]}${side > 0 ? '+' : '-'}`)
    }
  }
  return out
}

it('wears every hat, pair of glasses and headset clear of the hair and face, never in the same plane', () => {
  const bad: string[] = []
  for (const hair of HAIR_CUTS) for (const facial of FACIALS) for (const extra of EXTRAS.filter((x) => x !== 'none')) {
    const st = { hair, top: 'tee' as const, bottom: 'pants' as const, facial, accent: '#ffcf5a' }
    const bare = new Set(headBoxesForTest(LOOK, st).map((b) => JSON.stringify(b)))
    const boxes = headBoxesForTest({ ...LOOK, extra }, st)
    // what the extra adds, against the rest of the head
    const worn = boxes.filter((b) => !bare.has(JSON.stringify(b)))
    const rest = boxes.filter((b) => bare.has(JSON.stringify(b)))
    for (const f of fighting(worn, rest)) bad.push(`${hair} + ${facial} + ${extra}: ${f}`)
  }
  expect(bad).toEqual([])
})
