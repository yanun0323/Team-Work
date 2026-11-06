// Where people can walk, and how they get there: grids of free cells, shortest paths, and moving along
// them. Pure data, no three.js. Used inside an opened office (office units) and on the island (world units).

import { CELL, cellCenter, hash, TREE_CELLS, type Town } from './layout'
import type { Area, OfficePlan } from './office'

export type P = [number, number]

export interface Grid {
  cols: number
  rows: number
  /** 1 where someone can stand. Index with `z * cols + x`. */
  free: Uint8Array
  /** Position of cell (0, 0)'s centre, and the distance between cell centres. */
  x0: number
  z0: number
  step: number
}

export const isFree = (g: Grid, x: number, z: number) => x >= 0 && z >= 0 && x < g.cols && z < g.rows && g.free[z * g.cols + x] === 1
export const cellPos = (g: Grid, x: number, z: number): P => [g.x0 + x * g.step, g.z0 + z * g.step]
const cellOf = (g: Grid, px: number, pz: number): P => [Math.round((px - g.x0) / g.step), Math.round((pz - g.z0) / g.step)]

/** Every free cell, as [x, z]. */
export function freeCells(g: Grid): P[] {
  const out: P[] = []
  for (let z = 0; z < g.rows; z++) for (let x = 0; x < g.cols; x++) if (g.free[z * g.cols + x]) out.push([x, z])
  return out
}

/** The free cell whose centre is nearest a point. */
export function nearestFree(g: Grid, px: number, pz: number): P | null {
  let best: P | null = null
  let bestD = Infinity
  for (const [x, z] of freeCells(g)) {
    const [cx, cz] = cellPos(g, x, z)
    const d = (cx - px) ** 2 + (cz - pz) ** 2
    if (d < bestD) [best, bestD] = [[x, z], d]
  }
  return best
}

const DIRS: Array<[number, number, number]> = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
]

/**
 * Least-cost path between two free cells, as cell centres from start to goal. Optional nonnegative
 * per-cell penalties represent traffic; without them this is shortest distance. Never cuts blocked corners.
 */
export function findPath(g: Grid, from: P, to: P, penalties?: Float64Array): P[] | null {
  if (!isFree(g, ...from) || !isFree(g, ...to)) return null
  const n = g.cols * g.rows
  const cost = new Float64Array(n).fill(Infinity)
  const prev = new Int32Array(n).fill(-1)
  const start = from[1] * g.cols + from[0]
  const goal = to[1] * g.cols + to[0]
  cost[start] = 0
  // a binary heap of [cost, index]
  const heap: Array<[number, number]> = [[0, start]]
  const push = (e: [number, number]) => {
    heap.push(e)
    for (let i = heap.length - 1; i > 0;) {
      const p = (i - 1) >> 1
      if (heap[p][0] <= heap[i][0]) break
      ;[heap[p], heap[i]] = [heap[i], heap[p]]
      i = p
    }
  }
  const pop = () => {
    const top = heap[0]
    const last = heap.pop() as [number, number]
    if (heap.length) {
      heap[0] = last
      for (let i = 0; ;) {
        const l = i * 2 + 1
        const r = l + 1
        let m = i
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r
        if (m === i) break
        ;[heap[m], heap[i]] = [heap[i], heap[m]]
        i = m
      }
    }
    return top
  }
  while (heap.length) {
    const [c, i] = pop()
    if (i === goal) break
    if (c > cost[i]) continue
    const x = i % g.cols
    const z = (i - x) / g.cols
    for (const [dx, dz, step] of DIRS) {
      const nx = x + dx
      const nz = z + dz
      if (!isFree(g, nx, nz)) continue
      if (dx && dz && (!isFree(g, x + dx, z) || !isFree(g, x, z + dz))) continue
      const j = nz * g.cols + nx
      const next = c + step * (1 + ((penalties?.[i] ?? 0) + (penalties?.[j] ?? 0)) / 2)
      if (next < cost[j]) {
        cost[j] = next
        prev[j] = i
        push([next, j])
      }
    }
  }
  if (goal !== start && prev[goal] < 0) return null
  const cells: number[] = []
  for (let i = goal; i >= 0; i = i === start ? -1 : prev[i]) cells.push(i)
  return cells.reverse().map((i) => cellPos(g, i % g.cols, Math.floor(i / g.cols)))
}

/** True when a straight walk between two points only crosses free cells. */
export function clearWalk(g: Grid, a: P, b: P) {
  const steps = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (g.step * 0.25))
  for (let k = 0; k <= steps; k++) {
    const t = steps ? k / steps : 0
    const px = a[0] + (b[0] - a[0]) * t
    const pz = a[1] + (b[1] - a[1]) * t
    // the cells a little either side too, so people keep clear of corners
    for (const [ox, oz] of [[0, 0], [0.3, 0.3], [-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3]]) {
      if (!isFree(g, ...cellOf(g, px + ox * g.step, pz + oz * g.step))) return false
    }
  }
  return true
}

/** Travel cost along a segment, also used so smoothing cannot erase a less-crowded detour. */
export function walkCost(g: Grid, a: P, b: P, penalties?: Float64Array) {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1])
  if (!penalties) return length
  const n = Math.max(1, Math.ceil(length / (g.step * 0.25)))
  let cost = 0
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n
    const [x, z] = cellOf(g, a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
    cost += 1 + (penalties[z * g.cols + x] ?? 0)
  }
  return length * cost / n
}

/** Drops unnecessary corners, but never shortcuts through a more expensive crowded area. */
export function smooth(g: Grid, path: P[], penalties?: Float64Array): P[] {
  if (path.length <= 2) return path
  const out: P[] = [path[0]]
  const costs = [0]
  for (let k = 1; k < path.length; k++) costs.push(costs[k - 1] + walkCost(g, path[k - 1], path[k], penalties))
  let i = 0
  while (i < path.length - 1) {
    let j = path.length - 1
    while (j > i + 1 && (!clearWalk(g, path[i], path[j]) || (penalties && walkCost(g, path[i], path[j], penalties) > costs[j] - costs[i] + 1e-6))) j--
    out.push(path[j])
    i = j
  }
  return out
}

/** A route over the grid between two points, smoothed; empty when there is none. */
export function route(g: Grid, from: P, to: P, penalties?: Float64Array): P[] {
  const a = nearestFree(g, ...from)
  const b = nearestFree(g, ...to)
  if (!a || !b) return []
  const path = findPath(g, a, b, penalties)
  return path ? smooth(g, path, penalties) : []
}

/** The way to sit on a bench seat, through its front cell; empty when the seat can't be reached from here. */
export function seatRoute(g: Grid, from: P, seat: BenchSeat): P[] {
  const way = route(g, from, seat.front)
  return way.length ? [...way, seat.at] : []
}

/** A person moving through a list of points. */
export interface Walker {
  x: number
  z: number
  /** Points still to reach, in order. */
  route: P[]
  /** Direction faced, as a rotation about the vertical axis; 0 looks towards -z. */
  heading: number
}

/** The rotation that faces a direction on the ground; 0 looks towards -z. */
export const headingOf = (dx: number, dz: number) => Math.atan2(-dx, -dz)

/** Moves a walker `dist` along its route. Returns how far it actually went (less once it arrives). */
/**
 * Runs `step` over `dt` seconds in pieces of at most `piece`, so a long frame (a slow background frame)
 * still moves people a little at a time: nobody walks through someone they should queue behind.
 */
export function inSteps(dt: number, step: (dt: number) => void, piece = 0.1) {
  for (let left = dt; left > 1e-9; left -= piece) step(Math.min(piece, left))
}

export function advance(w: Walker, dist: number): number {
  let left = dist
  while (left > 0 && w.route.length) {
    const [tx, tz] = w.route[0]
    const dx = tx - w.x
    const dz = tz - w.z
    const d = Math.hypot(dx, dz)
    if (d > 1e-6) w.heading = headingOf(dx, dz)
    if (d <= left) {
      w.x = tx
      w.z = tz
      left -= d
      w.route.shift()
    } else {
      w.x += (dx / d) * left
      w.z += (dz / d) * left
      left = 0
    }
  }
  return dist - left
}

// ---------------------------------------------------------------- the two grids

/** Office walking cells, in office units: about a third of a person's stride. */
const OFFICE_STEP = 0.5
/** Room kept between a walker's centre and furniture or walls, in office units. */
const OFFICE_CLEAR = 0.25

/** Free floor in an office: everything but furniture, plants and the strip along the walls. */
export function officeGrid(plan: OfficePlan): Grid {
  const n = Math.floor((plan.half * 2 - OFFICE_CLEAR * 2) / OFFICE_STEP) + 1
  const x0 = (-(n - 1) * OFFICE_STEP) / 2
  const blocks: Area[] = [
    ...plan.stations, plan.nook, ...[plan.reception, plan.meeting, plan.lounge, plan.shelf].filter((a) => !!a),
    ...plan.plants.map(([x, z]) => ({ x, z, w: 0.5, d: 0.5 })),
    ...(plan.cooler ? [{ x: plan.cooler[0], z: plan.cooler[1], w: 0.4, d: 0.4 }] : []),
  ]
  const free = new Uint8Array(n * n)
  for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) {
    const px = x0 + x * OFFICE_STEP
    const pz = x0 + z * OFFICE_STEP
    const hit = blocks.some((b) => Math.abs(px - b.x) < b.w / 2 + OFFICE_CLEAR && Math.abs(pz - b.z) < b.d / 2 + OFFICE_CLEAR)
    free[z * n + x] = hit ? 0 : 1
  }
  return { cols: n, rows: n, free, x0, z0: x0, step: OFFICE_STEP }
}

/** Free land on the island, in world units: grass and paving, a cell clear of buildings, clear of trees, street furniture and the shore. */
export function townGrid(town: Town): Grid {
  const free = new Uint8Array(town.cols * town.rows)
  for (let i = 0; i < free.length; i++) free[i] = town.ground[i] === 'grass' || town.ground[i] === 'pave' ? 1 : 0
  const block = (x: number, z: number, w: number, d: number) => {
    for (let k = z; k < z + d; k++) for (let j = x; j < x + w; j++) free[k * town.cols + j] = 0
  }
  for (const l of town.lots) {
    // a cell's margin all round, as a figure has width and a wall shouldn't clip it
    block(l.building.x - 1, l.building.z - 1, l.building.w + 2, l.building.d + 2)
    for (const p of l.props) block(p.x, p.z, p.w, p.d)
  }
  for (const t of town.trees) block(t.x, t.z, TREE_CELLS, TREE_CELLS)
  const [x0, z0] = cellCenter(town, 0, 0)
  return { cols: town.cols, rows: town.rows, free, x0, z0, step: CELL }
}

/** What the crowd keeps track of on the island. */
export interface Stroller extends Walker {
  mode: 'walking' | 'standing' | 'sitting'
  wait: number
  /** The bench seat held, while going to it or sitting on it. */
  seat: BenchSeat | null
  /** On the way to sit down. */
  toSeat: boolean
}

/**
 * The land changed: a building grew or a company moved, perhaps over someone or their way. Nobody stays on what is
 * now blocked, and every route is worked out again, so that none crosses the new building.
 */
export function resettle(people: Stroller[], g: Grid, seats: BenchSeat[], diameter = 0) {
  const placed: Stroller[] = people.filter((p) => p.mode === 'sitting' && seats.some((s) => `${s.at}` === `${p.seat?.at}`))
  const positions = diameter > 0 ? freeCells(g).map(([x, z]) => cellPos(g, x, z)) : []
  const sameSeat = (s: BenchSeat | null) => seats.find((x) => s && `${x.at}` === `${s.at}`) ?? null
  for (const p of people) {
    p.seat = sameSeat(p.seat)
    if (p.mode === 'sitting' && p.seat) continue
    if (p.mode === 'sitting') p.mode = 'standing'
    if (!p.seat) p.toSeat = false
    const available = ([x, z]: P) => placed.every((q) => Math.hypot(q.x - x, q.z - z) >= diameter)
    if (!isFree(g, ...cellOf(g, p.x, p.z)) || !available([p.x, p.z])) {
      if (diameter > 0) {
        const at = positions.filter(available).sort((a, b) => Math.hypot(a[0] - p.x, a[1] - p.z) - Math.hypot(b[0] - p.x, b[1] - p.z))[0]
        if (at) [p.x, p.z] = at
      } else {
        const near = nearestFree(g, p.x, p.z)
        if (near) [p.x, p.z] = cellPos(g, ...near)
      }
    }
    placed.push(p)
    if (p.mode !== 'walking') continue
    if (p.toSeat && p.seat) {
      p.route = seatRoute(g, [p.x, p.z], p.seat)
      // cut off from the bench: let it go rather than walk straight there
      if (!p.route.length) [p.seat, p.toSeat] = [null, false]
      continue
    }
    const goal = p.route.at(-1)
    p.route = goal ? route(g, [p.x, p.z], goal) : []
  }
}

/** How many people are out on the island: two to five per building. */
export function crowdSize(town: Town) {
  return town.lots.reduce((sum, l, i) => sum + 2 + Math.floor(hash(l.plot.x, l.plot.z, i, 11) * 4), 0)
}

/** A seat on a bench: where to sit, the free cell in front to get there from, and the way to face. */
export interface BenchSeat {
  at: P
  front: P
  heading: number
}

/** Two seats on each bench, one per cell, each reached from the free cell it faces. */
export function benchSeats(town: Town, g: Grid): BenchSeat[] {
  const out: BenchSeat[] = []
  for (const l of town.lots) for (const p of l.props) {
    if (p.kind !== 'bench' || !p.face) continue
    const [fx, fz] = p.face
    for (let k = 0; k < Math.max(p.w, p.d); k++) {
      const cx = p.x + (p.w > 1 ? k : 0)
      const cz = p.z + (p.d > 1 ? k : 0)
      if (!isFree(g, cx + fx, cz + fz)) continue
      const [x, z] = cellCenter(town, cx, cz)
      // a little back from the middle of the seat, against the backrest
      out.push({ at: [x - fx * 0.1, z - fz * 0.1], front: cellCenter(town, cx + fx, cz + fz), heading: headingOf(fx, fz) })
    }
  }
  return out
}
