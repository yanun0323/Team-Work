import { describe, expect, it } from 'vitest'
import { CELL, cellCenter, layoutTown } from './layout'
import { officePlan } from './office'
import {
  advance, benchSeats, inSteps, cellPos, crowdSize, findPath, freeCells, isFree, nearestFree, officeGrid, resettle, route, seatRoute, smooth, townGrid, type Grid, type P, type Stroller,
} from './walk'

/** A grid from rows of text: '.' free, '#' blocked. Cell centres are at whole numbers. */
function grid(rows: string[]): Grid {
  const free = new Uint8Array(rows.length * rows[0].length)
  rows.forEach((r, z) => [...r].forEach((c, x) => (free[z * r.length + x] = c === '.' ? 1 : 0)))
  return { cols: rows[0].length, rows: rows.length, free, x0: 0, z0: 0, step: 1 }
}

const onFree = (g: Grid, path: P[]) => path.every(([x, z]) => isFree(g, Math.round(x), Math.round(z)))

describe('findPath', () => {
  it('goes round a wall and never cuts a blocked corner', () => {
    const g = grid([
      '.....',
      '.###.',
      '.#...',
      '.#.#.',
    ])
    const path = findPath(g, [0, 3], [2, 3]) as P[]
    expect(path[0]).toEqual([0, 3])
    expect(path.at(-1)).toEqual([2, 3])
    expect(onFree(g, path)).toBe(true)
    for (let i = 1; i < path.length; i++) {
      const [ax, az] = path[i - 1]
      const [bx, bz] = path[i]
      expect(Math.max(Math.abs(bx - ax), Math.abs(bz - az))).toBe(1)
      // a diagonal step needs both side cells free
      if (ax !== bx && az !== bz) expect(isFree(g, bx, az) && isFree(g, ax, bz)).toBe(true)
    }
  })

  it('returns null when the goal is walled off', () => {
    const g = grid(['..#..', '..#..'])
    expect(findPath(g, [0, 0], [4, 1])).toBeNull()
  })

  it('smoothing keeps the ends and only straight lines over free cells', () => {
    const g = grid([
      '........',
      '........',
      '...##...',
      '........',
    ])
    const path = findPath(g, [0, 3], [7, 0]) as P[]
    const short = smooth(g, path)
    expect(short.length).toBeLessThan(path.length)
    expect(short[0]).toEqual(path[0])
    expect(short.at(-1)).toEqual(path.at(-1))
  })
})

describe('advance', () => {
  it('walks the route at the given distance and stops at the end', () => {
    const w = { x: 0, z: 0, route: [[3, 0], [3, 4]] as P[], heading: 0 }
    expect(advance(w, 2)).toBe(2)
    expect([w.x, w.z]).toEqual([2, 0])
    expect(advance(w, 10)).toBeCloseTo(5)
    expect([w.x, w.z]).toEqual([3, 4])
    expect(w.route).toEqual([])
    // facing +z, the last way it walked
    expect(Math.cos(w.heading)).toBeCloseTo(-1)
  })
})

describe('officeGrid', () => {
  it('keeps people off furniture and can reach every desk', () => {
    const plan = officePlan(6, 10 * CELL, CELL)
    const g = officeGrid(plan)
    const cells = freeCells(g)
    expect(cells.length).toBeGreaterThan(50)
    for (const s of plan.stations) {
      const inside = cells.some(([x, z]) => Math.abs(g.x0 + x * g.step - s.x) < s.w / 2 && Math.abs(g.z0 + z * g.step - s.z) < s.d / 2)
      expect(inside).toBe(false)
    }
    // from each seat's walkway cell to every other's
    const exits = plan.seats.map(([x, z]) => nearestFree(g, x, z + 0.7) as P)
    for (const e of exits) expect(findPath(g, exits[0], e)).not.toBeNull()
  })
})

describe('the island', () => {
  const town = layoutTown([
    { id: 'a', name: 'A', members: 6 },
    { id: 'b', name: 'B', members: 2 },
    { id: 'c', name: 'C', members: 1 },
  ])

  it('two to five people per building', () => {
    const n = crowdSize(town)
    expect(n).toBeGreaterThanOrEqual(town.lots.length * 2)
    expect(n).toBeLessThanOrEqual(town.lots.length * 5)
  })

  it('nobody walks into a building, a tree, street furniture or the shore', () => {
    const g = townGrid(town)
    for (const l of town.lots) {
      expect(isFree(g, l.building.x + 1, l.building.z + 1)).toBe(false)
      for (const p of l.props) expect(isFree(g, p.x, p.z)).toBe(false)
    }
    for (const t of town.trees) expect(isFree(g, t.x, t.z)).toBe(false)
    town.ground.forEach((ground, i) => ground !== 'grass' && ground !== 'pave' && expect(g.free[i]).toBe(0))
  })

  /** Whether a point is on a building's cells. */
  const onBuilding = (t: typeof town, [x, z]: P) => t.lots.some(({ building: b }) => {
    const [cx, cz] = [x / CELL + t.cols / 2, z / CELL + t.rows / 2]
    return cx >= b.x && cx <= b.x + b.w && cz >= b.z && cz <= b.z + b.d
  })
  const crossesBuilding = (t: typeof town, from: P, path: P[]) => {
    let a = from
    for (const b of path) {
      for (let k = 0; k <= 40; k++) if (onBuilding(t, [a[0] + (b[0] - a[0]) * k / 40, a[1] + (b[1] - a[1]) * k / 40])) return true
      a = b
    }
    return false
  }

  it('no route between any two free cells crosses a building, at any size', () => {
    const big = layoutTown([
      { id: 'a', name: 'A', members: 1 }, { id: 'b', name: 'B', members: 6 },
      { id: 'c', name: 'C', members: 12 }, { id: 'd', name: 'D', members: 20, done: 40 },
    ])
    const g = townGrid(big)
    const cells = freeCells(g)
    for (let i = 0; i < 400; i++) {
      const a = cellPos(g, ...cells[(i * 37) % cells.length])
      const r = route(g, a, cellPos(g, ...cells[(i * 101 + 7) % cells.length]))
      expect(crossesBuilding(big, a, r)).toBe(false)
    }
  })

  it('every bench can still be reached around the largest building', () => {
    const big = layoutTown([{ id: 'a', name: 'A', members: 20, done: 40 }, { id: 'b', name: 'B', members: 20, done: 40 }])
    expect(big.lots[0].building.w).toBe(10)
    const g = townGrid(big)
    const seats = benchSeats(big, g)
    expect(seats.length).toBe(big.lots.length * 4 * 2)
    const at = (p: P): P => [Math.round((p[0] - g.x0) / g.step), Math.round((p[1] - g.z0) / g.step)]
    for (const s of seats) expect(findPath(g, at(seats[0].front), at(s.front))).not.toBeNull()
  })

  it('when a building grows, nobody stays inside it and no route still crosses it', () => {
    const small = layoutTown([{ id: 'a', name: 'A', members: 1 }, { id: 'b', name: 'B', members: 1 }])
    const grown = layoutTown([{ id: 'a', name: 'A', members: 20, done: 40 }, { id: 'b', name: 'B', members: 1 }])
    const before = townGrid(small)
    const after = townGrid(grown)
    const seat = benchSeats(small, before)[0]
    const { building: b } = grown.lots[0]
    const inside = cellCenter(grown, b.x + 1, b.z + 1)
    const [left, right] = [cellCenter(grown, b.x - 2, b.z + 4), cellCenter(grown, b.x + b.w + 1, b.z + 4)]
    const base = { heading: 0, wait: 1, seat: null, toSeat: false } as const
    const people: Stroller[] = [
      { ...base, x: inside[0], z: inside[1], route: [], mode: 'standing' },
      { ...base, x: left[0], z: left[1], route: [right], mode: 'walking' },
      { ...base, x: left[0], z: left[1], route: [right], mode: 'walking', seat, toSeat: true },
    ]
    resettle(people, after, benchSeats(grown, after))
    for (const p of people) {
      expect(onBuilding(grown, [p.x, p.z])).toBe(false)
      expect(crossesBuilding(grown, [p.x, p.z], p.route)).toBe(false)
    }
    expect(people[1].route.length).toBeGreaterThan(1)
  })

  it('nobody heading for a bench out of reach cuts straight across the sea', () => {
    // two pieces of ground with sea between them, the bench on the far one
    const g = grid(['..#..', '..#..'])
    const seat = { at: [4.5, 0] as P, front: [4, 0] as P, heading: 0 }
    const p: Stroller = { x: 0, z: 0, route: [seat.at], heading: 0, mode: 'walking', wait: 1, seat, toSeat: true }
    resettle([p], g, [seat])
    expect(p.route).toEqual([])
    expect(p.seat).toBeNull()
    expect(p.toSeat).toBe(false)
    expect(seatRoute(g, [0, 0], seat)).toEqual([])
    expect(seatRoute(g, [3, 0], seat).at(-1)).toEqual(seat.at)
  })

  it('every bench seat is reached from a free cell connected to the rest', () => {
    const g = townGrid(town)
    const seats = benchSeats(town, g)
    expect(seats.length).toBe(town.lots.length * 4 * 2)
    const at = (p: P): P => [Math.round((p[0] - g.x0) / g.step), Math.round((p[1] - g.z0) / g.step)]
    for (const s of seats) expect(findPath(g, at(seats[0].front), at(s.front))).not.toBeNull()
  })
})

describe('inSteps', () => {
  it('splits a long background frame into short steps that add up to it', () => {
    const steps: number[] = []
    inSteps(1.05, (dt) => steps.push(dt))
    expect(steps).toHaveLength(11)
    expect(Math.max(...steps)).toBeLessThanOrEqual(0.1)
    expect(steps.reduce((a, b) => a + b, 0)).toBeCloseTo(1.05)
  })

  it('takes a short frame in one step', () => {
    const steps: number[] = []
    inSteps(1 / 30, (dt) => steps.push(dt))
    expect(steps).toEqual([1 / 30])
  })
})
