// The park (park.ts) as plain boxes in town space, drawn with the street furniture: gravel paths, flower beds, picnic
// blankets with a basket, the bandstand, and its benches and lamps as a plot's. Its trees are the town's.

import { CELL, cellCenter, hash, rectCenter, type Rect, type Site, type Town } from './layout'
import { propBoxes, type Box } from './streetProps'

export const GRAVEL = ['#ddd3bd', '#d6cbb2', '#e2d9c5'] as const
/** Top of the gravel, a touch over the grass. */
export const GRAVEL_TOP = 0.03
const STONE = '#b9b1a3'
const SOIL = '#6b4a33'
const LEAF = ['#4fa848', '#62b955'] as const
const FLOWERS = ['#ff8a5c', '#ffd34a', '#f0f0f8', '#e56a9a', '#9a7ae0'] as const
/** A picnic blanket's checks, and its top: where someone sitting on it sits (BLANKET_TOP in People.tsx). */
const CHECKS = ['#d9544a', '#f4efe6'] as const
const BLANKET_TOP = 0.05
const WICKER = ['#b5824f', '#946638'] as const
const WOOD = '#c99a66'
const PAINT = '#f4f1ea'
const ROOF = ['#c4574a', '#a94639'] as const

/** Everything in the park but its trees; less detail drops the lamps and the flowers, as on the plots. */
export function parkBoxes(town: Town, park: Site, detail: boolean): Box[] {
  const out: Box[] = walkBoxes(town, park.walks, GRAVEL, GRAVEL_TOP)
  for (const r of park.beds) out.push(...bedBoxes(town, r, detail))
  for (const r of park.blankets) out.push(...blanketBoxes(town, r))
  // the one thing standing in a park that is not walked through is its bandstand
  for (const r of park.blocks) out.push(...gazeboBoxes(town, r))
  out.push(...propBoxes(town, park, detail))
  return out
}

/** A path's cells, a touch over the grass, each in one of `colours`. */
export function walkBoxes(town: Town, walks: Array<[number, number]>, colours: readonly string[], top: number): Box[] {
  return walks.map(([x, z]) => {
    const [cx, cz] = cellCenter(town, x, z)
    return { p: [cx, top / 2, cz], s: [CELL, top, CELL], c: colours[Math.floor(hash(x, z, 17) * colours.length)] }
  })
}

/** A low stone kerb round soil, with leafy clumps and flowers on every cell. */
export function bedBoxes(town: Town, r: Rect, detail: boolean): Box[] {
  const [x, z] = rectCenter(town, r)
  const w = r.w * CELL - 0.3
  const d = r.d * CELL - 0.3
  const out: Box[] = [
    { p: [x, 0.12, z], s: [w, 0.24, d], c: STONE },
    { p: [x, 0.25, z], s: [w - 0.3, 0.02, d - 0.3], c: SOIL },
  ]
  for (let k = 0; k < r.w * r.d; k++) {
    const cx = r.x + (k % r.w)
    const cz = r.z + Math.floor(k / r.w)
    const [bx, bz] = cellCenter(town, cx, cz)
    out.push({ p: [bx, 0.42, bz], s: [CELL - 0.8, 0.34, CELL - 0.8], c: LEAF[(cx + cz) % 2] })
    if (!detail) continue
    // a few flowers poking out of each clump, each its own colour
    for (let f = 0; f < 3; f++) {
      const h = hash(cx, cz, f, 23)
      out.push({ p: [bx + (h - 0.5) * 0.9, 0.66, bz + (hash(cx, cz, f, 29) - 0.5) * 0.9], s: [0.24, 0.16, 0.24], c: FLOWERS[Math.floor(h * FLOWERS.length)] })
    }
  }
  return out
}

/** A checked cloth two cells along x, flat on the grass, with a wicker basket in the middle. */
function blanketBoxes(town: Town, r: Rect): Box[] {
  const [x, z] = rectCenter(town, r)
  const out: Box[] = []
  const long = r.w * CELL - 0.6
  const wide = r.d * CELL - 0.6
  const n = 6, m = 3
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) {
    out.push({ p: [x - long / 2 + (i + 0.5) * (long / n), BLANKET_TOP / 2, z - wide / 2 + (j + 0.5) * (wide / m)], s: [long / n, BLANKET_TOP, wide / m], c: CHECKS[(i + j) % 2] })
  }
  out.push({ p: [x, BLANKET_TOP + 0.16, z], s: [0.5, 0.32, 0.36], c: WICKER[0] })
  out.push({ p: [x, BLANKET_TOP + 0.34, z], s: [0.54, 0.04, 0.4], c: WICKER[1] })
  out.push({ p: [x, BLANKET_TOP + 0.52, z], s: [0.06, 0.06, 0.3], c: WICKER[1] })
  return out
}

/** A wooden bandstand: a raised floor, a rail round three sides, white posts and a stepped red roof. */
function gazeboBoxes(town: Town, r: Rect): Box[] {
  const [x, z] = rectCenter(town, r)
  const w = r.w * CELL - 0.6
  const d = r.d * CELL - 0.6
  const floor = 0.3
  const post = 2.6
  const out: Box[] = [{ p: [x, floor / 2, z], s: [w, floor, d], c: WOOD }]
  // a step down at the front, where the way in is
  out.push({ p: [x, floor / 4, z + d / 2 + 0.25], s: [1.4, floor / 2, 0.5], c: WOOD })
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    out.push({ p: [x + sx * (w / 2 - 0.2), floor + post / 2, z + sz * (d / 2 - 0.2)], s: [0.22, post, 0.22], c: PAINT })
  }
  const rail = floor + 0.55
  out.push({ p: [x, rail, z - d / 2 + 0.2], s: [w - 0.4, 0.08, 0.08], c: PAINT })
  for (const sx of [-1, 1]) out.push({ p: [x + sx * (w / 2 - 0.2), rail, z], s: [0.08, 0.08, d - 0.4], c: PAINT })
  const eave = floor + post
  out.push({ p: [x, eave + 0.15, z], s: [w + 0.6, 0.3, d + 0.6], c: ROOF[1] })
  out.push({ p: [x, eave + 0.5, z], s: [w * 0.72, 0.4, d * 0.72], c: ROOF[0] })
  out.push({ p: [x, eave + 0.9, z], s: [w * 0.42, 0.4, d * 0.42], c: ROOF[1] })
  out.push({ p: [x, eave + 1.3, z], s: [0.3, 0.4, 0.3], c: PAINT })
  return out
}
