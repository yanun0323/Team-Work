// The Fusion town on a cell grid. Every model takes whole cells. Pure data, no three.js.

import { officeCapacity } from './office'

export interface TeamInput {
  id: string
  name: string
  members: number
  /** Tasks it has finished: they dress up the building (`decorOf`). */
  done?: number
  /** Bytes of the files on its project's target branch: they raise the building (`floorsOf`). */
  bytes?: number
  /** Where the player put its plot, if they did; otherwise the town hands out a place. */
  at?: Spot
  /** Its building's look, once settled; otherwise looks are handed out in turn. */
  style?: BuildingStyle
  /** Seed for its building's details (colours, lit windows) and its office; otherwise taken from the id. */
  seed?: number
}

/**
 * A plot's corner cell (smallest x and z) in town cells: cell (0, 0) has its corner at the world origin, so a
 * spot stays put on screen however the town grows.
 */
export type Spot = [number, number]

/** A rectangle of cells: (x, z) is the corner cell with the smallest indices, w × d cells. */
export interface Rect {
  x: number
  z: number
  w: number
  d: number
}

export interface Lot {
  id: string
  name: string
  at: Spot
  /** Paved plot, always `PLOT_CELLS` square: the largest building plus a ring of pavement `RING_CELLS` wide. */
  plot: Rect
  /** Cells under the building, in the middle of the plot; it is just big enough for everyone (`footprintOf`). */
  building: Rect
  /** Storeys, 1 to `MAX_FLOORS`, by the project's size. */
  floors: number
  /** How dressed up the building is, 0 to `DECOR_TASKS.length`, by the tasks finished. */
  decor: number
  style: BuildingStyle
  /** Seed for the building's colours and lit windows, and, with the head count, its office. */
  seed: number
  /** Street furniture on the paved ring: lamps one cell, planters up to a 3 × 1 strip, benches 2 × 1. */
  props: Prop[]
}

export interface Prop extends Rect {
  kind: 'lamp' | 'planter' | 'bench'
  /** Benches: which way someone sitting on it looks (x, z), always away from the building. */
  face?: [number, number]
}

/** Building looks, handed out in turn so neighbours differ. */
export const BUILDING_STYLES = ['tower', 'brick', 'studio', 'loft', 'timber', 'classic', 'tech', 'pagoda', 'deco', 'eco', 'villa'] as const
export type BuildingStyle = (typeof BUILDING_STYLES)[number]

/** A building's look: its style, and a seed for everything else about it. */
export interface BuildingLook {
  style: BuildingStyle
  seed: number
}

/** A look at random, for a new company. */
export function randomLook(): BuildingLook {
  return { style: BUILDING_STYLES[Math.floor(Math.random() * BUILDING_STYLES.length)], seed: Math.floor(Math.random() * 2 ** 31) }
}

/** A steady seed for a company that never had one, from its id. */
export const seedOfId = (id: string) => [...id].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619), 2166136261) >>> 0

/** A tree on `TREE_CELLS` × `TREE_CELLS` cells; (x, z) is the corner cell with the smallest indices. */
export interface Tree {
  x: number
  z: number
  variant: number
  /** Height in cells: mostly 2, some 3 or 4. */
  height: number
}

/** `shore` is grass kept clear of models, so the rounded coastline never cuts into one; `airport` is the airfield. */
export type Ground = 'grass' | 'shore' | 'pave' | 'airport'

export interface Town {
  cols: number
  rows: number
  /** Ground of each cell, `null` for sea. Index with `z * cols + x`. */
  ground: Array<Ground | null>
  lots: Lot[]
  /** The airport's cells, in this town's cells. */
  airport: Rect
  trees: Tree[]
  /** Half the larger side, in world units. */
  radius: number
  /** Mean side length, in world units. */
  span: number
  /** Height of the tallest building, in world units. */
  top: number
  /** World position of the middle of all plots. */
  middle: [number, number]
}

/** World units per cell edge. People and furniture keep their size, so bigger cells mean roomier buildings. */
export const CELL = 2
/** Storey height, in cells. */
export const FLOOR_CELLS = 2
/** Largest building footprint edge, in cells: the plot is sized for it. */
export const BUILDING_CELLS = 10
/** Footprint edges a building goes through as it grows; even, so the two-cell door stays in the middle. */
export const BUILDING_SIZES = [4, 6, 8, 10] as const
export const MAX_FLOORS = 10
/** A project this big gets a second storey, and each time it doubles one more. */
export const FLOOR_BYTES = 128 * 1024
/**
 * Finished tasks that bring each dressing to the building, in turn: a blade sign, flags over the entrance, a
 * billboard on the side, neon along the roof, and the billboard turned into a moving screen.
 */
export const DECOR_TASKS = [3, 10, 25, 50, 100] as const
/** Width of the paved ring round each building, in cells. */
export const RING_CELLS = 3
export const PLOT_CELLS = BUILDING_CELLS + RING_CELLS * 2
/** Tree footprint edge, in cells. */
export const TREE_CELLS = 2
/** Grass cells kept round the airport, and between plots handed out on the grid; plots placed by hand may touch. */
const GAP_CELLS = 2
/** Land cells between the outermost plots and the sea. */
const SHORE_CELLS = 4
/** Cells from one handed-out plot to the next. */
const PITCH_CELLS = PLOT_CELLS + GAP_CELLS
/** Land round every plot; the two outer rings may be cut away to shape the coast. */
const PAD_CELLS = SHORE_CELLS + 2
/** Width of the land laid across the sea to a plot placed away from the island. */
const BRIDGE_CELLS = 6
/** Existing land expands this many cells in each direction; the whole plot must fit. */
export const REACH_CELLS = 32
/**
 * The airport, in town cells like a spot: fixed, behind the first plots (on the far side from the camera),
 * with room for a runway along x. Nothing can be built on it, and it is never moved.
 */
export const AIRPORT: Rect = { x: -20, z: -30, w: 40, d: 20 }
/** The runway's centre line, in cells from the airport's far edge, and its width: it runs the airport's length along x. */
export const RUNWAY_LINE = 16
export const RUNWAY_CELLS = 3
/** Terminal and control tower along the airport's far side, in world units about its middle. */
export const TERMINAL = { x0: -8, x1: 36, z0: -19.5, z1: -11, h: 6.5 }
/** The terminal's hall stands this far above the ground, on a solid base: its floor has an opening with depth. */
export const HALL_LIFT = 2.5
/** Where each plane stands, its nose towards the terminal; the jet bridge leaves the terminal at `BRIDGE_DX` beside it. */
export const STANDS = [11, 30]
export const STAND_Z = -5
export const BRIDGE_DX = 1.9
export const TOWER = { x: -14, z: -15, h: 14 }
/** Cells either side of the runway kept clear of trees all the way along its line, so planes coming in or climbing out clear them. */
const APPROACH_CELLS = RUNWAY_CELLS / 2 + 3
/** Fixed noise seed for the coast and trees; cells hash by their town position, so growing keeps them. */
const SEED = 7331

/** A building's footprint edge: the smallest that gives every employee a desk, up to `BUILDING_CELLS`. */
export function footprintOf(members: number): number {
  return BUILDING_SIZES.find((s) => officeCapacity(s * CELL, CELL) >= members) ?? BUILDING_CELLS
}

/** Storeys for a project of `bytes`: one below `FLOOR_BYTES`, then one more each time it doubles, up to `MAX_FLOORS`. */
export function floorsOf(bytes: number): number {
  if (!(bytes >= FLOOR_BYTES)) return 1
  return Math.min(MAX_FLOORS, 2 + Math.floor(Math.log2(bytes / FLOOR_BYTES)))
}

/** How many of `DECOR_TASKS` a company has reached with `done` finished tasks. */
export function decorOf(done: number): number {
  return DECOR_TASKS.filter((n) => done >= n).length
}

/** Deterministic noise in [0, 1). */
export function hash(...n: number[]) {
  let h = 2166136261
  for (const v of n) h = Math.imul(h ^ Math.round(v * 1000), 16777619)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/** World position of a cell's centre. The grid is centred on the origin, whose cell is (cols / 2, rows / 2). */
export function cellCenter(town: Pick<Town, 'cols' | 'rows'>, x: number, z: number): [number, number] {
  return [(x - town.cols / 2 + 0.5) * CELL, (z - town.rows / 2 + 0.5) * CELL]
}

/** World position of a rectangle's centre. */
export function rectCenter(town: Pick<Town, 'cols' | 'rows'>, r: Rect): [number, number] {
  return [(r.x + r.w / 2 - town.cols / 2) * CELL, (r.z + r.d / 2 - town.rows / 2) * CELL]
}

/**
 * Lamps and planters on a plot's paved ring, all on its middle row so there is a walkway on both sides:
 * a lamp at each corner; along each side a planter, and a bench with a small planter at its end; and two
 * lamps flanking the entrance (the +z side, whose middle two cells are kept clear for the door).
 */
function plotProps(plot: Rect): Prop[] {
  const n = plot.w
  const row = Math.floor(RING_CELLS / 2)
  const mid = n / 2
  const out: Prop[] = []
  const at = (x: number, z: number, w: number, d: number, kind: Prop['kind']) => out.push({ x: plot.x + x, z: plot.z + z, w, d, kind })
  for (const [x, z] of [[row, row], [n - 1 - row, row], [row, n - 1 - row], [n - 1 - row, n - 1 - row]]) at(x, z, 1, 1, 'lamp')
  // two three-cell slots per side, between the corner lamps and the middle four cells, which stay open;
  // one slot holds a planter, the other a bench (facing out, away from the building) and a small planter
  const far = n - 1 - row
  const sides: Array<{ cell: (along: number) => [number, number]; along: 'x' | 'z'; face: [number, number] }> = [
    { cell: (a) => [a, row], along: 'x', face: [0, -1] },
    { cell: (a) => [a, far], along: 'x', face: [0, 1] },
    { cell: (a) => [row, a], along: 'z', face: [-1, 0] },
    { cell: (a) => [far, a], along: 'z', face: [1, 0] },
  ]
  sides.forEach((side, i) => {
    const slots = [mid - 5, mid + 2]
    // the bench goes on alternate ends, so the sides don't all match; it sits at the end nearer the middle
    const bench = slots[i % 2]
    for (const a of slots) {
      const strip = (from: number, len: number, kind: Prop['kind'], face?: [number, number]) => {
        const [x, z] = side.cell(from)
        at(x, z, side.along === 'x' ? len : 1, side.along === 'x' ? 1 : len, kind)
        if (face) out[out.length - 1].face = face
      }
      if (a !== bench) strip(a, 3, 'planter')
      else if (a < mid) { strip(a, 1, 'planter'); strip(a + 1, 2, 'bench', side.face) }
      else { strip(a, 2, 'bench', side.face); strip(a + 2, 1, 'planter') }
    }
  })
  at(mid - 2, n - 1 - row, 1, 1, 'lamp')
  at(mid + 1, n - 1 - row, 1, 1, 'lamp')
  return out
}

/** A spot's plot, in this town's cells. */
export function plotAt(town: Pick<Town, 'cols' | 'rows'>, [x, z]: Spot): Rect {
  return { x: x + town.cols / 2, z: z + town.rows / 2, w: PLOT_CELLS, d: PLOT_CELLS }
}

/** World position of the middle of a spot's plot. */
export const spotCenter = ([x, z]: Spot): [number, number] => [(x + PLOT_CELLS / 2) * CELL, (z + PLOT_CELLS / 2) * CELL]

/** The spot whose plot is centred as near as can be on a world point. */
export const spotUnder = (wx: number, wz: number): Spot => [Math.round(wx / CELL - PLOT_CELLS / 2), Math.round(wz / CELL - PLOT_CELLS / 2)]

const grow = (r: Rect, n: number): Rect => ({ x: r.x - n, z: r.z - n, w: r.w + n * 2, d: r.d + n * 2 })

type PlacementTown = Pick<Town, 'cols' | 'rows' | 'ground' | 'lots'>
export interface PlacementArea {
  x0: number
  z0: number
  cols: number
  rows: number
  /** Legal plot corners, in world cells. */
  valid: Uint8Array
}
const placementCache = new WeakMap<PlacementTown, Map<string, PlacementArea>>()

/** Summed cells make both expansion and whole-footprint checks constant-time. */
function cellSums(cols: number, rows: number, cell: (x: number, z: number) => number) {
  const stride = cols + 1
  const sums = new Int32Array(stride * (rows + 1))
  for (let z = 0; z < rows; z++) for (let x = 0; x < cols; x++) {
    const k = (z + 1) * stride + x + 1
    sums[k] = cell(x, z) + sums[k - 1] + sums[k - stride] - sums[k - stride - 1]
  }
  return (x0: number, z0: number, x1: number, z1: number) => {
    x0 = Math.max(0, Math.min(cols, x0)); x1 = Math.max(0, Math.min(cols, x1))
    z0 = Math.max(0, Math.min(rows, z0)); z1 = Math.max(0, Math.min(rows, z1))
    return sums[z1 * stride + x1] - sums[z0 * stride + x1] - sums[z1 * stride + x0] + sums[z0 * stride + x0]
  }
}

/** One source for the grid, placement cursor and move validation. Moving keeps the current land. */
export function placementArea(town: PlacementTown, moved?: string): PlacementArea {
  let cached = placementCache.get(town)
  if (!cached) { cached = new Map(); placementCache.set(town, cached) }
  const key = moved ?? ''
  const existing = cached.get(key)
  if (existing) return existing
  const n = REACH_CELLS
  const cols = town.cols + n * 2, rows = town.rows + n * 2
  const x0 = -town.cols / 2 - n, z0 = -town.rows / 2 - n
  const land = cellSums(town.cols, town.rows, (x, z) => town.ground[z * town.cols + x] ? 1 : 0)
  const blocked = cellSums(cols, rows, (x, z) => {
    const wx = x + x0, wz = z + z0
    // The expansion is a square-cell dilation of the actual coastline, not its bounding box.
    if (!land(x - 2 * n, z - 2 * n, x + 1, z + 1)) return 1
    if (wx >= AIRPORT.x - GAP_CELLS && wx < AIRPORT.x + AIRPORT.w + GAP_CELLS &&
        wz >= AIRPORT.z - GAP_CELLS && wz < AIRPORT.z + AIRPORT.d + GAP_CELLS) return 1
    return town.lots.some((l) => l.id !== moved && wx >= l.at[0] && wx < l.at[0] + PLOT_CELLS && wz >= l.at[1] && wz < l.at[1] + PLOT_CELLS) ? 1 : 0
  })
  const valid = new Uint8Array(cols * rows)
  for (let z = 0; z <= rows - PLOT_CELLS; z++) for (let x = 0; x <= cols - PLOT_CELLS; x++) {
    if (Math.abs(x + x0) <= 512 && Math.abs(z + z0) <= 512 && !blocked(x, z, x + PLOT_CELLS, z + PLOT_CELLS)) valid[z * cols + x] = 1
  }
  const area = { x0, z0, cols, rows, valid }
  cached.set(key, area)
  return area
}

export function canPlace(town: PlacementTown, at: Spot, moved?: string): boolean {
  if (at.some((v) => !Number.isInteger(v) || Math.abs(v) > 512)) return false
  const area = placementArea(town, moved)
  const x = at[0] - area.x0, z = at[1] - area.z0
  return x >= 0 && z >= 0 && x < area.cols && z < area.rows && !!area.valid[z * area.cols + x]
}

export function canMove(town: PlacementTown, id: string, at: Spot): boolean {
  return canPlace(town, at, id)
}

/** Why a plot can't go here: on another company or the airport, or too far from the land. Null when it can. */
export function placeProblem(town: PlacementTown, at: Spot, moved?: string): 'taken' | 'far' | null {
  if (canPlace(town, at, moved)) return null
  const plot = { x: at[0], z: at[1], w: PLOT_CELLS, d: PLOT_CELLS }
  if (overlaps(plot, AIRPORT, GAP_CELLS)) return 'taken'
  if (town.lots.some((l) => l.id !== moved && overlaps(plot, { x: l.at[0], z: l.at[1], w: PLOT_CELLS, d: PLOT_CELLS }))) return 'taken'
  return 'far'
}

export const sameSpot = (a: Spot, b: Spot) => a[0] === b[0] && a[1] === b[1]

/** Closer than `gap` cells on both axes; with no gap, sharing a cell. */
const overlaps = (a: Rect, b: Rect, gap = 0) =>
  a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.z < b.z + b.d + gap && b.z < a.z + a.d + gap

const SIDES: Array<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]]

/**
 * The island is only what the companies standing now (and the airport) need: land a company left, by
 * moving or closing, goes back to the sea.
 */
export function layoutTown(teams: TeamInput[]): Town {
  // teams without a spot get one on a square grid of plots, filled from the middle outward so the town
  // grows evenly and stays centred on the origin; places taken by spots the player picked are skipped
  const pinned = [...teams.filter((t) => t.at).map((t) => t.at!).map(([x, z]) => ({ x, z, w: PLOT_CELLS, d: PLOT_CELLS })), AIRPORT]
  const loose = teams.filter((t) => !t.at).length
  let handed: Spot[] = []
  for (let n = Math.max(1, Math.ceil(Math.sqrt(loose))); handed.length < loose; n++) {
    const grid: Array<[number, number]> = []
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) grid.push([c, r])
    const mid = (n - 1) / 2
    grid.sort((a, b) => (a[0] - mid) ** 2 + (a[1] - mid) ** 2 - ((b[0] - mid) ** 2 + (b[1] - mid) ** 2) || a[1] - b[1] || a[0] - b[0])
    const picked = grid.slice(0, loose)
    // the blocks in use are centred on the origin
    const cm = (Math.min(...picked.map((b) => b[0])) + Math.max(...picked.map((b) => b[0]))) / 2
    const rm = (Math.min(...picked.map((b) => b[1])) + Math.max(...picked.map((b) => b[1]))) / 2
    handed = grid
      .map(([c, r]): Spot => [Math.round((c - cm) * PITCH_CELLS - PLOT_CELLS / 2), Math.round((r - rm) * PITCH_CELLS - PLOT_CELLS / 2)])
      .filter(([x, z]) => !pinned.some((o) => overlaps({ x, z, w: PLOT_CELLS, d: PLOT_CELLS }, o, GAP_CELLS)))
      .slice(0, loose)
  }
  let next = 0
  const spots = teams.map((t) => t.at ?? handed[next++])

  // a grid symmetric about the origin, with land round every plot and a ring of sea beyond it
  const air: [number, number, number, number] = [AIRPORT.x, AIRPORT.z, AIRPORT.x + AIRPORT.w, AIRPORT.z + AIRPORT.d]
  const reach = (k: 0 | 1) => Math.max(
    PLOT_CELLS / 2 + PAD_CELLS,
    ...spots.flatMap((s) => [-(s[k] - PAD_CELLS), s[k] + PLOT_CELLS + PAD_CELLS]),
    -(air[k] - PAD_CELLS), air[k + 2] + PAD_CELLS,
  ) + 1
  const cols = reach(0) * 2
  const rows = reach(1) * 2
  const lots: Lot[] = teams.map((t, i) => {
    const plot = plotAt({ cols, rows }, spots[i])
    const size = footprintOf(t.members)
    const inset = (PLOT_CELLS - size) / 2
    return {
      id: t.id,
      name: t.name,
      at: spots[i],
      plot,
      building: { x: plot.x + inset, z: plot.z + inset, w: size, d: size },
      props: plotProps(plot),
      floors: floorsOf(t.bytes ?? 0),
      decor: decorOf(t.done ?? 0),
      style: t.style ?? BUILDING_STYLES[i % BUILDING_STYLES.length],
      seed: t.seed ?? seedOfId(t.id),
    }
  })

  const ground: Array<Ground | null> = new Array(cols * rows).fill(null)
  const inside = (x: number, z: number) => x >= 0 && z >= 0 && x < cols && z < rows
  const at = (x: number, z: number) => (inside(x, z) ? ground[z * cols + x] : null)
  const paint = (r: Rect) => {
    for (let z = r.z; z < r.z + r.d; z++) for (let x = r.x; x < r.x + r.w; x++) if (inside(x, z)) ground[z * cols + x] = 'grass'
  }
  const airport: Rect = { ...AIRPORT, x: AIRPORT.x + cols / 2, z: AIRPORT.z + rows / 2 }
  // land round every plot and the airport
  paint(grow(airport, PAD_CELLS))
  for (const l of lots) paint(grow(l.plot, PAD_CELLS))
  joinLand(ground, cols, rows)
  // edge rings by distance to the sea, before any cut
  const ring = seaDistance(ground, cols, rows)

  // coast: short notches along the two outer rings, in runs of a few cells so the shore steps instead of
  // looking noisy; hashed by town position, so the coast stays as it was when the town grows
  const town = (x: number, z: number) => [x - cols / 2, z - rows / 2]
  for (let z = 0; z < rows; z++) for (let x = 0; x < cols; x++) {
    const e = ring[z * cols + x]
    if (e > 1) continue
    const [tx, tz] = town(x, z)
    if (hash(SEED, Math.floor(tx / 3), Math.floor(tz / 3), e) < (e === 0 ? 0.55 : 0.2)) ground[z * cols + x] = null
  }
  // an inner-ring cut only stands if the outer cell beside it is sea too
  for (let z = 0; z < rows; z++) for (let x = 0; x < cols; x++) {
    if (ring[z * cols + x] !== 1 || at(x, z)) continue
    const open = SIDES.some(([dx, dz]) => inside(x + dx, z + dz) && ring[(z + dz) * cols + x + dx] === 0 && !at(x + dx, z + dz))
    if (!open) ground[z * cols + x] = 'grass'
  }
  // a narrow crossing may have been cut through; lay it again
  joinLand(ground, cols, rows)
  // sea the open sea can't reach is a lake: fill it in
  fillLakes(ground, cols, rows)

  for (const l of lots) for (let z = l.plot.z; z < l.plot.z + l.plot.d; z++) for (let x = l.plot.x; x < l.plot.x + l.plot.w; x++) ground[z * cols + x] = 'pave'
  for (let z = airport.z; z < airport.z + airport.d; z++) for (let x = airport.x; x < airport.x + airport.w; x++) ground[z * cols + x] = 'airport'
  // land touching the sea stays clear
  for (let z = 0; z < rows; z++) for (let x = 0; x < cols; x++) {
    if (at(x, z) !== 'grass') continue
    if (SIDES.some(([dx, dz]) => at(x + dx, z + dz) === null)) ground[z * cols + x] = 'shore'
  }

  // trees on free grass, never right next to a plot, so plots keep a clear lawn around them
  const nearPlot = (x: number, z: number) => [...lots.map((l) => l.plot), airport].some((r) => x >= r.x - 1 && x <= r.x + r.w && z >= r.z - 1 && z <= r.z + r.d)
  const trees: Tree[] = []
  const used = new Set<number>()
  const line = airport.z + RUNWAY_LINE
  const onApproach = (z: number) => Math.abs(z + 0.5 - line) < APPROACH_CELLS
  const free = (x: number, z: number) => at(x, z) === 'grass' && !nearPlot(x, z) && !onApproach(z) && !used.has(z * cols + x)
  for (let z = 0; z < rows; z++) for (let x = 0; x < cols; x++) {
    const cells: Array<[number, number]> = []
    for (let dz = 0; dz < TREE_CELLS; dz++) for (let dx = 0; dx < TREE_CELLS; dx++) cells.push([x + dx, z + dz])
    const [tx, tz] = town(x, z)
    if (!cells.every(([cx, cz]) => free(cx, cz)) || hash(SEED, tx, tz, 7) >= 0.2) continue
    for (const [cx, cz] of cells) used.add(cz * cols + cx)
    const tall = hash(tx, tz, 5)
    trees.push({ x, z, variant: Math.floor(hash(tx, tz, 3) * 3), height: tall < 0.55 ? 2 : tall < 0.85 ? 3 : 4 })
  }

  const top = Math.max(0, ...lots.map((l) => l.floors * FLOOR_CELLS * CELL))
  const ends = (k: 0 | 1) => [Math.min(air[k], ...spots.map((s) => s[k])), Math.max(air[k + 2], ...spots.map((s) => s[k] + PLOT_CELLS))]
  const [x0, x1] = ends(0)
  const [z0, z1] = ends(1)
  return {
    cols, rows, ground, lots, airport, trees, middle: [((x0 + x1) / 2) * CELL, ((z0 + z1) / 2) * CELL],
    radius: (Math.max(cols, rows) / 2) * CELL, span: ((cols + rows) / 2) * CELL, top,
  }
}

/**
 * The cells that would turn from sea to land with a plot on `at`, in town cells like a spot. `moved` is the
 * company going there, if it already stands somewhere.
 */
export function landGained(town: Pick<Town, 'cols' | 'rows' | 'ground' | 'lots'>, at: Spot, moved?: string): Spot[] {
  const stays = town.lots.filter((l) => l.id !== moved).map((l) => ({ id: l.id, name: l.name, members: 0, at: l.at }))
  const next = layoutTown([...stays, { id: moved ?? '', name: '', members: 0, at }])
  const isLand = (x: number, z: number) => {
    const cx = x + town.cols / 2, cz = z + town.rows / 2
    return cx >= 0 && cz >= 0 && cx < town.cols && cz < town.rows && !!town.ground[cz * town.cols + cx]
  }
  const out: Spot[] = []
  for (let cz = 0; cz < next.rows; cz++) for (let cx = 0; cx < next.cols; cx++) {
    const x = cx - next.cols / 2, z = cz - next.rows / 2
    if (next.ground[cz * next.cols + cx] && !isLand(x, z)) out.push([x, z])
  }
  return out
}

/** Connected pieces of land (4-neighbours), as lists of cell indices, largest first. */
function pieces(ground: Array<Ground | null>, cols: number, rows: number): number[][] {
  const seen = new Uint8Array(cols * rows)
  const out: number[][] = []
  for (let k = 0; k < ground.length; k++) {
    if (!ground[k] || seen[k]) continue
    const piece: number[] = []
    const stack = [k]
    seen[k] = 1
    while (stack.length) {
      const c = stack.pop()!
      piece.push(c)
      const x = c % cols
      const z = (c - x) / cols
      for (const [dx, dz] of SIDES) {
        const nx = x + dx, nz = z + dz
        const n = nz * cols + nx
        if (nx >= 0 && nz >= 0 && nx < cols && nz < rows && ground[n] && !seen[n]) {
          seen[n] = 1
          stack.push(n)
        }
      }
    }
    out.push(piece)
  }
  return out.sort((a, b) => b.length - a.length)
}

/**
 * Lays land across the sea until all the land is one island: from the biggest piece, the shortest way over
 * the sea to the nearest other piece, `BRIDGE_CELLS` wide; then again, until none is left apart.
 */
function joinLand(ground: Array<Ground | null>, cols: number, rows: number) {
  for (let guard = 0; guard < 64; guard++) {
    const all = pieces(ground, cols, rows)
    if (all.length < 2) return
    const main = new Set(all[0])
    // breadth-first over the sea from the main piece, until it reaches other land
    const from = new Int32Array(cols * rows).fill(-2)
    let queue = all[0]
    for (const k of queue) from[k] = -1
    let hit = -1
    while (queue.length && hit < 0) {
      const nextQ: number[] = []
      for (const c of queue) {
        const x = c % cols
        const z = (c - x) / cols
        for (const [dx, dz] of SIDES) {
          const nx = x + dx, nz = z + dz
          if (nx < 0 || nz < 0 || nx >= cols || nz >= rows) continue
          const n = nz * cols + nx
          if (from[n] !== -2) continue
          from[n] = c
          if (ground[n] && !main.has(n)) { hit = n; break }
          nextQ.push(n)
        }
        if (hit >= 0) break
      }
      queue = nextQ
    }
    if (hit < 0) return
    const lo = -Math.floor((BRIDGE_CELLS - 1) / 2)
    for (let c = from[hit]; c >= 0 && !main.has(c); c = from[c]) {
      const x = c % cols
      const z = (c - x) / cols
      for (let dz = lo; dz < lo + BRIDGE_CELLS; dz++) for (let dx = lo; dx < lo + BRIDGE_CELLS; dx++) {
        const nx = x + dx, nz = z + dz
        if (nx > 0 && nz > 0 && nx < cols - 1 && nz < rows - 1) ground[nz * cols + nx] = 'grass'
      }
    }
  }
}

/** Steps from each land cell to the nearest sea (4-neighbours): 0 on the coast. Sea cells get -1. */
function seaDistance(ground: Array<Ground | null>, cols: number, rows: number): Int32Array {
  const d = new Int32Array(cols * rows).fill(-1)
  let queue: number[] = []
  for (let k = 0; k < ground.length; k++) {
    if (!ground[k]) continue
    const x = k % cols
    const z = (k - x) / cols
    if (SIDES.some(([dx, dz]) => { const nx = x + dx, nz = z + dz; return nx < 0 || nz < 0 || nx >= cols || nz >= rows || !ground[nz * cols + nx] })) {
      d[k] = 0
      queue.push(k)
    }
  }
  while (queue.length) {
    const nextQ: number[] = []
    for (const c of queue) {
      const x = c % cols
      const z = (c - x) / cols
      for (const [dx, dz] of SIDES) {
        const n = (z + dz) * cols + x + dx
        if (x + dx < 0 || z + dz < 0 || x + dx >= cols || z + dz >= rows || !ground[n] || d[n] >= 0) continue
        d[n] = d[c] + 1
        nextQ.push(n)
      }
    }
    queue = nextQ
  }
  return d
}

/** Sea cells the grid's border can't reach through sea become grass. */
function fillLakes(ground: Array<Ground | null>, cols: number, rows: number) {
  const open = new Uint8Array(cols * rows)
  const stack: number[] = []
  for (let x = 0; x < cols; x++) stack.push(x, (rows - 1) * cols + x)
  for (let z = 0; z < rows; z++) stack.push(z * cols, z * cols + cols - 1)
  while (stack.length) {
    const c = stack.pop()!
    if (open[c] || ground[c]) continue
    open[c] = 1
    const x = c % cols
    const z = (c - x) / cols
    for (const [dx, dz] of SIDES) {
      const nx = x + dx, nz = z + dz
      if (nx >= 0 && nz >= 0 && nx < cols && nz < rows) stack.push(nz * cols + nx)
    }
  }
  for (let k = 0; k < ground.length; k++) if (!ground[k] && !open[k]) ground[k] = 'grass'
}
