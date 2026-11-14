// What a person wears beyond their `Look` colours: hair cut, top, what they wear below, facial hair, the colour of
// a jacket, vest, tie or stripe, and shoes. Picked from a seed so each person keeps theirs, and shared by the 3D figure and the
// face icon so both show the same person. Pure data, no three.js.
//
// There are two wardrobes. The first is what everyone hired before the second came gets, picked exactly as it always
// was, so nobody's look changes. The second adds skirts, dresses and more cuts and clothes; it first leans each person
// one way or the other, so about half wear skirts or long hair and nobody in a skirt has a beard. The third is the
// second, picked the same, in sneakers or boots as often as in the dark leather shoes everyone before it wears.

import type { Look } from './core/domain/types'
import { hash } from './layout'

export type Hair =
  | 'short' | 'long' | 'bun' | 'fringe' | 'buzz' | 'spiky' | 'ponytail' | 'bob' | 'afro' | 'mohawk' | 'bald' | 'side'
  | 'twintails' | 'sidetail' | 'waves' | 'buns' | 'braid' | 'halfup' | 'curly' | 'quiff'
export type Top =
  | 'tee' | 'hoodie' | 'jacket' | 'tie' | 'sweater' | 'polo' | 'vest' | 'stripes'
  | 'cardigan' | 'bowshirt' | 'plaid' | 'labcoat' | 'turtleneck'
export type Bottom = 'pants' | 'skirt' | 'longskirt' | 'dress' | 'trunks' | 'bikini'
export type Facial = 'none' | 'mustache' | 'beard' | 'stubble' | 'goatee'
export type Shoes = 'leather' | 'sneakers' | 'boots' | 'flipflops' | 'barefoot'

export interface Style {
  hair: Hair
  top: Top
  /**
   * Trousers, a skirt, a long skirt, or a dress in the shirt's colour from the shoulders down; or swimwear, which is
   * the whole outfit: no top (`top` is then unused), bare arms and legs and flip-flops.
   */
  bottom: Bottom
  facial: Facial
  /** Jacket, vest, tie, cardigan, bow, sweater band, plaid or stripe colour; also a beanie's and a beret's. */
  accent: string
  /** Leather shoes, sneakers on a white sole, boots up the shin, flip-flops under bare feet, or bare feet alone (only ever picked by hand). */
  shoes: Shoes
  /** The shoes' colour: of the whole shoe, a sneaker's upper, or a flip-flop's sole. */
  shoeColor: string
}

/** Everything there is of each, first wardrobe first: the help lists them in this order. */
export const HAIR_CUTS: Hair[] = [
  'short', 'long', 'bun', 'fringe', 'buzz', 'spiky', 'ponytail', 'bob', 'afro', 'mohawk', 'bald', 'side',
  'twintails', 'sidetail', 'waves', 'buns', 'braid', 'halfup', 'curly', 'quiff',
]
export const TOPS: Top[] = ['tee', 'hoodie', 'jacket', 'tie', 'sweater', 'polo', 'vest', 'stripes', 'cardigan', 'bowshirt', 'plaid', 'labcoat', 'turtleneck']
export const BOTTOMS: Bottom[] = ['pants', 'skirt', 'longskirt', 'dress']
export const SWIMWEAR: Bottom[] = ['trunks', 'bikini']
export const isSwimwear = (b: Bottom) => b === 'trunks' || b === 'bikini'
export const FACIALS: Facial[] = ['none', 'mustache', 'beard', 'stubble', 'goatee']
export const SHOES: Shoes[] = ['leather', 'sneakers', 'boots', 'flipflops', 'barefoot']
/** The newest wardrobe, which everyone hired from now on dresses from. */
export const WARDROBE = 3

/** What everyone before the third wardrobe wears on their feet: dark leather shoes, or orange flip-flops with swimwear. */
export const SHOE = '#2a2a30'
export const FLIPFLOP = '#f2a93b'
/** The third wardrobe's colours for each kind of shoe. */
const SHOE_COLOURS: Record<Exclude<Shoes, 'barefoot'>, string[]> = {
  leather: [SHOE, '#5b3a26', '#7a4a2a'],
  sneakers: ['#f4f1e8', '#e85d4a', '#3f7fbf', '#2a2a30', '#4f9a6a', '#e0b13a'],
  boots: ['#5b3a26', '#2a2a30', '#8a5a2b'],
  flipflops: [FLIPFLOP, '#e86f8a', '#3f7fbf', '#4f9a6a'],
}

const JACKETS = ['#3a4a6b', '#5b4636', '#2f2f38', '#6b7a52', '#7a3b46']
const TIES = ['#c23b3b', '#2f5fa8', '#2f8f5b', '#d9a13b']
/** Bands and stripes on knitwear and striped tops: light enough to show on most shirts. */
const BANDS = ['#f4f1e8', '#ffcf5a', '#e85d4a', '#2f3b52', '#8fd0c8']
/** Soft knits for a cardigan. */
const KNITS = ['#f4e1c1', '#e8a0b4', '#9fc3e0', '#c9b8e8', '#b5c96a', '#2f3b52']

/** A number for a string, for seeding a style from an id. */
export const seedOf = (id: string) => [...id].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619), 2166136261) >>> 0

const pick = <T,>(seed: number, k: number, xs: readonly T[]) => xs[Math.floor(hash(seed, k) * xs.length)]

function accentOf(seed: number, top: Top) {
  const accents = top === 'tie' || top === 'bowshirt' ? TIES : top === 'jacket' || top === 'vest' ? JACKETS : top === 'cardigan' ? KNITS : BANDS
  return pick(seed, 3, accents)
}

/** The first wardrobe, exactly as it was: a person's seed must always pick the same as before. */
const FIRST_HAIR = HAIR_CUTS.slice(0, 12)
const FIRST_TOPS = TOPS.slice(0, 8)

/** The second wardrobe, by lean: cuts and clothes that can go either way are in both. */
const SOFT_HAIR: Hair[] = ['long', 'bun', 'ponytail', 'bob', 'twintails', 'sidetail', 'waves', 'buns', 'braid', 'halfup', 'curly', 'short', 'fringe', 'side', 'afro']
const SHARP_HAIR: Hair[] = ['short', 'buzz', 'spiky', 'mohawk', 'bald', 'side', 'fringe', 'afro', 'curly', 'quiff', 'long', 'ponytail', 'bun']
const SOFT_TOPS: Top[] = ['tee', 'sweater', 'stripes', 'cardigan', 'bowshirt', 'turtleneck', 'polo', 'hoodie', 'plaid', 'labcoat', 'jacket', 'vest']
const SHARP_TOPS: Top[] = ['tee', 'hoodie', 'jacket', 'tie', 'sweater', 'polo', 'vest', 'stripes', 'plaid', 'labcoat', 'turtleneck']
/** Over a dress: nothing, or a cardigan. */
const OVER_DRESS: Top[] = ['tee', 'cardigan']

/** Whether a look in the second wardrobe leans soft: long hair, skirts and dresses, never facial hair. */
export const softLean = (seed: number) => hash(seed, 5) < 0.5

/** How many in the second wardrobe wear swimwear: a few at work, more out on the island by the sea. */
const SWIM_AT_WORK = 0.05
const SWIM_BY_THE_SEA = 0.25

/** Everything but the shoes. */
type Clothes = Omit<Style, 'shoes' | 'shoeColor'>

/** `beach`: someone out on the island, who wears swimwear more often. */
export function styleOf(seed: number, wardrobe = 1, beach = false): Style {
  const clothes = clothesOf(seed, wardrobe, beach)
  return { ...clothes, ...shoesOf(seed, wardrobe, isSwimwear(clothes.bottom)) }
}

/** Flip-flops with swimwear; otherwise dark leather shoes, or from the third wardrobe sneakers and boots too. */
function shoesOf(seed: number, wardrobe: number, swim: boolean): Pick<Style, 'shoes' | 'shoeColor'> {
  if (swim) return { shoes: 'flipflops', shoeColor: wardrobe < 3 ? FLIPFLOP : pick(seed, 9, SHOE_COLOURS.flipflops) }
  if (wardrobe < 3) return { shoes: 'leather', shoeColor: SHOE }
  const k = hash(seed, 8)
  const shoes: Shoes = k < 0.45 ? 'leather' : k < 0.8 ? 'sneakers' : 'boots'
  return { shoes, shoeColor: pick(seed, 9, SHOE_COLOURS[shoes]) }
}

function clothesOf(seed: number, wardrobe: number, beach: boolean): Clothes {
  if (wardrobe < 2) {
    const top = pick(seed, 2, FIRST_TOPS)
    // most people are clean-shaven
    const f = hash(seed, 4)
    return {
      hair: pick(seed, 1, FIRST_HAIR),
      top,
      bottom: 'pants',
      facial: f < 0.72 ? 'none' : f < 0.82 ? 'mustache' : f < 0.92 ? 'beard' : 'stubble',
      accent: accentOf(seed, top),
    }
  }
  const soft = softLean(seed)
  // a bikini on those who lean soft, trunks on the rest, whatever their hair and facial hair
  if (hash(seed, 7) < (beach ? SWIM_BY_THE_SEA : SWIM_AT_WORK)) return { ...dressed(seed, soft), top: 'tee', bottom: soft ? 'bikini' : 'trunks' }
  return dressed(seed, soft)
}

const HEX = /^#[0-9a-f]{6}$/i

/**
 * What `look` wears: the parts picked one by one in `look.parts`, the rest as `seed` picks them. A part this version
 * does not know (picked on a newer one, or sent by another computer) is left to the seed too.
 */
export function styleFor(look: Pick<Look, 'wardrobe' | 'parts'>, seed: number, beach = false): Style {
  const st = styleOf(seed, look.wardrobe, beach)
  const p = look.parts
  if (!p) return st
  return {
    hair: HAIR_CUTS.includes(p.hair) ? p.hair : st.hair,
    top: TOPS.includes(p.top) ? p.top : st.top,
    bottom: BOTTOMS.includes(p.bottom) || SWIMWEAR.includes(p.bottom) ? p.bottom : st.bottom,
    facial: FACIALS.includes(p.facial) ? p.facial : st.facial,
    accent: HEX.test(p.accent) ? p.accent : st.accent,
    // parts picked before shoes could be have none: the seed's
    shoes: SHOES.includes(p.shoes) ? p.shoes : st.shoes,
    shoeColor: HEX.test(p.shoeColor ?? '') ? p.shoeColor : st.shoeColor,
  }
}

/** The second wardrobe, out of the water. */
function dressed(seed: number, soft: boolean): Clothes {
  const b = hash(seed, 6)
  const bottom: Bottom = !soft ? 'pants' : b < 0.3 ? 'pants' : b < 0.6 ? 'skirt' : b < 0.8 ? 'longskirt' : 'dress'
  const top = pick(seed, 2, bottom === 'dress' ? OVER_DRESS : soft ? SOFT_TOPS : SHARP_TOPS)
  const f = hash(seed, 4)
  return {
    hair: pick(seed, 1, soft ? SOFT_HAIR : SHARP_HAIR),
    top,
    bottom,
    facial: soft ? 'none' : f < 0.6 ? 'none' : f < 0.7 ? 'mustache' : f < 0.8 ? 'beard' : f < 0.9 ? 'stubble' : 'goatee',
    accent: accentOf(seed, top),
  }
}

/** A colour a little darker (k < 1) or lighter (k > 1), without three.js. */
export function shade(c: string, k: number) {
  const n = parseInt(c.slice(1), 16)
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(v * k))).toString(16).padStart(2, '0')
  return `#${ch((n >> 16) & 255)}${ch((n >> 8) & 255)}${ch(n & 255)}`
}
