// What a person wears beyond their `Look` colours: hair cut, top, what they wear below, facial hair and the colour of
// a jacket, vest, tie or stripe. Picked from a seed so each person keeps theirs, and shared by the 3D figure and the
// face icon so both show the same person. Pure data, no three.js.
//
// There are two wardrobes. The first is what everyone hired before the second came gets, picked exactly as it always
// was, so nobody's look changes. The second adds skirts, dresses and more cuts and clothes; it first leans each person
// one way or the other, so about half wear skirts or long hair and nobody in a skirt has a beard.

import { hash } from './layout'

export type Hair =
  | 'short' | 'long' | 'bun' | 'fringe' | 'buzz' | 'spiky' | 'ponytail' | 'bob' | 'afro' | 'mohawk' | 'bald' | 'side'
  | 'twintails' | 'sidetail' | 'waves' | 'buns' | 'braid' | 'halfup' | 'curly' | 'quiff'
export type Top =
  | 'tee' | 'hoodie' | 'jacket' | 'tie' | 'sweater' | 'polo' | 'vest' | 'stripes'
  | 'cardigan' | 'bowshirt' | 'plaid' | 'labcoat' | 'turtleneck'
export type Bottom = 'pants' | 'skirt' | 'longskirt' | 'dress' | 'trunks' | 'bikini'
export type Facial = 'none' | 'mustache' | 'beard' | 'stubble' | 'goatee'

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
/** The newest wardrobe, which everyone hired from now on dresses from. */
export const WARDROBE = 2

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

/** `beach`: someone out on the island, who wears swimwear more often. */
export function styleOf(seed: number, wardrobe = 1, beach = false): Style {
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

/** The second wardrobe, out of the water. */
function dressed(seed: number, soft: boolean): Style {
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
