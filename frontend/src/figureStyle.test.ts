import { expect, it } from 'vitest'
import { isSwimwear, softLean, styleOf, WARDROBE } from './figureStyle'
import { hash } from './layout'

const SEEDS = Array.from({ length: 3000 }, (_, i) => i * 7919 + 13)

it('dresses everyone hired before the second wardrobe exactly as before', () => {
  // the first wardrobe as it was written, before there was a second
  const HAIR = ['short', 'long', 'bun', 'fringe', 'buzz', 'spiky', 'ponytail', 'bob', 'afro', 'mohawk', 'bald', 'side']
  const TOPS = ['tee', 'hoodie', 'jacket', 'tie', 'sweater', 'polo', 'vest', 'stripes']
  const JACKETS = ['#3a4a6b', '#5b4636', '#2f2f38', '#6b7a52', '#7a3b46']
  const TIES = ['#c23b3b', '#2f5fa8', '#2f8f5b', '#d9a13b']
  const BANDS = ['#f4f1e8', '#ffcf5a', '#e85d4a', '#2f3b52', '#8fd0c8']
  for (const seed of SEEDS) {
    const top = TOPS[Math.floor(hash(seed, 2) * TOPS.length)]
    const accents = top === 'tie' ? TIES : top === 'jacket' || top === 'vest' ? JACKETS : BANDS
    const f = hash(seed, 4)
    const was = {
      hair: HAIR[Math.floor(hash(seed, 1) * HAIR.length)],
      top,
      bottom: 'pants',
      facial: f < 0.72 ? 'none' : f < 0.82 ? 'mustache' : f < 0.92 ? 'beard' : 'stubble',
      accent: accents[Math.floor(hash(seed, 3) * accents.length)],
    }
    expect(styleOf(seed)).toEqual(was)
    expect(styleOf(seed, 1)).toEqual(was)
  }
})

it('puts about half the new wardrobe in long hair, skirts and dresses, and nobody in a skirt or dress has facial hair', () => {
  const styles = SEEDS.map((s) => styleOf(s, WARDROBE))
  const skirted = styles.filter((st) => st.bottom === 'skirt' || st.bottom === 'longskirt' || st.bottom === 'dress')
  expect(skirted.length / styles.length).toBeGreaterThan(0.25)
  expect(SEEDS.filter(softLean).length / SEEDS.length).toBeGreaterThan(0.4)
  expect(SEEDS.filter(softLean).length / SEEDS.length).toBeLessThan(0.6)
  for (const st of skirted) expect(st.facial).toBe('none')
  // a dress is the whole outfit: only a cardigan goes over it
  for (const st of styles.filter((s) => s.bottom === 'dress')) expect(['tee', 'cardigan']).toContain(st.top)
})

it('puts a few at work and more by the sea in swimwear, a bikini only on those who lean soft', () => {
  const share = (beach: boolean) => SEEDS.filter((s) => isSwimwear(styleOf(s, WARDROBE, beach).bottom)).length / SEEDS.length
  expect(share(false)).toBeGreaterThan(0.03)
  expect(share(false)).toBeLessThan(0.07)
  expect(share(true)).toBeGreaterThan(0.2)
  expect(share(true)).toBeLessThan(0.3)
  for (const s of SEEDS) {
    const st = styleOf(s, WARDROBE, true)
    if (st.bottom === 'bikini') expect([softLean(s), st.facial]).toEqual([true, 'none'])
    if (st.bottom === 'trunks') expect(softLean(s)).toBe(false)
    // the first wardrobe never swims, by the sea or not
    expect(styleOf(s, 1, true)).toEqual(styleOf(s))
  }
})
