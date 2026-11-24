// The public places the island grows by itself (core/landmarks.ts), each on ground of its own as large as a company's
// plot: what stands where at each stage, in cells from the ground's corner. The park's is in park.ts; the hill, the
// pond, the pier and the clock tower are here. Pure data, no three.js.

import type { LandmarkKind } from './core/domain/types'
import type { Prop, Rect } from './layout'
import { PARK_CELLS, parkLoop, parkPlan, PARK_STAGES, type ParkTree } from './park'

/** A cell, as [x, z]. */
export type Cell = [number, number]

/**
 * What someone stopping at a sight does: looks out over the island or the water, tosses a coin into the fountain,
 * looks up at the clock, looks through the telescope, or reads the stone tablet.
 */
export type SightKind = 'view' | 'coin' | 'up' | 'scope' | 'read'

/** Where people stop and look, facing `face`. */
export interface Sight { x: number; z: number; face: [number, number]; kind: SightKind }

/** A seat on an edge, as along a pier: sat on `top` above what is walked there, facing `face`, reached from its own cell. */
export interface Ledge { x: number; z: number; face: [number, number]; top: number }

/** What a landmark has standing on its ground at one stage, in its own cells. */
export interface SitePlan {
  /** Paths and paving, one cell each: walked as a footpath is. */
  walks: Cell[]
  /** Benches, facing where they are reached from, and lamp posts. */
  props: Prop[]
  /** Flower beds and planters. */
  beds: Rect[]
  /** Picnic blankets, two cells along x: one sits on each cell, facing the other. */
  blankets: Rect[]
  trees: ParkTree[]
  /** Anything else nobody walks through: a bandstand, a fountain, a tower, a hill's steep sides. */
  blocks: Rect[]
  /** Water drawn on the ground, a lake: not walked on, but for what is `raised` over it. */
  water: Cell[]
  /**
   * The sea: cells of the ground left out of the island, as a harbour's, walked on only where `raised` over it. Always
   * along the ground's back (-z) edge, before it is turned to face open sea (`turnCell`).
   */
  sea: Cell[]
  /** Cells walked on above the ground, and how high: a hill's terraces and steps, a bridge, a pier. */
  raised: Array<[number, number, number]>
  sights: Sight[]
  ledges: Ledge[]
  /** The corners of a loop walked once round, in order; its sides run along `walks`. */
  loop: Cell[] | null
}

export { PARK_CELLS }

/** The cells in front of a landmark's way in, just past its ground's front (+z) edge: where the footpath joins it. */
export const SITE_DOOR: Cell = [7, PARK_CELLS]

/** The tallest a step between two cells may be, in world units: anything higher is a wall. */
export const MAX_STEP = 0.6

/** Each landmark's stages, and what stands on its ground at each. */
export const SITES: Record<LandmarkKind, { stages: number; plan: (stage: number) => SitePlan }> = {
  park: { stages: PARK_STAGES, plan: parkSite },
  hill: { stages: 2, plan: hillPlan },
  pond: { stages: 2, plan: pondPlan },
  dock: { stages: 2, plan: dockPlan },
  clock: { stages: 1, plan: clockPlan },
}

/** A landmark's plan at `stage`, held to its first and last. */
export const sitePlan = (kind: LandmarkKind, stage: number) => SITES[kind].plan(Math.max(1, Math.min(stage, SITES[kind].stages)))

/** The park (park.ts), its bandstand the one thing standing in it nobody walks through. */
function parkSite(stage: number): SitePlan {
  const { gazebo, ...plan } = parkPlan(stage)
  return { ...empty(), ...plan, blocks: gazebo ? [gazebo] : [], loop: parkLoop(stage) }
}

// ---------------------------------------------------------------- the hill

/** The hill's terraces, from the foot up, each `HILL_RISE` higher than the one below; its top is `HILL_TOP` up. */
export const HILL_LEVELS = 5
export const HILL_RISE = 0.72
export const HILL_TOP = HILL_LEVELS * HILL_RISE

/** Each terrace from the foot up, a cell in from the one below: how far it reaches from the middle, and its corners rounded off. */
const TERRACES: Array<[number, number]> = [[6.5, 10], [5.5, 8], [4.5, 6], [3.5, 5], [2.5, 5]]

/** Which terrace a cell of the hill is on: 0 for the ground round it, `HILL_LEVELS` for its top. */
export function hillLevel(x: number, z: number): number {
  const dx = Math.abs(x - 7.5), dz = Math.abs(z - 7.5)
  let level = 0
  for (const [reach, round] of TERRACES) {
    if (dx > reach || dz > reach || dx + dz > round) break
    level++
  }
  return level
}

/** The stone steps up the front, cut into the terraces from the foot to the top, and how high each is. */
export const HILL_STAIRS: Array<[number, number, number]> = [14, 13, 12, 11, 10].flatMap((z, k) => [[7, z, (k + 1) * 0.6], [8, z, (k + 1) * 0.6]] as Array<[number, number, number]>)

/** Where the lookout's telescope and stone tablet stand, on the top's edge, and where people stand to use them. */
export const TELESCOPE: Cell = [8, 5]
export const STELE: Cell = [5, 7]

/** The top, walked on: its cells with the top all round them; its edge is the drop to the terrace below. */
const onTop = (x: number, z: number) => SIDES.every(([dx, dz]) => hillLevel(x + dx, z + dz) === HILL_LEVELS) && hillLevel(x, z) === HILL_LEVELS

/**
 * A hill of five terraces, with stone steps cut up the front and a gravel path round its foot; trees and a bench at
 * two corners, people on top looking out. Then a stone lookout on its top: paving, a parapet round it, pillars at the
 * corners, a stone tablet and a telescope.
 */
function hillPlan(stage: number): SitePlan {
  const plan = empty()
  const stairs = new Set(HILL_STAIRS.map(([x, z]) => `${x},${z}`))
  plan.raised = [...HILL_STAIRS]
  for (const [x, z] of square(0, 15)) {
    if (!hillLevel(x, z) || stairs.has(`${x},${z}`)) continue
    if (onTop(x, z)) plan.raised.push([x, z, HILL_TOP])
    else plan.blocks.push({ x, z, w: 1, d: 1 })
  }
  plan.walks = square(0, 15).filter(([x, z]) => x === 0 || x === 15 || z === 0 || z === 15)
  plan.loop = [[0, 0], [15, 0], [15, 15], [0, 15]]
  plan.trees = [{ x: 13, z: 1, height: 3, variant: 1 }, { x: 1, z: 13, height: 2, variant: 0 }]
  plan.props = [bench(1, 1, 2, 1, [0, -1]), bench(13, 14, 2, 1, [0, 1]), lamp(1, 2), lamp(14, 13)]
  if (stage < 2) {
    plan.sights = [sight(6, 6, [-1, -1], 'view'), sight(9, 6, [1, -1], 'view'), sight(6, 9, [-1, 1], 'view'), sight(9, 9, [1, 1], 'view')]
    return plan
  }
  plan.sights = [
    sight(TELESCOPE[0], TELESCOPE[1] + 1, [0, -1], 'scope'), sight(STELE[0] + 1, STELE[1], [-1, 0], 'read'),
    sight(9, 6, [1, -1], 'view'), sight(6, 9, [-1, 1], 'view'), sight(9, 9, [1, 1], 'view'),
  ]
  return plan
}

// ---------------------------------------------------------------- the pond

/** The lake's water: an oval over most of the ground, from the bank at the front to the back. */
export const inLake = (x: number, z: number) => ((x - 7.5) / 6) ** 2 + ((z - 6.5) / 4.6) ** 2 <= 1

/** How high the wooden bridge over the lake is along it, at row `z`: arched, highest in the middle. */
export const bridgeHeight = (z: number) => 0.15 + 0.55 * Math.sin((Math.PI * (z - 1)) / 11)

/** The fountain's basin, in the middle of its paved square. */
export const FOUNTAIN: Rect = { x: 6, z: 6, w: 4, d: 4 }

/**
 * A fountain in the middle of a paved square, with benches round it facing it, and flower beds in the corners; people
 * stand round it tossing coins. Then a lake: an oval of water with a wooden bridge across it, front to back, and a
 * gravel path round it; people stand on the bridge and look at the water.
 */
function pondPlan(stage: number): SitePlan {
  const plan = empty()
  const way: Cell[] = [[7, 13], [8, 13], [7, 14], [8, 14], [7, 15], [8, 15]]
  if (stage < 2) {
    plan.blocks = [FOUNTAIN]
    plan.props = [bench(6, 3, 2, 1, [0, 1]), bench(3, 8, 1, 2, [1, 0]), bench(12, 6, 1, 2, [-1, 0]), bench(9, 12, 2, 1, [0, -1]), lamp(6, 13), lamp(9, 13), lamp(4, 4), lamp(11, 4)]
    plan.beds = [{ x: 1, z: 1, w: 2, d: 2 }, { x: 13, z: 1, w: 2, d: 2 }, { x: 1, z: 13, w: 2, d: 2 }, { x: 13, z: 13, w: 2, d: 2 }]
    plan.trees = [{ x: 0, z: 6, height: 3, variant: 0 }, { x: 14, z: 6, height: 2, variant: 1 }]
    const plaza = square(3, 12).filter(([x, z]) => Math.abs(x - 7.5) + Math.abs(z - 7.5) <= 8)
    plan.walks = [...plaza, ...way].filter(([x, z]) => !covers([plan.blocks, plan.props], x, z))
    plan.sights = [sight(7, 5, [0, 1], 'coin'), sight(10, 7, [-1, 0], 'coin'), sight(5, 8, [1, 0], 'coin'), sight(8, 10, [0, -1], 'coin')]
    plan.loop = [[5, 5], [10, 5], [10, 10], [5, 10]]
    return plan
  }
  plan.water = square(0, 15).filter(([x, z]) => inLake(x, z))
  plan.raised = range(2, 11).flatMap((z) => [[7, z, bridgeHeight(z)], [8, z, bridgeHeight(z)]] as Array<[number, number, number]>)
  const ring = square(1, 14).filter(([x, z]) => (x === 1 || x === 14 || z === 1 || z === 12) && z <= 12)
  plan.walks = [...ring, ...way.filter(([, z]) => z > 12)]
  plan.loop = [[1, 1], [14, 1], [14, 12], [1, 12]]
  plan.props = [bench(4, 13, 2, 1, [0, -1]), bench(10, 13, 2, 1, [0, -1]), bench(0, 6, 1, 2, [1, 0]), bench(15, 6, 1, 2, [-1, 0]), lamp(6, 13), lamp(9, 13)]
  plan.trees = [{ x: 2, z: 2, height: 3, variant: 0 }, { x: 12, z: 2, height: 2, variant: 1 }, { x: 2, z: 10, height: 2, variant: 1 }, { x: 12, z: 10, height: 3, variant: 0 }]
  plan.sights = [sight(7, 6, [-1, 0], 'view'), sight(8, 7, [1, 0], 'view'), sight(1, 4, [1, 0], 'view'), sight(14, 9, [-1, 0], 'view')]
  return plan
}

// ---------------------------------------------------------------- the pier

/** The pier's ground is land only from this row to its front; the rows behind are the sea, its harbour. */
export const QUAY_ROW = 9

/** The harbour: the sea behind the quay, the whole width of the ground. */
export const HARBOUR: Rect = { x: 0, z: 0, w: PARK_CELLS, d: QUAY_ROW }

/** How high the pier's boards are, in world units. */
export const PIER_TOP = 0.35

/** The pier: out from the quay into the harbour, with a crosspiece at its end. */
export const PIER: Cell[] = [...range(3, 8).flatMap((z): Cell[] => [[7, z], [8, z]]), ...[5, 6, 9, 10].flatMap((x): Cell[] => [[x, 2], [x, 3]]), [7, 2], [8, 2]]

/** The boats moored in the harbour once there are enough companies: two rowing boats and a sailing boat. */
export const BOATS: Array<{ x: number; z: number; long: number; sail: boolean }> = [
  { x: 4, z: 6, long: 2, sail: false }, { x: 10, z: 5, long: 2, sail: false }, { x: 2, z: 2, long: 2, sail: true },
]

/**
 * A stone quay on the coast with a wooden pier out over the sea, bollards along the quay, a shed and a stack of crates;
 * people walk out to the end of the pier and sit on its edge with their legs over the water. Then boats, moored off
 * the quay. Its ground's back is the sea itself, turned to face open sea wherever it stands.
 */
function dockPlan(): SitePlan {
  const plan = empty()
  plan.sea = cellsOf(HARBOUR)
  plan.raised = PIER.map(([x, z]): [number, number, number] => [x, z, PIER_TOP])
  // bollards along the quay's edge, two either side of the pier
  plan.blocks = [2, 6, 9, 13].map((x) => ({ x, z: 9, w: 1, d: 1 }))
  plan.blocks.push(SHED, CRATES)
  plan.props = [bench(3, 10, 2, 1, [0, -1]), bench(11, 10, 2, 1, [0, -1]), lamp(1, 10), lamp(14, 10)]
  plan.trees = [{ x: 0, z: 13, height: 2, variant: 0 }]
  const quay = [9, 10].flatMap((z) => range(0, 15).map((x): Cell => [x, z]))
  plan.walks = [...quay, ...range(11, 15).flatMap((z): Cell[] => [[7, z], [8, z]])].filter(([x, z]) => !covers([plan.blocks, plan.props], x, z))
  plan.ledges = [
    ...[5, 6, 9, 10].map((x): Ledge => ({ x, z: 2, face: [0, -1], top: 0 })),
    { x: 7, z: 5, face: [-1, 0], top: 0 }, { x: 8, z: 6, face: [1, 0], top: 0 },
  ]
  plan.sights = [sight(7, 2, [0, -1], 'view'), sight(8, 2, [0, -1], 'view')]
  return plan
}

/** The harbour master's shed, and the crates stacked on the quay. */
export const SHED: Rect = { x: 12, z: 12, w: 3, d: 3 }
export const CRATES: Rect = { x: 2, z: 12, w: 2, d: 1 }

// ---------------------------------------------------------------- the clock tower

/** The clock tower, in the middle of its square. */
export const CLOCK_TOWER: Rect = { x: 6, z: 6, w: 4, d: 4 }

/**
 * A clock tower in the middle of a cobbled square, its four faces telling the time, with benches round it, planters
 * in the corners and lamps; people stop and look up at it.
 */
function clockPlan(): SitePlan {
  const plan = empty()
  plan.blocks = [CLOCK_TOWER]
  plan.beds = [{ x: 1, z: 1, w: 2, d: 2 }, { x: 13, z: 1, w: 2, d: 2 }, { x: 1, z: 13, w: 2, d: 2 }, { x: 13, z: 13, w: 2, d: 2 }]
  plan.props = [bench(6, 2, 2, 1, [0, 1]), bench(2, 7, 1, 2, [1, 0]), bench(13, 7, 1, 2, [-1, 0]), bench(9, 13, 2, 1, [0, -1]), lamp(4, 4), lamp(11, 4), lamp(4, 11), lamp(11, 11)]
  plan.trees = [{ x: 0, z: 4, height: 3, variant: 0 }, { x: 14, z: 9, height: 3, variant: 1 }]
  plan.walks = square(0, 15).filter(([x, z]) => !covers([plan.blocks, plan.props, plan.beds, plan.trees.map((t) => ({ ...t, w: 2, d: 2 }))], x, z))
  plan.sights = [sight(7, 5, [0, 1], 'up'), sight(10, 7, [-1, 0], 'up'), sight(5, 8, [1, 0], 'up'), sight(8, 10, [0, -1], 'up')]
  plan.loop = [[5, 5], [10, 5], [10, 10], [5, 10]]
  return plan
}

// ---------------------------------------------------------------- helpers

const SIDES: Cell[] = [[1, 0], [-1, 0], [0, 1], [0, -1]]

function empty(): SitePlan {
  return { walks: [], props: [], beds: [], blankets: [], trees: [], blocks: [], water: [], sea: [], raised: [], sights: [], ledges: [], loop: null }
}

// ---------------------------------------------------------------- turning a landmark round

/** Quarter turns: where a cell of a landmark's ground goes, turned `q` times so its back (-z) faces +x, then +z, then -x. */
export function turnCell(q: number, [x, z]: Cell): Cell {
  const n = PARK_CELLS - 1
  switch (((q % 4) + 4) % 4) {
    case 1: return [n - z, x]
    case 2: return [n - x, n - z]
    case 3: return [z, n - x]
    default: return [x, z]
  }
}

/** A way to face, turned as `turnCell` turns a cell. */
export function turnFace(q: number, [x, z]: [number, number]): [number, number] {
  switch (((q % 4) + 4) % 4) {
    case 1: return [-z, x]
    case 2: return [-x, -z]
    case 3: return [z, -x]
    default: return [x, z]
  }
}

/** A rectangle of cells, turned as `turnCell` turns them. */
export function turnRect<T extends Rect>(q: number, r: T): T {
  const [ax, az] = turnCell(q, [r.x, r.z])
  const [bx, bz] = turnCell(q, [r.x + r.w - 1, r.z + r.d - 1])
  const odd = q % 2 !== 0
  return { ...r, x: Math.min(ax, bx), z: Math.min(az, bz), w: odd ? r.d : r.w, d: odd ? r.w : r.d }
}

/** Which way the back of a landmark's ground faces once turned `q` times: -z, +x, +z, -x. */
export const backOf = (q: number) => turnFace(q, [0, -1])

/** The top-left cell of the two-by-two square just past a landmark's way in (`SITE_DOOR`), turned `q` times. */
export function doorOf(q: number): Cell {
  const cells = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([dx, dz]) => turnCell(q, [SITE_DOOR[0] + dx, SITE_DOOR[1] + dz]))
  return [Math.min(...cells.map((c) => c[0])), Math.min(...cells.map((c) => c[1]))]
}

/** A landmark's plan turned `q` times. */
export function turnPlan(q: number, plan: SitePlan): SitePlan {
  if (!(((q % 4) + 4) % 4)) return plan
  const cell = (c: Cell) => turnCell(q, c)
  const faced = <T extends { face?: [number, number] }>(r: T): T => (r.face ? { ...r, face: turnFace(q, r.face) } : r)
  const spot = <T extends { x: number; z: number }>(r: T): T => {
    const [x, z] = cell([r.x, r.z])
    return { ...r, x, z }
  }
  return {
    walks: plan.walks.map(cell),
    props: plan.props.map((r) => faced(turnRect(q, r))),
    beds: plan.beds.map((r) => turnRect(q, r)),
    blankets: plan.blankets.map((r) => turnRect(q, r)),
    trees: plan.trees.map((t) => {
      const { x, z } = turnRect(q, { x: t.x, z: t.z, w: 2, d: 2 })
      return { ...t, x, z }
    }),
    blocks: plan.blocks.map((r) => turnRect(q, r)),
    water: plan.water.map(cell),
    sea: plan.sea.map(cell),
    raised: plan.raised.map(([x, z, h]): [number, number, number] => [...cell([x, z]), h]),
    sights: plan.sights.map((v) => faced(spot(v))),
    ledges: plan.ledges.map((v) => faced(spot(v))),
    loop: plan.loop && plan.loop.map(cell),
  }
}

export function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i)
}

/** Every cell of the square from (from, from) to (to, to), row by row. */
export function square(from: number, to: number): Cell[] {
  return range(from, to).flatMap((z) => range(from, to).map((x): Cell => [x, z]))
}

export function cellsOf(r: Rect): Cell[] {
  return Array.from({ length: r.w * r.d }, (_, k): Cell => [r.x + (k % r.w), r.z + Math.floor(k / r.w)])
}

const covers = (groups: Rect[][], x: number, z: number) => groups.some((g) => g.some((r) => x >= r.x && x < r.x + r.w && z >= r.z && z < r.z + r.d))

function sight(x: number, z: number, face: [number, number], kind: SightKind): Sight {
  return { x, z, face, kind }
}

function bench(x: number, z: number, w: number, d: number, face: [number, number]): Prop {
  return { x, z, w, d, kind: 'bench', face }
}

function lamp(x: number, z: number): Prop {
  return { x, z, w: 1, d: 1, kind: 'lamp' }
}
