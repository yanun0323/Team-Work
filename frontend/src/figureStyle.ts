// What a person wears beyond their `Look` colours: hair cut, top, facial hair and the colour of a jacket,
// vest, tie or stripe. Picked from a seed so each person keeps theirs, and shared by the 3D figure and the
// face icon so both show the same person. Pure data, no three.js.

import { hash } from './layout'

export type Hair = 'short' | 'long' | 'bun' | 'fringe' | 'buzz' | 'spiky' | 'ponytail' | 'bob' | 'afro' | 'mohawk' | 'bald' | 'side'
export type Top = 'tee' | 'hoodie' | 'jacket' | 'tie' | 'sweater' | 'polo' | 'vest' | 'stripes'
export type Facial = 'none' | 'mustache' | 'beard' | 'stubble'

export interface Style {
  hair: Hair
  top: Top
  facial: Facial
  /** Jacket, vest, tie, sweater band or stripe colour; also a beanie's. */
  accent: string
}

export const HAIR_CUTS: Hair[] = ['short', 'long', 'bun', 'fringe', 'buzz', 'spiky', 'ponytail', 'bob', 'afro', 'mohawk', 'bald', 'side']
export const TOPS: Top[] = ['tee', 'hoodie', 'jacket', 'tie', 'sweater', 'polo', 'vest', 'stripes']
const JACKETS = ['#3a4a6b', '#5b4636', '#2f2f38', '#6b7a52', '#7a3b46']
const TIES = ['#c23b3b', '#2f5fa8', '#2f8f5b', '#d9a13b']
/** Bands and stripes on knitwear and striped tops: light enough to show on most shirts. */
const BANDS = ['#f4f1e8', '#ffcf5a', '#e85d4a', '#2f3b52', '#8fd0c8']

/** A number for a string, for seeding a style from an id. */
export const seedOf = (id: string) => [...id].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619), 2166136261) >>> 0

export function styleOf(seed: number): Style {
  const top = TOPS[Math.floor(hash(seed, 2) * TOPS.length)]
  const accents = top === 'tie' ? TIES : top === 'jacket' || top === 'vest' ? JACKETS : BANDS
  // most people are clean-shaven
  const f = hash(seed, 4)
  return {
    hair: HAIR_CUTS[Math.floor(hash(seed, 1) * HAIR_CUTS.length)],
    top,
    facial: f < 0.72 ? 'none' : f < 0.82 ? 'mustache' : f < 0.92 ? 'beard' : 'stubble',
    accent: accents[Math.floor(hash(seed, 3) * accents.length)],
  }
}

/** A colour a little darker (k < 1) or lighter (k > 1), without three.js. */
export function shade(c: string, k: number) {
  const n = parseInt(c.slice(1), 16)
  const ch = (v: number) => Math.max(0, Math.min(255, Math.round(v * k))).toString(16).padStart(2, '0')
  return `#${ch((n >> 16) & 255)}${ch((n >> 8) & 255)}${ch(n & 255)}`
}
