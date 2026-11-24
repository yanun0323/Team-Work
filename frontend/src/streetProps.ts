// Street furniture on a building's paved plot: lamp posts, planters and benches, as plain boxes in town space.
// The map draws them; a building's hover shade and pointer area use the same boxes. Also the footpaths between
// the plots, their road markings, and the lamps and traffic lights along them.

import { ALONG_X, ALONG_Z, roadCells, type Arm } from './footpaths'
import { CELL, cellCenter, hash, rectCenter, type Lot, type Town } from './layout'

/** `glow`: a lamp's lantern, lit after dark. */
export interface Box { p: [number, number, number]; s: [number, number, number]; c: string; glow?: boolean }

/** The light a lit lantern gives off. */
export const LANTERN = '#ffd98a'

const WOOD_SEAT = '#a8774e'
const WOOD_LIGHT = '#bb8a5c'
const IRON = '#3c4253'

/** Footpath tarmac, the runway's asphalt a little patchy; concrete kerbs, and markings in the airport's paint. */
const TARMAC = ['#4a4f5c', '#474c58', '#4e5360'] as const
const KERB = '#c4c0cc'
const WHITE = '#f2f0e8'
const YELLOW = '#e5b33a'
/** Markings lie on the tarmac, their top this far above it. */
const PAINT = 0.01
/** The yellow line between the two ways: dashes on every other cell, solid on the approach to a junction. */
const CENTRE = { dash: 1.1, wide: 0.14 }
/** A crosswalk's stripes, lying along the road: this long, this wide, this far apart across it, five of them. */
const ZEBRA = { long: 1.5, wide: 0.38, pitch: 0.76 }
/** A stop line across the lane coming in, this wide, this far back from the crosswalk. */
const STOP = { wide: 0.3, gap: 0.3 }
/** Top of a footpath's slabs, where feet go, and of its kerbs, in world units. */
export const FOOTPATH_TOP = 0.06
const KERB_TOP = 0.1
const KERB_WIDTH = 0.24

/** A post 1.75 cells tall with a lantern on top, standing on (x, z). */
function lampBoxes(x: number, z: number): Box[] {
  const top = 1.75 * CELL
  return [
    { p: [x, 0.2, z], s: [0.5, 0.24, 0.5], c: IRON },
    { p: [x, top / 2, z], s: [0.16, top, 0.16], c: IRON },
    { p: [x, top + 0.2, z], s: [0.46, 0.4, 0.46], c: '#ffe7a3', glow: true },
    { p: [x, top + 0.45, z], s: [0.56, 0.1, 0.56], c: IRON },
  ]
}

/**
 * The footpaths, as tarmac roads: asphalt on each cell, and a kerb along every edge onto the grass, with a corner
 * stone where the road turns, so the kerb runs unbroken; none where a road meets a plot's paving. Marked as two-way
 * roads in Taiwan are: a dashed yellow line down the middle of the straight stretches, and at each junction a
 * crosswalk across every road into it, a white stop line across the lane coming in, and the yellow line solid up to it.
 */
export function footpathBoxes(town: Pick<Town, 'cols' | 'rows' | 'ground' | 'junctions'>): Box[] {
  const out: Box[] = []
  const ground = (x: number, z: number) => (x >= 0 && z >= 0 && x < town.cols && z < town.rows ? town.ground[z * town.cols + x] : null)
  const road = (x: number, z: number) => ground(x, z) === 'path'
  const paved = (x: number, z: number) => road(x, z) || ground(x, z) === 'pave'
  const edge = CELL / 2 - KERB_WIDTH / 2
  town.ground.forEach((g, k) => {
    if (g !== 'path') return
    const x = k % town.cols
    const z = (k - x) / town.cols
    const [cx, cz] = cellCenter(town, x, z)
    out.push({ p: [cx, FOOTPATH_TOP / 2, cz], s: [CELL, FOOTPATH_TOP, CELL], c: TARMAC[Math.floor(hash(x, z, 13) * TARMAC.length)] })
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      if (paved(x + dx, z + dz)) continue
      out.push({ p: [cx + dx * edge, KERB_TOP / 2, cz + dz * edge], s: dx ? [KERB_WIDTH, KERB_TOP, CELL] : [CELL, KERB_TOP, KERB_WIDTH], c: KERB })
    }
    for (const [dx, dz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      if (!paved(x + dx, z) || !paved(x, z + dz) || paved(x + dx, z + dz)) continue
      out.push({ p: [cx + dx * edge, KERB_TOP / 2, cz + dz * edge], s: [KERB_WIDTH, KERB_TOP, KERB_WIDTH], c: KERB })
    }
  })
  out.push(...roadMarkings(town))
  return out
}

/** The markings on the footpaths (see `footpathBoxes`). */
function roadMarkings(town: Pick<Town, 'cols' | 'rows' | 'ground' | 'junctions'>): Box[] {
  const out: Box[] = []
  // paint sunk a little into the tarmac, its top just above it
  const h = PAINT + 0.02
  const paint = (x: number, z: number, w: number, d: number, c: string) => out.push({ p: [x, FOOTPATH_TOP + PAINT - h / 2, z], s: [w, h, d], c })
  const { cols } = town
  const crossing = new Set<number>()
  const stopping = new Set<number>()
  for (const j of town.junctions) for (const a of j.arms) {
    const [dx, dz] = a.dir
    const s = [dz, -dx]
    for (const [x, z] of a.cross) crossing.add(z * cols + x)
    const w = a.cross.length
    if (w < 2) continue
    // stripes along the road, side by side across it, as many as fit
    const [ax, az] = cellCenter(town, ...a.cross[0])
    const [bx, bz] = cellCenter(town, ...a.cross[w - 1])
    const half = Math.floor((w * CELL - 0.6) / (2 * ZEBRA.pitch))
    for (let k = -half; k <= half; k++) {
      const x = (ax + bx) / 2 + s[0] * k * ZEBRA.pitch
      const z = (az + bz) / 2 + s[1] * k * ZEBRA.pitch
      paint(x, z, dx ? ZEBRA.long : ZEBRA.wide, dx ? ZEBRA.wide : ZEBRA.long, WHITE)
    }
    if (!a.stop) continue
    const [sx, sz] = a.stop
    for (let i = 0; i < w; i++) stopping.add((sz - s[1] * i) * cols + sx - s[0] * i)
    // across the side coming in, from the middle line to the kerb, a little back from the crosswalk
    const back = CELL / 2 - STOP.gap - STOP.wide / 2
    const [cx, cz] = cellCenter(town, sx, sz)
    const across = (w * CELL) / 2 - KERB_WIDTH - 0.2
    const inward = (KERB_WIDTH + (w * CELL) / 2) / 2 - CELL / 2
    paint(cx - dx * back - s[0] * inward, cz - dz * back - s[1] * inward, dx ? STOP.wide : across, dx ? across : STOP.wide, WHITE)
  }
  // the middle line, halfway across each straight stretch two or more cells wide: dashed, solid on a stop line's cells
  const { kind, side, wide } = roadCells(town.ground, town.cols, town.rows)
  for (let k = 0; k < kind.length; k++) {
    const x = k % cols
    const z = (k - x) / cols
    const alongX = kind[k] === ALONG_X && side[k] === z
    if ((!alongX && !(kind[k] === ALONG_Z && side[k] === x)) || wide[k] < 2) continue
    if (crossing.has(k)) continue
    const solid = stopping.has(k)
    if (!solid && (alongX ? x : z) % 2) continue
    const [cx, cz] = cellCenter(town, x, z)
    const long = solid ? CELL : CENTRE.dash
    const mid = ((wide[k] - 1) * CELL) / 2
    if (alongX) paint(cx, cz + mid, long, CENTRE.wide, YELLOW)
    else paint(cx + mid, cz, CENTRE.wide, long, YELLOW)
  }
  return out
}

/** Traffic lights: a post this tall, and a head this tall hung from its arm over the lane coming in. */
const SIGNAL = { top: 3.4, head: 1.1, wide: 0.46, deep: 0.32, bulb: 0.3, pitch: 0.34 }
const SIGNAL_HEAD = '#2b2f3a'

/** Where a traffic light's post stands, and the middle of its head; null for a road without a pole. */
function signalAt(town: Pick<Town, 'cols' | 'rows'>, a: Arm) {
  if (!a.pole) return null
  const [dx, dz] = a.dir
  const s = [dz, -dx]
  const [px, pz] = cellCenter(town, ...a.pole)
  // the post near the road's edge; the head over the middle of the side coming in, half the road's width
  const post: [number, number] = [px - s[0] * 0.5, pz - s[1] * 0.5]
  const [ex, ez] = cellCenter(town, ...a.cross[0])
  const inward = (a.cross.length * CELL) / 4 - CELL / 2
  const [lx, lz] = [ex - s[0] * inward, ez - s[1] * inward]
  return { post, head: [lx, SIGNAL.top - 0.12 - SIGNAL.head / 2, lz] as [number, number, number], d: [dx, dz], s }
}

/** The traffic lights' posts, arms and heads; less detail drops them, as it does the lamps. Their lamps are `signalBulbs`. */
export function signalBoxes(town: Pick<Town, 'cols' | 'rows' | 'junctions'>, detail: boolean): Box[] {
  if (!detail) return []
  return town.junctions.flatMap((j) => j.arms.flatMap((a): Box[] => {
    const at = signalAt(town, a)
    if (!at) return []
    const { post: [x, z], head, s } = at
    const reach = Math.hypot(head[0] - x, head[2] - z) + 0.25
    const along = (len: number, thick: number): [number, number, number] => (s[0] ? [len, thick, thick] : [thick, thick, len])
    const across = (w: number, h: number, d: number): [number, number, number] => (s[0] ? [w, h, d] : [d, h, w])
    return [
      { p: [x, 0.12, z], s: [0.36, 0.24, 0.36], c: IRON },
      { p: [x, SIGNAL.top / 2, z], s: [0.14, SIGNAL.top, 0.14], c: IRON },
      { p: [x - (s[0] * reach) / 2, SIGNAL.top - 0.07, z - (s[1] * reach) / 2], s: along(reach, 0.1), c: IRON },
      { p: head, s: across(SIGNAL.wide, SIGNAL.head, SIGNAL.deep), c: SIGNAL_HEAD },
    ]
  }))
}

/** A traffic light's lamp: 0 red at the top, 1 amber, 2 green. */
export type Light = 0 | 1 | 2
export interface Bulb extends Box {
  light: Light
  /** The way it shows to: 0 the roads along x, 1 those along z. */
  way: 0 | 1
  /** Seconds its junction's lights run ahead of the clock, so junctions don't all change at once. */
  offset: number
}

/** Seconds each way has green, then amber, then red both ways before the other way's green. */
export const SIGNAL_TIMES = { green: 7, amber: 2, clear: 1 }
const SIGNAL_HALF = SIGNAL_TIMES.green + SIGNAL_TIMES.amber + SIGNAL_TIMES.clear

/** The light each way shows `t` seconds in: the roads along x, then those along z. One has red whenever the other hasn't. */
export function signalLights(t: number): [Light, Light] {
  const p = ((t % (SIGNAL_HALF * 2)) + SIGNAL_HALF * 2) % (SIGNAL_HALF * 2)
  const shows = (q: number): Light => (q < SIGNAL_TIMES.green ? 2 : q < SIGNAL_TIMES.green + SIGNAL_TIMES.amber ? 1 : 0)
  return p < SIGNAL_HALF ? [shows(p), 0] : [0, shows(p - SIGNAL_HALF)]
}

/** The traffic lights' lamps, on the face of each head towards the traffic coming in; none with less detail. */
export function signalBulbs(town: Pick<Town, 'cols' | 'rows' | 'junctions'>, detail: boolean): Bulb[] {
  if (!detail) return []
  return town.junctions.flatMap((j) => {
    const offset = hash(...j.arms[0].cross[0], 17) * SIGNAL_HALF * 2
    return j.arms.flatMap((a): Bulb[] => {
      const at = signalAt(town, a)
      if (!at) return []
      const { head: [x, y, z], d } = at
      const front = SIGNAL.deep / 2 + 0.03
      const size: [number, number, number] = d[0] ? [0.06, SIGNAL.bulb, SIGNAL.bulb] : [SIGNAL.bulb, SIGNAL.bulb, 0.06]
      return ([0, 1, 2] as const).map((light) => ({
        p: [x + d[0] * front, y + (1 - light) * SIGNAL.pitch, z + d[1] * front], s: size, c: '#ffffff', light, way: d[0] ? 0 : 1, offset,
      }))
    })
  })
}

/** The lamps along the footpaths; less detail drops them, as it does the plots' own. */
export function pathLampBoxes(town: Pick<Town, 'cols' | 'rows' | 'pathLamps'>, detail: boolean): Box[] {
  return detail ? town.pathLamps.flatMap(([x, z]) => lampBoxes(...cellCenter(town, x, z))) : []
}

/** One plot's lamps, planters and benches, or the park's; less detail drops the lamps and the flowers. */
export function propBoxes(town: Town, lot: Pick<Lot, 'props'>, detail: boolean): Box[] {
  const out: Box[] = []
  for (const pr of lot.props) {
    const [x, z] = rectCenter(town, pr)
    if (pr.kind === 'bench') {
      // a wooden seat at knee height on two iron legs, with a backrest on the building side
      const [fx, fz] = pr.face ?? [0, 1]
      const long = (Math.max(pr.w, pr.d) - 0.3) * CELL
      const size = (a: number, b: number, h: number): [number, number, number] => (fx ? [b, h, a] : [a, h, b])
      const off = (t: number, y: number, back: number): [number, number, number] => [x + (fx ? -fx * back : t), y, z + (fz ? -fz * back : t)]
      for (const t of [-1, 1]) {
        out.push({ p: off((t * long) / 2.6, 0.24, 0), s: size(0.14, 0.7, 0.48), c: IRON })
        out.push({ p: off((t * long) / 2.6, 0.75, 0.32), s: size(0.12, 0.1, 1.0), c: IRON })
      }
      for (const k of [-0.18, 0.18]) out.push({ p: off(0, 0.52, k), s: size(long, 0.32, 0.08), c: k < 0 ? WOOD_LIGHT : WOOD_SEAT })
      for (const y of [0.85, 1.12]) out.push({ p: off(0, y, 0.36), s: size(long, 0.07, 0.18), c: WOOD_SEAT })
      continue
    }
    if (pr.kind === 'lamp') {
      if (detail) out.push(...lampBoxes(x, z))
      continue
    }
    // a stone trough a little inside its cells, soil, and a hedge with a few flowers
    const w = pr.w * CELL - 0.4
    const d = pr.d * CELL - 0.4
    out.push({ p: [x, 0.38, z], s: [w, 0.6, d], c: '#b9b1a3' })
    out.push({ p: [x, 0.69, z], s: [w - 0.24, 0.02, d - 0.24], c: '#6b4a33' })
    const along = pr.w > pr.d ? 'x' : 'z'
    const n = Math.max(pr.w, pr.d)
    for (let k = 0; k < n; k++) {
      const t = (k - (n - 1) / 2) * CELL
      const [bx, bz] = along === 'x' ? [x + t, z] : [x, z + t]
      out.push({ p: [bx, 1.0, bz], s: [CELL - 0.6, 0.6, CELL - 0.6], c: k % 2 ? '#4fa848' : '#62b955' })
      const f = hash(bx, bz, 4)
      if (detail && f < 0.7) out.push({ p: [bx + (f - 0.35) * 0.8, 1.36, bz - (f - 0.35) * 0.6], s: [0.22, 0.14, 0.22], c: ['#ff8a5c', '#ffd34a', '#f0f0f8', '#e56a9a'][Math.floor(f * 5.7)] })
    }
  }
  return out
}
