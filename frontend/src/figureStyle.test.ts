import { expect, it } from 'vitest'
import { FLIPFLOP, isSwimwear, SHOE, softLean, styleFor, styleOf, WARDROBE, type Style } from './figureStyle'
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
      // dark leather shoes, as everyone always wore
      shoes: 'leather',
      shoeColor: '#2a2a30',
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

it('wears the parts picked one by one, by the sea too, and leaves the rest to the seed', () => {
  const parts: Style = { hair: 'braid', top: 'labcoat', bottom: 'longskirt', facial: 'goatee', accent: '#123456', shoes: 'boots', shoeColor: '#654321' }
  for (const s of SEEDS.slice(0, 200)) {
    expect(styleFor({ wardrobe: WARDROBE }, s)).toEqual(styleOf(s, WARDROBE))
    expect(styleFor({ wardrobe: WARDROBE, parts }, s, true)).toEqual(parts)
  }
  // a part this version does not know, as a newer one or another computer may send, is the seed's pick
  const unknown = { hair: 'mullet', top: 'cape', bottom: 'kilt', facial: 'sideburns', accent: 'red' } as unknown as Style
  expect(styleFor({ wardrobe: WARDROBE, parts: unknown }, 42)).toEqual(styleOf(42, WARDROBE))
  expect(styleFor({ wardrobe: WARDROBE, parts: { ...unknown, top: 'vest' } }, 42).top).toBe('vest')
})

it('keeps everyone hired in the second wardrobe in their shoes, and puts the third in its clothes with sneakers and boots too', () => {
  for (const beach of [false, true]) for (const s of SEEDS) {
    const second = styleOf(s, 2, beach)
    const third = styleOf(s, 3, beach)
    // the same clothes, picked the same
    expect({ ...third, shoes: second.shoes, shoeColor: second.shoeColor }).toEqual(second)
    expect([second.shoes, second.shoeColor]).toEqual(isSwimwear(second.bottom) ? ['flipflops', FLIPFLOP] : ['leather', SHOE])
    if (isSwimwear(third.bottom)) expect(third.shoes).toBe('flipflops')
    else expect(['leather', 'sneakers', 'boots']).toContain(third.shoes)
  }
  const shod = SEEDS.map((s) => styleOf(s, WARDROBE)).filter((st) => !isSwimwear(st.bottom))
  for (const kind of ['leather', 'sneakers', 'boots'] as const) {
    expect(shod.filter((st) => st.shoes === kind).length / shod.length).toBeGreaterThan(0.12)
  }
})

it('leaves the shoes to the seed when the parts were picked before shoes could be', () => {
  const old = { hair: 'bob', top: 'hoodie', bottom: 'skirt', facial: 'none', accent: '#123456' } as unknown as Style
  const st = styleFor({ wardrobe: WARDROBE, parts: old }, 42)
  expect([st.shoes, st.shoeColor]).toEqual([styleOf(42, WARDROBE).shoes, styleOf(42, WARDROBE).shoeColor])
  expect(st.hair).toBe('bob')
})
