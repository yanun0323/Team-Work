// The landmarks (sites.ts) as plain boxes in town space, drawn with the street furniture, and the few parts of them
// that move: the fountain's water, the boats and the clock's hands. Their trees are the town's.

import { CELL, cellCenter, hash, rectCenter, type Rect, type Site, type Town } from './layout'
import { bedBoxes, GRAVEL, GRAVEL_TOP, parkBoxes, walkBoxes } from './parkBoxes'
import {
  BOATS, bridgeHeight, CLOCK_TOWER, CRATES, FOUNTAIN, HARBOUR, HILL_LEVELS, HILL_RISE, HILL_STAIRS, HILL_TOP, hillLevel,
  PARK_CELLS, PIER, PIER_TOP, SHED, STELE, TELESCOPE, turnCell, turnFace, turnRect,
} from './sites'
import { propBoxes, type Box } from './streetProps'
import { SEA_LEVEL } from './Island'

/** A part that moves: `boxes` round a pivot `at`, turned about `axis` by `turn(t)` and shifted by `move(t)`, `t` in seconds. */
export interface Moving {
  at: [number, number, number]
  axis: 'x' | 'y' | 'z'
  turn: (t: number) => number
  move?: (t: number) => [number, number, number]
  boxes: Box[]
}

const STONE = '#c9bfae'
const STONE_DARK = '#a39a8c'
const PAVING = ['#d8d2c8', '#cfc8bc', '#e0dad0'] as const
const WOOD = ['#b88a5a', '#a87b4e'] as const
const WOOD_DARK = '#7d5636'
const WATER = ['#4b9fd6', '#55a8dd'] as const
const SPRAY = '#cdeefc'
const BANK = '#ddd2a8'
const HILL_GRASS = ['#73bb58', '#7ec663'] as const
const EARTH = ['#9a7650', '#a7825a'] as const
/** How deep the grass on the hill's terraces is. */
const TURF = 0.2
const BUSH = '#4f9b45'
const CREAM = '#efe6d4'
const IRON = '#3c4253'

/** Everything standing on a landmark's ground but its trees; less detail drops the lamps and the small things. */
export function siteBoxes(town: Town, s: Site, detail: boolean): Box[] {
  if (s.kind === 'park') return parkBoxes(town, s, detail)
  const out: Box[] = [...propBoxes(town, s, detail)]
  for (const r of s.beds) out.push(...bedBoxes(town, r, detail))
  switch (s.kind) {
    case 'hill': out.push(...hillBoxes(town, s, detail)); break
    case 'pond': out.push(...pondBoxes(town, s, detail)); break
    case 'dock': out.push(...dockBoxes(town, s, detail)); break
    case 'clock': out.push(...clockBoxes(town, s, detail)); break
  }
  return out
}

/** The moving parts of a landmark; none for most. */
export function siteMoving(town: Town, s: Site): Moving[] {
  switch (s.kind) {
    case 'pond': return s.stage < 2 ? fountainSpray(town, s) : []
    case 'dock': return s.stage < 2 ? [] : boats(town, s)
    case 'clock': return hands(town, s)
    default: return []
  }
}

// ---------------------------------------------------------------- helpers

/** A box from `y0` up to `y1`, centred on (x, z). */
const slab = (x: number, z: number, y0: number, y1: number, w: number, d: number, c: string, glow?: boolean): Box =>
  ({ p: [x, (y0 + y1) / 2, z], s: [w, y1 - y0, d], c, ...(glow ? { glow } : {}) })

/** A cell of the site's plan, in world units, turned as it faces. */
const at = (town: Town, s: Site, x: number, z: number) => {
  const [tx, tz] = turnCell(s.face, [x, z])
  return cellCenter(town, s.plot.x + tx, s.plot.z + tz)
}

/** A rect of the site's plan, in world units, turned as it faces: its middle. */
const mid = (town: Town, s: Site, r: Rect) => {
  const t = turnRect(s.face, r)
  return rectCenter(town, { ...t, x: s.plot.x + t.x, z: s.plot.z + t.z })
}

/** Runs of cells along x in each row for which `on` holds, as boxes from `y0` to `y1` in `colour(z)`. */
function runs(town: Town, s: Site, on: (x: number, z: number) => boolean, y0: number, y1: number, colour: (z: number) => string, inset = 0): Box[] {
  const out: Box[] = []
  for (let z = 0; z < PARK_CELLS; z++) {
    for (let x = 0; x < PARK_CELLS; x++) {
      if (!on(x, z)) continue
      let e = x
      while (e + 1 < PARK_CELLS && on(e + 1, z)) e++
      const [ax, cz] = at(town, s, x, z)
      const [bx] = at(town, s, e, z)
      out.push(slab((ax + bx) / 2, cz, y0, y1, (e - x + 1) * CELL - inset, CELL - inset, colour(z)))
      x = e
    }
  }
  return out
}

// ---------------------------------------------------------------- the hill

function hillBoxes(town: Town, s: Site, detail: boolean): Box[] {
  const out = walkBoxes(town, s.walks, GRAVEL, GRAVEL_TOP)
  const stairs = new Set(HILL_STAIRS.map(([x, z]) => `${x},${z}`))
  const lookout = s.stage >= 2
  // each terrace, but for the steps cut up through them: earth, with a skin of grass over its top, or the lookout's
  // paving over the top's
  for (let level = 1; level <= HILL_LEVELS; level++) {
    const on = (x: number, z: number) => hillLevel(x, z) >= level && !stairs.has(`${x},${z}`)
    const top = level * HILL_RISE
    const paved = lookout && level === HILL_LEVELS
    out.push(...runs(town, s, on, top - HILL_RISE, top - TURF, () => EARTH[level % 2]))
    if (!paved) out.push(...runs(town, s, on, top - TURF, top, () => HILL_GRASS[level % 2]))
  }
  // the steps: two to a cell, the lower in front
  for (const [x, z, h] of HILL_STAIRS) {
    const [cx, cz] = at(town, s, x, z)
    out.push(slab(cx, cz + CELL / 4, 0, h - 0.3, CELL, CELL / 2, STONE))
    out.push(slab(cx, cz - CELL / 4, 0, h, CELL, CELL / 2, STONE_DARK))
  }
  // bushes and rocks along the terraces' edges
  if (detail) {
    for (let z = 0; z < PARK_CELLS; z++) for (let x = 0; x < PARK_CELLS; x++) {
      const level = hillLevel(x, z)
      if (!level || level === HILL_LEVELS || stairs.has(`${x},${z}`)) continue
      const h = hash(s.plot.x + x, s.plot.z + z, 41)
      if (h > 0.25) continue
      const [cx, cz] = at(town, s, x, z)
      const top = level * HILL_RISE
      out.push(h < 0.16 ? slab(cx, cz, top, top + 0.5, 0.9, 0.9, BUSH) : slab(cx, cz, top, top + 0.3, 0.7, 0.6, STONE_DARK))
    }
  }
  if (lookout) out.push(...lookoutBoxes(town, s))
  return out
}

const FLAGS = ['#cfc6b6', '#c4bba9', '#d8d0c1'] as const
const PARAPET = '#b3a995'

/**
 * The stone lookout on the hill's top: flagstones, a low parapet round the edge, open where the steps come up, a
 * pillar at each corner, a stone tablet with its inscription, and a brass telescope on a stone post.
 */
function lookoutBoxes(town: Town, s: Site): Box[] {
  const out: Box[] = []
  const T = HILL_TOP
  // the flagstones, a touch proud of the earth, each its own shade
  for (let z = 5; z <= 10; z++) for (let x = 5; x <= 10; x++) {
    if (hillLevel(x, z) !== HILL_LEVELS || HILL_STAIRS.some(([sx, sz]) => sx === x && sz === z)) continue
    const [cx, cz] = at(town, s, x, z)
    out.push(slab(cx, cz, T - TURF, T, CELL - 0.06, CELL - 0.06, FLAGS[Math.floor(hash(s.plot.x + x, s.plot.z + z, 53) * FLAGS.length)]))
  }
  const [x, z] = mid(town, s, { x: 5, z: 5, w: 6, d: 6 })
  const half = 3 * CELL - 0.2
  const wall = (cx: number, cz: number, w: number, d: number) => {
    out.push(slab(cx, cz, T, T + 0.55, w, d, PARAPET))
    out.push(slab(cx, cz, T + 0.55, T + 0.68, w + 0.12, d + 0.12, STONE))
  }
  wall(x, z - half, 2 * half, 0.4)
  for (const sx of [-1, 1]) wall(x + sx * half, z, 0.4, 2 * half)
  // the front, either side of the steps
  const side = half - CELL
  for (const sx of [-1, 1]) wall(x + sx * (CELL + side / 2), z + half, side, 0.4)
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    out.push(slab(x + sx * half, z + sz * half, T, T + 1.5, 0.7, 0.7, STONE))
    out.push(slab(x + sx * half, z + sz * half, T + 1.5, T + 1.7, 0.9, 0.9, STONE_DARK))
    out.push(slab(x + sx * half, z + sz * half, T + 1.7, T + 1.95, 0.4, 0.4, STONE))
  }
  // the stone tablet, its face towards the top, on a plinth; dark lines of its inscription
  const [tx, tz] = at(town, s, STELE[0], STELE[1])
  const sx = tx + 0.2
  out.push(slab(sx, tz, T, T + 0.3, 1.0, 1.6, STONE_DARK))
  out.push(slab(sx, tz, T + 0.3, T + 2.1, 0.36, 1.2, '#9b9384'))
  out.push(slab(sx, tz, T + 2.1, T + 2.3, 0.44, 1.32, STONE_DARK))
  for (let k = 0; k < 4; k++) out.push(slab(sx + 0.19, tz, T + 0.75 + k * 0.3, T + 0.85 + k * 0.3, 0.03, 0.8 - (k % 2) * 0.2, '#4a4438'))
  // the telescope, on a stone post, looking out the back; its eyepiece towards whoever stands at it
  const [px, pz] = at(town, s, TELESCOPE[0], TELESCOPE[1])
  const py = pz + 0.3
  out.push(slab(px, py, T, T + 0.25, 0.7, 0.7, STONE_DARK))
  out.push(slab(px, py, T + 0.25, T + 1.15, 0.36, 0.36, STONE))
  out.push(slab(px, py, T + 1.15, T + 1.3, 0.3, 0.3, IRON))
  out.push(slab(px, py - 0.2, T + 1.3, T + 1.56, 0.26, 1.2, '#c8a04a'))
  out.push(slab(px, py - 0.82, T + 1.27, T + 1.59, 0.34, 0.12, '#a8822f'))
  out.push(slab(px, py + 0.45, T + 1.36, T + 1.5, 0.14, 0.2, IRON))
  return out
}

// ---------------------------------------------------------------- the pond

function pondBoxes(town: Town, s: Site, detail: boolean): Box[] {
  if (s.stage < 2) return [...walkBoxes(town, s.walks, PAVING, 0.04), ...fountainBoxes(town, s)]
  const out = walkBoxes(town, s.walks, GRAVEL, GRAVEL_TOP)
  const water = new Set(s.water.map(([x, z]) => `${x - s.plot.x},${z - s.plot.z}`))
  const wet = (x: number, z: number) => water.has(`${x},${z}`)
  out.push(...runs(town, s, wet, 0, 0.04, (z) => WATER[z % 2]))
  // a sandy bank round the water
  for (let z = 0; z < PARK_CELLS; z++) for (let x = 0; x < PARK_CELLS; x++) {
    if (!wet(x, z)) continue
    const [cx, cz] = at(town, s, x, z)
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (wet(x + dx, z + dz)) continue
      out.push(slab(cx + dx * (CELL / 2 - 0.15), cz + dz * (CELL / 2 - 0.15), 0, 0.08, dx ? 0.3 : CELL, dz ? 0.3 : CELL, BANK))
    }
    // lily pads, here and there
    if (detail && Math.abs(x - 7.5) > 1.5 && hash(s.plot.x + x, s.plot.z + z, 43) < 0.12) out.push(slab(cx + 0.3, cz - 0.2, 0.04, 0.07, 0.7, 0.6, '#4fae6a'))
  }
  // the wooden bridge, arched, a rail along each side and piers under it
  const [bx0] = at(town, s, 7, 0)
  const [bx1] = at(town, s, 8, 0)
  const bx = (bx0 + bx1) / 2
  const half = CELL - 0.15
  const rows = [...new Set(s.raised.map(([, z]) => z - s.plot.z))]
  for (const z of rows) {
    const h = bridgeHeight(z)
    const [, cz] = at(town, s, 7, z)
    out.push(slab(bx, cz, h - 0.18, h, 2 * CELL - 0.2, CELL, WOOD[z % 2]))
    for (const sx of [-1, 1]) {
      out.push(slab(bx + sx * half, cz, h - 0.18, h + 0.6, 0.16, 0.16, WOOD_DARK))
      out.push(slab(bx + sx * half, cz, h + 0.5, h + 0.62, 0.12, CELL, WOOD_DARK))
    }
  }
  for (const z of [4, 9]) {
    const [, cz] = at(town, s, 7, z)
    out.push(slab(bx, cz, 0, bridgeHeight(z) - 0.18, 2 * CELL - 0.6, 0.4, STONE_DARK))
  }
  return out
}

/** A round stone basin, water in it, a column with a bowl on top; the spray is `fountainSpray`. */
function fountainBoxes(town: Town, s: Site): Box[] {
  const [x, z] = mid(town, s, FOUNTAIN)
  const w = FOUNTAIN.w * CELL - 0.4
  const t = 0.5
  const out: Box[] = [slab(x, z, 0, 0.4, w - t * 2, w - t * 2, WATER[1])]
  // the rim, its corners cut so it reads as round
  for (const sz of [-1, 1]) out.push(slab(x, z + sz * (w / 2 - t / 2), 0, 0.6, w - 1.6, t, STONE))
  for (const sx of [-1, 1]) out.push(slab(x + sx * (w / 2 - t / 2), z, 0, 0.6, t, w - 1.6, STONE))
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) out.push(slab(x + sx * (w / 2 - 0.9), z + sz * (w / 2 - 0.9), 0, 0.6, 0.9, 0.9, STONE))
  out.push(slab(x, z, 0.4, 1.6, 0.8, 0.8, STONE))
  out.push(slab(x, z, 1.6, 1.85, 2.4, 2.4, STONE))
  out.push(slab(x, z, 1.85, 1.9, 2.0, 2.0, WATER[0]))
  out.push(slab(x, z, 1.85, 2.3, 0.35, 0.35, STONE_DARK))
  return out
}

/** Water thrown up from the top of the fountain, out four ways and falling back into the basin, and a jet straight up. */
function fountainSpray(town: Town, s: Site): Moving[] {
  const [x, z] = mid(town, s, FOUNTAIN)
  const out: Moving[] = []
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2
    for (let j = 0; j < 3; j++) {
      const phase = j / 3 + k * 0.08
      out.push({
        at: [x, 0, z], axis: 'y', turn: () => 0,
        move: (t) => {
          const u = (t * 0.7 + phase) % 1
          const r = 0.3 + 2.2 * u
          return [Math.cos(a) * r, 2.3 + 1.6 * u - 3.45 * u * u, Math.sin(a) * r]
        },
        boxes: [{ p: [0, 0, 0], s: [0.22, 0.3, 0.22], c: SPRAY }],
      })
    }
  }
  out.push({ at: [x, 2.3, z], axis: 'y', turn: () => 0, move: (t) => [0, 0.08 * Math.sin(t * 6), 0], boxes: [{ p: [0, 0.35, 0], s: [0.22, 0.7, 0.22], c: SPRAY }] })
  return out
}

// ---------------------------------------------------------------- the pier

function dockBoxes(town: Town, s: Site, detail: boolean): Box[] {
  const out = walkBoxes(town, s.walks, PAVING, 0.08)
  // the plan's own ways and sizes, turned as the pier faces
  const odd = s.face % 2 !== 0
  const box = ([cx, cz]: [number, number], dx: number, dz: number, y0: number, y1: number, w: number, d: number, c: string) => {
    const [ox, oz] = turnFace(s.face, [dx, dz])
    return slab(cx + ox, cz + oz, y0, y1, odd ? d : w, odd ? w : d, c)
  }
  // the quay's stone wall along the coast, down into the sea
  const hw = HARBOUR.w * CELL, hd = HARBOUR.d * CELL
  out.push(box(mid(town, s, HARBOUR), 0, hd / 2, QUAY_FOOT, 0.12, hw, 0.6, STONE_DARK))
  // the pier's boards, two to a cell, and piles down into the sea at its edges
  const pier = new Set(PIER.map(([x, z]) => `${x},${z}`))
  for (const [x, z] of PIER) {
    const c = at(town, s, x, z)
    for (const k of [-0.5, 0.5]) out.push(box(c, k, 0, PIER_TOP - 0.12, PIER_TOP, CELL / 2 - 0.08, CELL - 0.06, WOOD[(x + z + (k > 0 ? 1 : 0)) % 2]))
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, -1]]) {
      if (pier.has(`${x + dx},${z + dz}`) || (x + z) % 2) continue
      out.push(box(c, dx * (CELL / 2 - 0.15), dz * (CELL / 2 - 0.15), QUAY_FOOT, PIER_TOP + 0.3, 0.26, 0.26, WOOD_DARK))
    }
  }
  // bollards along the quay
  for (const r of s.blocks.filter((b) => b.w === 1 && b.d === 1)) {
    const [cx, cz] = cellCenter(town, r.x, r.z)
    out.push(slab(cx, cz, 0.08, 0.6, 0.45, 0.45, IRON))
    out.push(slab(cx, cz, 0.6, 0.7, 0.6, 0.6, IRON))
  }
  // the harbour master's shed, with a life ring on its front
  const shed = mid(town, s, SHED)
  out.push(box(shed, 0, 0, 0, 2.6, 5.4, 5.4, '#8fb7d4'))
  out.push(box(shed, 0, 0, 2.6, 2.9, 6.0, 6.0, '#b24b3e'))
  out.push(box(shed, 0, 0, 2.9, 3.4, 4.2, 4.2, '#c4574a'))
  out.push(box(shed, 0, 0, 3.4, 3.8, 2.2, 2.2, '#b24b3e'))
  out.push(box(shed, -1, 2.71, 0, 1.9, 1.0, 0.06, WOOD_DARK))
  out.push(box(shed, 1.2, 2.71, 0.9, 1.7, 0.9, 0.06, '#e8eef4'))
  if (detail) out.push(box(shed, 1.2, 2.75, 1.15, 1.45, 0.4, 0.06, '#e85d4a'))
  // crates stacked on the quay
  const crates = mid(town, s, CRATES)
  out.push(box(crates, -1, 0, 0, 1.2, 1.5, 1.5, '#c49a5a'))
  out.push(box(crates, 0.9, 0, 0, 1.0, 1.3, 1.3, '#b88a4e'))
  out.push(box(crates, -0.8, 0, 1.2, 2.1, 1.1, 1.1, '#b88a4e'))
  return out
}

/** How far down the quay's wall and the pier's piles go: into the sea. */
const QUAY_FOOT = SEA_LEVEL - 0.4

/** The boats moored in the harbour, bobbing and rolling a little on the sea: two rowing boats and a sailing boat. */
function boats(town: Town, s: Site): Moving[] {
  return BOATS.map((b, i): Moving => {
    const along = b.sail
    const [ax, az] = at(town, s, b.x, b.z)
    const [ex, ez] = at(town, s, b.x + (along ? b.long - 1 : 0), b.z + (along ? 0 : b.long - 1))
    // the plan's way along the boat, turned as the pier faces
    const [tx, tz] = turnFace(s.face, along ? [1, 0] : [0, 1])
    const alongX = tx !== 0
    const sign = tx + tz
    const long = b.long * CELL - 0.6
    const sz = (l: number, w: number, h: number): [number, number, number] => (alongX ? [l, h, w] : [w, h, l])
    const off = (a: number, y: number): [number, number, number] => (alongX ? [a * sign, y, 0] : [0, y, a * sign])
    const hull = i % 2 ? '#f4f1ea' : '#e85d4a'
    // a dark keel, the hull in its colour with boards for a floor, a pointed bow and a thwart across
    const boxes: Box[] = [
      { p: off(0, 0.1), s: sz(long - 0.3, 1.0, 0.2), c: '#2f3e6b' },
      { p: off(0, 0.36), s: sz(long, 1.2, 0.32), c: hull },
      { p: off(long / 2 + 0.2, 0.36), s: sz(0.5, 0.7, 0.32), c: hull },
      { p: off(0, 0.53), s: sz(long - 0.4, 0.9, 0.04), c: WOOD[0] },
      { p: off(-0.2, 0.62), s: sz(0.3, 1.0, 0.12), c: WOOD[1] },
    ]
    if (b.sail) {
      boxes.push({ p: off(0.2, 1.8), s: sz(0.14, 0.14, 2.8), c: WOOD_DARK })
      for (let k = 0; k < 4; k++) boxes.push({ p: off(-0.35 - (3 - k) * 0.12, 0.9 + k * 0.6), s: sz(0.3 + (4 - k) * 0.25, 0.05, 0.6), c: '#f6efe2' })
    }
    return {
      at: [(ax + ex) / 2, SEA_LEVEL - 0.12, (az + ez) / 2], axis: alongX ? 'x' : 'z',
      turn: (t) => 0.05 * Math.sin(t * 1.1 + i * 2),
      move: (t) => [0, 0.05 * Math.sin(t * 1.4 + i), 0],
      boxes,
    }
  })
}

// ---------------------------------------------------------------- the clock tower

/** Where the clock's faces are, up the tower, and how far out from its middle. */
const FACE_Y = 12
const FACE_OUT = 3.1

function clockBoxes(town: Town, s: Site, detail: boolean): Box[] {
  const out = walkBoxes(town, s.walks, PAVING, 0.04)
  const [x, z] = mid(town, s, CLOCK_TOWER)
  out.push(slab(x, z, 0, 0.6, 7.6, 7.6, STONE))
  out.push(slab(x, z, 0.6, 10, 6, 6, '#c9785a'))
  // pale stone up the corners
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) out.push(slab(x + sx * 2.85, z + sz * 2.85, 0.6, 10, 0.6, 0.6, '#e8dcc6'))
  out.push(slab(x, z + 3.01, 0.6, 3.2, 1.6, 0.06, WOOD_DARK))
  if (detail) for (const y of [4.5, 7.2]) for (const [dx, dz, w, d] of [[0, 3.01, 0.8, 0.06], [0, -3.01, 0.8, 0.06], [3.01, 0, 0.06, 0.8], [-3.01, 0, 0.06, 0.8]]) {
    out.push(slab(x + dx, z + dz, y, y + 1.2, w, d, '#5a6b84'))
  }
  out.push(slab(x, z, 10, 10.4, 6.6, 6.6, CREAM))
  out.push(slab(x, z, 10.4, 13.6, 6.2, 6.2, CREAM))
  // the four faces, each a white dial in a dark ring with marks at twelve, three, six and nine
  for (const [nx, nz] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
    const across = (a: number, b: number): [number, number] => (nx ? [b, a] : [a, b])
    const [rw, rd] = across(3.4, 0.08)
    const [fw, fd] = across(3.0, 0.1)
    out.push(slab(x + nx * FACE_OUT, z + nz * FACE_OUT, FACE_Y - 1.7, FACE_Y + 1.7, rw, rd, '#2f3445'))
    out.push(slab(x + nx * (FACE_OUT + 0.03), z + nz * (FACE_OUT + 0.03), FACE_Y - 1.5, FACE_Y + 1.5, fw, fd, '#fbf8f0'))
    const [mw, md] = across(0.2, 0.12)
    for (const [u, v] of [[0, 1.25], [0, -1.25], [1.25, 0], [-1.25, 0]]) {
      const side = nx ? -u * nx : u * nz
      out.push(slab(x + nx * (FACE_OUT + 0.06) + (nx ? 0 : side), z + nz * (FACE_OUT + 0.06) + (nx ? side : 0), FACE_Y + v - 0.12, FACE_Y + v + 0.12, mw, md, '#2f3445'))
    }
  }
  // the belfry, open on all sides, and a roof stepping up to a spire
  out.push(slab(x, z, 13.6, 14, 6.8, 6.8, '#3f6f6a'))
  out.push(slab(x, z, 14, 16, 3.6, 3.6, '#5a4632'))
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) out.push(slab(x + sx * 2.1, z + sz * 2.1, 14, 16, 0.5, 0.5, CREAM))
  out.push(slab(x, z, 15.2, 15.9, 1.2, 1.2, '#c8a04a'))
  const roof = [[5.2, 16, 16.6], [4.0, 16.6, 17.4], [2.8, 17.4, 18.2], [1.6, 18.2, 19], [0.4, 19, 20.2]] as const
  for (const [w, y0, y1] of roof) out.push(slab(x, z, y0, y1, w, w, '#3f6f6a'))
  out.push(slab(x, z, 20.2, 20.6, 0.4, 0.4, '#e8c04a'))
  return out
}

/** The clock's hands, on all four faces, telling the time it is here. */
function hands(town: Town, s: Site): Moving[] {
  const [x, z] = mid(town, s, CLOCK_TOWER)
  const minute = () => {
    const d = new Date()
    return ((d.getMinutes() + d.getSeconds() / 60) / 60) * Math.PI * 2
  }
  const hour = () => {
    const d = new Date()
    return (((d.getHours() % 12) + d.getMinutes() / 60) / 12) * Math.PI * 2
  }
  const out: Moving[] = []
  for (const [nx, nz] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
    const axis = nx ? 'x' : 'z'
    // clockwise as seen from out in front of this face
    const sign = nx + nz
    const hand = (len: number, w: number, c: string, d: number): Box => ({ p: [0, len / 2 - 0.2, 0], s: nx ? [d, len, w] : [w, len, d], c })
    const pivot: [number, number, number] = [x + nx * (FACE_OUT + 0.15), FACE_Y, z + nz * (FACE_OUT + 0.15)]
    out.push({ at: pivot, axis, turn: () => -sign * hour(), boxes: [hand(1.1, 0.24, '#2f3445', 0.06)] })
    out.push({ at: [pivot[0] + nx * 0.06, pivot[1], pivot[2] + nz * 0.06], axis, turn: () => -sign * minute(), boxes: [hand(1.45, 0.16, '#2f3445', 0.06), { p: [0, 0, 0], s: [0.3, 0.3, 0.3], c: '#c8a04a' }] })
  }
  return out
}
