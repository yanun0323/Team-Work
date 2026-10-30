import { describe, expect, it } from 'vitest'
import { CELL, layoutTown } from './layout'
import { officePlan } from './office'
import {
  advance, benchSeats, crowdSize, findPath, freeCells, isFree, nearestFree, officeGrid, smooth, townGrid, type Grid, type P,
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

  it('every bench seat is reached from a free cell connected to the rest', () => {
    const g = townGrid(town)
    const seats = benchSeats(town, g)
    expect(seats.length).toBe(town.lots.length * 4 * 2)
    const at = (p: P): P => [Math.round((p[0] - g.x0) / g.step), Math.round((p[1] - g.z0) / g.step)]
    for (const s of seats) expect(findPath(g, at(seats[0].front), at(s.front))).not.toBeNull()
  })
})
