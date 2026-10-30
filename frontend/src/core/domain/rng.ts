// Seeded random numbers so the fake world plays out the same way every time.

interface Seeded {
  rng: number
  seq: number
}

/** mulberry32: advances the seed stored on the world. */
export function rand(w: Seeded): number {
  w.rng = (w.rng + 0x6d2b79f5) | 0
  let t = Math.imul(w.rng ^ (w.rng >>> 15), 1 | w.rng)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

export const between = (w: Seeded, lo: number, hi: number) => lo + rand(w) * (hi - lo)
export const pick = <T>(w: Seeded, list: readonly T[]): T => list[Math.floor(rand(w) * list.length)]
export const chance = (w: Seeded, p: number) => rand(w) < p
export const hex = (w: Seeded, n = 7) =>
  Array.from({ length: n }, () => Math.floor(rand(w) * 16).toString(16)).join('')
export const uid = (w: Seeded, prefix: string) => `${prefix}${++w.seq}`

/** Pick `n` distinct items in random order. */
export function sample<T>(w: Seeded, list: readonly T[], n: number): T[] {
  const pool = [...list]
  const out: T[] = []
  while (pool.length && out.length < n) out.push(pool.splice(Math.floor(rand(w) * pool.length), 1)[0])
  return out
}
