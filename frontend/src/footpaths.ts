// Footpaths over the island's grass: every company's front door joined to the staffing agency's, two cells wide,
// in straight runs with few turns, with lamp posts along them. Pure data over the town's ground cells.

import type { Ground, Rect } from './layout'

/** A step onto cells a path already covers costs this much, so new paths join the old ones instead of running beside them. */
const SHARED_STEP = 0.3
/** A turn costs as much as this many steps, so paths run straight. */
const TURN_STEPS = 3
const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]] as const

/**
 * Lays paths on `ground`, turning the grass under them to `'path'`. A position is the top-left cell of a 2 × 2 square
 * that must lie on grass or path. Starting from `hub`, joins each of `doors` in turn, the cheapest to reach first, by
 * the cheapest way to anything laid so far. A door not on open grass, or walled off from the hub, is left out.
 */
export function layFootpaths(ground: Array<Ground | null>, cols: number, rows: number, hub: [number, number], doors: Array<[number, number]>) {
  const open = (k: number) => ground[k] === 'grass' || ground[k] === 'path'
  const square = (p: number) => [p, p + 1, p + cols, p + cols + 1]
  const fits = ([x, z]: [number, number]) => x >= 0 && z >= 0 && x < cols - 1 && z < rows - 1 && square(z * cols + x).every(open)
  if (!fits(hub)) return
  // states are position × the way it was entered, so a turn can be charged
  const cost = new Float64Array(cols * rows * 4).fill(Infinity)
  const prev = new Int32Array(cols * rows * 4).fill(-1)
  const heap: Array<[number, number]> = []
  const push = (c: number, s: number) => {
    heap.push([c, s])
    for (let i = heap.length - 1; i > 0;) {
      const p = (i - 1) >> 1
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]]
      i = p
    }
  }
  const pop = () => {
    const top = heap[0]
    const last = heap.pop() as [number, number]
    if (heap.length) {
      heap[0] = last
      for (let k = 0; ;) {
        const l = k * 2 + 1
        let m = k
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l
        if (l + 1 < heap.length && heap[l + 1][0] < heap[m][0]) m = l + 1
        if (m === k) break;
        [heap[m], heap[k]] = [heap[k], heap[m]]
        k = m
      }
    }
    return top
  }
  const source = (p: number) => {
    for (let d = 0; d < 4; d++) {
      cost[p * 4 + d] = 0
      prev[p * 4 + d] = -1
      push(0, p * 4 + d)
    }
  }
  // Dijkstra from every source; costs only ever drop, so running it again after adding sources carries on from there
  const spread = () => {
    while (heap.length) {
      const [c, s] = pop()
      if (c > cost[s]) continue
      const p = s >> 2
      const x = p % cols
      const z = (p - x) / cols
      for (let d = 0; d < 4; d++) {
        const next: [number, number] = [x + DIRS[d][0], z + DIRS[d][1]]
        if (!fits(next)) continue
        const np = next[1] * cols + next[0]
        const step = square(np).some((k) => ground[k] === 'path') ? SHARED_STEP : 1
        const nc = c + step + (d === (s & 3) ? 0 : TURN_STEPS)
        if (nc < cost[np * 4 + d]) {
          cost[np * 4 + d] = nc
          prev[np * 4 + d] = s
          push(nc, np * 4 + d)
        }
      }
    }
  }
  source(hub[1] * cols + hub[0])
  spread()
  const left = doors.filter(fits).map(([x, z]) => z * cols + x)
  while (left.length) {
    let best = -1
    for (const p of left) for (let d = 0; d < 4; d++) if (best < 0 || cost[p * 4 + d] < cost[best]) best = p * 4 + d
    if (cost[best] === Infinity) break
    left.splice(left.indexOf(best >> 2), 1)
    const laid: number[] = []
    for (let s = best; s >= 0; s = prev[s]) {
      for (const k of square(s >> 2)) ground[k] = 'path'
      laid.push(s >> 2)
    }
    for (const p of laid) source(p)
    spread()
  }
}

/** Width of the road round every company's plot, in cells. */
export const RING_ROAD = 2

/**
 * Lays a road `RING_ROAD` cells wide on the grass round each plot. Where two plots stand close, their roads run
 * together as one street between them, as wide as the gap; a strip of grass a cell wide left between two roads is
 * paved over too, so a gap a little wider still makes one street rather than two side by side.
 */
export function ringRoads(ground: Array<Ground | null>, cols: number, rows: number, plots: Rect[]) {
  const inside = (x: number, z: number) => x >= 0 && z >= 0 && x < cols && z < rows
  for (const p of plots) for (let z = p.z - RING_ROAD; z < p.z + p.d + RING_ROAD; z++) for (let x = p.x - RING_ROAD; x < p.x + p.w + RING_ROAD; x++) {
    if (inside(x, z) && ground[z * cols + x] === 'grass') ground[z * cols + x] = 'path'
  }
  const road = (x: number, z: number) => inside(x, z) && ground[z * cols + x] === 'path'
  const strip: number[] = []
  for (let z = 0; z < rows; z++) for (let x = 0; x < cols; x++) {
    if (ground[z * cols + x] !== 'grass') continue
    if ((road(x - 1, z) && road(x + 1, z)) || (road(x, z - 1) && road(x, z + 1))) strip.push(z * cols + x)
  }
  for (const k of strip) ground[k] = 'path'
}

export type Cell = [number, number]

/** How a road cell lies (`RoadCells.kind`): in a straight stretch along x or z, or where roads turn or meet. */
export const ALONG_X = 1
export const ALONG_Z = 2
export const NODE = 3
/** The widest a straight stretch can be, in cells: a street between two plots that stand a little apart. */
export const MAX_WIDE = 5

export interface RoadCells {
  /** Per cell: 0 off the road, else `ALONG_X`, `ALONG_Z` or `NODE`. Index with `z * cols + x`. */
  kind: Uint8Array
  /** Per cell in a straight stretch: the first of its cells across the road, a z along x and an x along z. */
  side: Int32Array
  /** Per cell in a straight stretch: how many cells wide the road is there. */
  wide: Uint8Array
}

/**
 * Sorts the road cells. A straight stretch is up to `MAX_WIDE` cells across and runs on further than that along; a
 * stretch wider than two must keep its width for at least as long as it is wide, so where a road joins another from
 * the side, the cells where they meet are not taken for a short stretch of a wider road. Anything else is a node.
 */
export function roadCells(ground: Array<Ground | null>, cols: number, rows: number): RoadCells {
  const n = cols * rows
  const road = (k: number) => ground[k] === 'path'
  // each cell's run of road along x and along z, and where that run starts
  const runs = (len: number, count: number, at: (i: number, t: number) => number) => {
    const length = new Int32Array(n)
    const start = new Int32Array(n)
    for (let i = 0; i < count; i++) for (let t = 0; t < len;) {
      if (!road(at(i, t))) { t++; continue }
      let e = t
      while (e < len && road(at(i, e))) e++
      for (let u = t; u < e; u++) [length[at(i, u)], start[at(i, u)]] = [e - t, t]
      t = e
    }
    return { length, start }
  }
  const h = runs(cols, rows, (z, x) => z * cols + x)
  const v = runs(rows, cols, (x, z) => z * cols + x)
  const kind = new Uint8Array(n)
  const side = new Int32Array(n)
  const wide = new Uint8Array(n)
  // straight along one way: `across` is the run across it, `along` the run along it, `next` the cell after k along it
  const straight = (value: number, across: typeof h, along: typeof h, next: (k: number, t: number) => number) => {
    for (let k = 0; k < n; k++) {
      const w = across.length[k]
      if (kind[k] || !road(k) || w > MAX_WIDE || along.length[k] <= w) continue
      if (w > 2) {
        // as wide for at least as long, either way from k
        let same = 1
        for (const t of [-1, 1]) for (let j = next(k, t); j >= 0 && road(j) && across.length[j] === w && across.start[j] === across.start[k]; j = next(j, t)) same++
        if (same < w) continue
      }
      [kind[k], side[k], wide[k]] = [value, across.start[k], w]
    }
  }
  straight(ALONG_X, v, h, (k, t) => {
    const x = (k % cols) + t
    return x >= 0 && x < cols ? k + t : -1
  })
  straight(ALONG_Z, h, v, (k, t) => {
    const j = k + t * cols
    return j >= 0 && j < n ? j : -1
  })
  for (let k = 0; k < n; k++) if (road(k) && !kind[k]) kind[k] = NODE
  return { kind, side, wide }
}

/** One road leading out of a junction. Traffic keeps to the right, as in Taiwan. */
export interface Arm {
  /** Outward from the junction, along the road: [1, 0], [-1, 0], [0, 1] or [0, -1]. */
  dir: Cell
  /**
   * The road's cells next to the junction, all the way across, where the crosswalk goes: from the edge of the side
   * traffic comes in on to the other edge. Two cells on most roads; a street between two plots may be wider.
   */
  cross: Cell[]
  /** The edge cell on the side coming in, one cell further out, where traffic stops; null when the road is too short. */
  stop: Cell | null
  /**
   * Beside the side coming in, at the crosswalk, for the traffic light facing it: grass, or the outer row of a plot's
   * paving, which is kept clear; null when there is neither.
   */
  pole: Cell | null
}

export interface Junction {
  arms: Arm[]
}

/**
 * Where three or four roads meet, with the roads leading out of each. A road that runs a cell past a turn onto the
 * grass and stops is the corner of the turn, not a road: every real one leads to another junction or to paving, at
 * its end or along its side (a door on a road that passes by).
 */
export function roadJunctions(ground: Array<Ground | null>, cols: number, rows: number): Junction[] {
  const { kind, side, wide } = roadCells(ground, cols, rows)
  const at = (x: number, z: number) => (x >= 0 && z >= 0 && x < cols && z < rows ? z * cols + x : -1)
  const seen = new Uint8Array(cols * rows)
  const out: Junction[] = []
  for (let k = 0; k < kind.length; k++) {
    if (kind[k] !== NODE || seen[k]) continue
    const block = [k]
    seen[k] = 1
    for (let i = 0; i < block.length; i++) {
      const x = block[i] % cols
      const z = (block[i] - x) / cols
      for (const [dx, dz] of DIRS) {
        const j = at(x + dx, z + dz)
        if (j >= 0 && kind[j] === NODE && !seen[j]) {
          seen[j] = 1
          block.push(j)
        }
      }
    }
    const arms = new Map<string, Arm>()
    for (const c of block) for (const [dx, dz] of DIRS) {
      const x = (c % cols) + dx
      const z = Math.floor(c / cols) + dz
      const j = at(x, z)
      const along = dx ? ALONG_X : ALONG_Z
      if (j < 0 || kind[j] !== along) continue
      const key = `${dx},${dz},${dx ? x : z},${side[j]}`
      if (arms.has(key)) continue
      const across: Cell[] = Array.from({ length: wide[j] }, (_, i) => (dx ? [x, side[j] + i] : [side[j] + i, z]))
      // the side coming in: on the right of traffic heading in, -dir; its edge first
      const s: Cell = [dz, -dx]
      if (across[0][0] * s[0] + across[0][1] * s[1] < across[across.length - 1][0] * s[0] + across[across.length - 1][1] * s[1]) across.reverse()
      const lane = across[0]
      const other = across[across.length - 1]
      // how far the stretch runs on, and what it runs into
      let t = 1
      const same = (q: Cell) => {
        const i = at(q[0] + dx * t, q[1] + dz * t)
        return i >= 0 && kind[i] === along && side[i] === side[j] && wide[i] === wide[j]
      }
      while (across.every(same)) t++
      const end = across.map((q) => ground[at(q[0] + dx * t, q[1] + dz * t)] ?? null)
      const onto = end.includes('pave') ? 'pave' : end.includes('path') ? 'path' : null
      const beside = (q: Cell, out: number) => Array.from({ length: t }, (_, u) => ground[at(q[0] + dx * u + s[0] * out, q[1] + dz * u + s[1] * out)]).includes('pave')
      if (!onto && !beside(lane, 1) && !beside(other, -1)) continue
      // another junction's crosswalk takes the last cell before it
      const stop: Cell | null = t >= 3 || (t === 2 && onto === 'pave') ? [lane[0] + dx, lane[1] + dz] : null
      const p = at(lane[0] + s[0], lane[1] + s[1])
      const stand = p >= 0 && (ground[p] === 'grass' || ground[p] === 'pave')
      arms.set(key, { dir: [dx, dz], cross: across, stop, pole: stand ? [lane[0] + s[0], lane[1] + s[1]] : null })
    }
    if (arms.size >= 3) out.push({ arms: [...arms.values()] })
  }
  return out
}

/** Lamps along the footpaths keep at least this many cells apart, either way. */
export const LAMP_GAP = 7

/**
 * Cells for lamp posts along the footpaths: grass (not the shore) right beside a path, `LAMP_GAP` apart, none where
 * `clear` says to keep clear. Picked row by row, so a run of path gets its lamps along one side.
 */
export function lampsAlong(ground: Array<Ground | null>, cols: number, rows: number, clear: (x: number, z: number) => boolean): Array<[number, number]> {
  const at = (x: number, z: number) => (x >= 0 && z >= 0 && x < cols && z < rows ? ground[z * cols + x] : null)
  const out: Array<[number, number]> = []
  for (let z = 0; z < rows; z++) for (let x = 0; x < cols; x++) {
    if (at(x, z) !== 'grass' || clear(x, z)) continue
    if (!DIRS.some(([dx, dz]) => at(x + dx, z + dz) === 'path')) continue
    if (out.some(([lx, lz]) => Math.max(Math.abs(lx - x), Math.abs(lz - z)) < LAMP_GAP)) continue
    out.push([x, z])
  }
  return out
}
