import { describe, expect, it } from 'vitest'
import { officeCapacity } from './office'
import { AIRPORT, RUNWAY_CELLS, RUNWAY_LINE, BUILDING_CELLS, BUILDING_SIZES, CELL, canMove, canPlace, growth, MAX_FLOORS, RING_CELLS, layoutTown, PLOT_CELLS, REACH_CELLS, rectCenter, seedOfId, spotCenter, TREE_CELLS, type Rect, type Town } from './layout'
import { findPath, nearestFree, townGrid } from './walk'

const teams = (n: number, members = 3) => Array.from({ length: n }, (_, i) => ({ id: `t${i}`, name: `T${i}`, members }))
const cells = (r: Rect) => {
  const out: string[] = []
  for (let z = r.z; z < r.z + r.d; z++) for (let x = r.x; x < r.x + r.w; x++) out.push(`${x},${z}`)
  return out
}
const groundAt = (t: Town, key: string) => {
  const [x, z] = key.split(',').map(Number)
  return x < 0 || z < 0 || x >= t.cols || z >= t.rows ? null : t.ground[z * t.cols + x]
}

describe('fusion town grid', () => {
  for (const n of [0, 1, 2, 3, 5, 9, 14]) {
    it(`places ${n} teams on whole cells, one model per cell, all on land`, () => {
      const town = layoutTown(teams(n))
      expect(town.lots.map((l) => l.id)).toEqual(teams(n).map((t) => t.id))
      const taken = new Map<string, string>()
      const claim = (key: string, who: string) => {
        expect(taken.get(key), `${who} on ${key}`).toBeUndefined()
        taken.set(key, who)
        expect(groundAt(town, key), `${who} on ${key}`).not.toBeNull()
      }
      for (const l of town.lots) {
        for (const v of [l.building.x, l.building.z, l.building.w, l.building.d, l.plot.x, l.plot.z]) expect(Number.isInteger(v)).toBe(true)
        expect(BUILDING_SIZES).toContain(l.building.w)
        expect(l.building.d).toBe(l.building.w)
        // in the middle of its plot, which is the same size whatever the building
        expect([l.plot.w, l.plot.d]).toEqual([PLOT_CELLS, PLOT_CELLS])
        expect([l.building.x - l.plot.x, l.building.z - l.plot.z]).toEqual([(PLOT_CELLS - l.building.w) / 2, (PLOT_CELLS - l.building.w) / 2])
        for (const key of cells(l.plot)) {
          expect(groundAt(town, key)).toBe('pave')
          claim(key, l.id)
        }
        // the building sits inside its own plot
        for (const key of cells(l.building)) expect(taken.get(key)).toBe(l.id)
        // street furniture sits on the paved ring, never on the building, the door or each other
        const biggest = cells({ x: l.plot.x + RING_CELLS, z: l.plot.z + RING_CELLS, w: BUILDING_CELLS, d: BUILDING_CELLS })
        const onRing = new Set(cells(l.plot).filter((k) => !biggest.includes(k)))
        const door = [l.plot.x + PLOT_CELLS / 2 - 1, l.plot.x + PLOT_CELLS / 2].map((x) => `${x},${l.plot.z + l.plot.d - 2}`)
        const used = new Set<string>()
        for (const pr of l.props) for (const key of cells(pr)) {
          expect(onRing.has(key), `${pr.kind} on ${key}`).toBe(true)
          expect(used.has(key), `${pr.kind} on ${key}`).toBe(false)
          expect(door).not.toContain(key)
          used.add(key)
        }
      }
      // the airport is where it always is, on its own ground, and nothing else is on it
      expect([town.airport.x - town.cols / 2, town.airport.z - town.rows / 2, town.airport.w, town.airport.d]).toEqual([AIRPORT.x, AIRPORT.z, AIRPORT.w, AIRPORT.d])
      for (const key of cells(town.airport)) {
        expect(groundAt(town, key)).toBe('airport')
        claim(key, 'airport')
      }
      // and no tree stands in the way of planes landing or taking off, along the runway's whole line
      const line = town.airport.z + RUNWAY_LINE
      for (const tr of town.trees) for (let dz = 0; dz < TREE_CELLS; dz++) {
        expect(Math.abs(tr.z + dz + 0.5 - line), `tree at ${tr.x},${tr.z}`).toBeGreaterThanOrEqual(RUNWAY_CELLS / 2 + 3)
      }
      for (const tr of town.trees) expect([2, 3, 4]).toContain(tr.height)
      for (const tr of town.trees) for (const key of cells({ x: tr.x, z: tr.z, w: TREE_CELLS, d: TREE_CELLS })) {
        expect(groundAt(town, key)).toBe('grass')
        claim(key, 'tree')
      }
    })
  }

  it('keeps the island one piece of land with no lakes', () => {
    for (const n of [1, 2, 6]) {
      const t = layoutTown(teams(n))
      const isLand = (x: number, z: number) => x >= 0 && z >= 0 && x < t.cols && z < t.rows && t.ground[z * t.cols + x] !== null
      // every sea cell connects to the border through sea
      const seen = new Set<string>()
      const stack: Array<[number, number]> = []
      for (let x = -1; x <= t.cols; x++) stack.push([x, -1], [x, t.rows])
      for (let z = 0; z < t.rows; z++) stack.push([-1, z], [t.cols, z])
      while (stack.length) {
        const [x, z] = stack.pop() as [number, number]
        const k = `${x},${z}`
        if (seen.has(k) || x < -1 || z < -1 || x > t.cols || z > t.rows || isLand(x, z)) continue
        seen.add(k)
        stack.push([x + 1, z], [x - 1, z], [x, z + 1], [x, z - 1])
      }
      for (let z = 0; z < t.rows; z++) for (let x = 0; x < t.cols; x++) {
        if (!isLand(x, z)) expect(seen.has(`${x},${z}`), `lake at ${x},${z}`).toBe(true)
      }
    }
  })

  it('grows a building from 4 × 4 and one storey up to 10 × 10 and ten storeys', () => {
    expect(growth(0, 0)).toEqual({ size: 4, floors: 1 })
    expect(growth(50, 500)).toEqual({ size: BUILDING_CELLS, floors: MAX_FLOORS })
    // never shrinks as tasks are finished or people hired
    let last = growth(0, 0)
    for (let done = 0; done < 40; done++) {
      const g = growth(2, done)
      expect(g.size).toBeGreaterThanOrEqual(last.size)
      expect(g.floors).toBeGreaterThanOrEqual(last.floors)
      last = g
    }
    expect(growth(4, 0).floors).toBeGreaterThan(growth(1, 0).floors)
    // always a desk each, up to what the largest building holds
    for (let n = 0; n <= officeCapacity(BUILDING_CELLS * CELL, CELL); n++) {
      expect(officeCapacity(growth(n, 0).size * CELL, CELL)).toBeGreaterThanOrEqual(n)
    }
  })

  it('makes larger teams taller', () => {
    const [small, big] = layoutTown([{ id: 'a', name: 'A', members: 2 }, { id: 'b', name: 'B', members: 6 }]).lots
    expect(big.floors).toBeGreaterThan(small.floors)
  })

  it('builds land out to a plot put at sea, as one island, and keeps the others where they were', () => {
    const town = layoutTown(teams(2))
    const left = Math.min(...town.lots.map((l) => l.at[0]))
    // well out to sea, up and to the left, as far as allowed
    const far: [number, number] = [left - PLOT_CELLS - REACH_CELLS - 12, -40]
    expect(canPlace(town, far)).toBe(true)
    const grown = layoutTown([
      ...town.lots.map((l) => ({ id: l.id, name: l.name, members: 3, at: l.at })),
      { id: 'new', name: 'New', members: 0, at: far },
    ])
    // the same place in the world, however the grid grew
    for (const [i, l] of town.lots.entries()) expect(rectCenter(grown, grown.lots[i].building)).toEqual(rectCenter(town, l.building))
    const lot = grown.lots[2]
    const [x, z] = rectCenter(grown, lot.plot)
    expect([x, z]).toEqual(spotCenter(far))
    expect(grown.ground[lot.plot.z * grown.cols + lot.plot.x]).toBe('pave')
    expectOneIsland(grown)
  })

  it('lets a plot go anywhere clear of the others and not too far out', () => {
    const town = layoutTown(teams(2))
    const [a] = town.lots
    expect(canPlace(town, a.at)).toBe(false)
    expect(canPlace(town, [a.at[0] + 4, a.at[1] + 4])).toBe(false)
    // one cell over the plot, then touching it
    expect(canPlace(town, [a.at[0], a.at[1] + PLOT_CELLS - 1])).toBe(false)
    expect(canPlace(town, [a.at[0], a.at[1] + PLOT_CELLS])).toBe(true)
    expect(canPlace(town, [a.at[0], a.at[1] + PLOT_CELLS + 12 + REACH_CELLS + 1])).toBe(false)
  })

  it('lays out plots that touch, on one island, with a way round them on foot', () => {
    const [ax, az] = [40, 60]
    const town = layoutTown([
      { id: 'a', name: 'a', members: 1, at: [ax, az] },
      { id: 'b', name: 'b', members: 1, at: [ax + PLOT_CELLS, az] },
    ])
    const [a, b] = town.lots
    expect(b.plot.x).toBe(a.plot.x + PLOT_CELLS)
    for (const l of town.lots) for (const c of [[l.plot.x, l.plot.z], [l.plot.x + PLOT_CELLS - 1, l.plot.z + PLOT_CELLS - 1]]) {
      expect(town.ground[c[1] * town.cols + c[0]]).toBe('pave')
    }
    expectOneIsland(town)
    const g = townGrid(town)
    const from = nearestFree(g, a.plot.x, a.plot.z)!
    const to = nearestFree(g, b.plot.x + PLOT_CELLS - 1, b.plot.z + PLOT_CELLS - 1)!
    expect(findPath(g, from, to)?.length).toBeGreaterThan(1)
  })

  it('keeps plots off the airport and the lawn round it', () => {
    const town = layoutTown(teams(2))
    expect(canPlace(town, [AIRPORT.x + 4, AIRPORT.z + 2])).toBe(false)
    // just short of the lawn, then on the far side of it
    expect(canPlace(town, [AIRPORT.x + 4, AIRPORT.z - PLOT_CELLS - 1])).toBe(false)
    expect(canPlace(town, [AIRPORT.x + 4, AIRPORT.z - PLOT_CELLS - 2])).toBe(true)
    // moving a company there is no different
    expect(canMove(town, town.lots[0].id, [AIRPORT.x + 4, AIRPORT.z + 2])).toBe(false)
    // with no company at all, the island is the airport's, and a first plot goes beside it
    const none = layoutTown([])
    expect(none.lots).toEqual([])
    expect(canPlace(none, [AIRPORT.x, AIRPORT.z + AIRPORT.d + 2])).toBe(true)
    expectOneIsland(none)
  })

  it('moves a company anywhere clear of the others, its own place included', () => {
    const town = layoutTown(teams(2))
    const [a, b] = town.lots
    expect(canMove(town, a.id, a.at)).toBe(true)
    // a little further from the other one
    const away = (i: 0 | 1) => a.at[i] + Math.sign(a.at[i] - b.at[i]) * 4
    expect(canMove(town, a.id, [away(0), away(1)])).toBe(true)
    expect(canMove(town, a.id, b.at)).toBe(false)
    // alone, it stays within reach of the airport's land
    const one = layoutTown(teams(1))
    const [c] = one.lots
    expect(canMove(one, c.id, [c.at[0] + 40, c.at[1]])).toBe(true)
    expect(canMove(one, c.id, [c.at[0] + 200, c.at[1]])).toBe(false)
  })

  it('gives the land a company left back to the sea', () => {
    // a company far out on its own, joined to the island by a strip of land
    const far: [number, number] = [120, 0]
    const town = layoutTown([...teams(2).map((t) => ({ ...t, at: undefined })), { id: 'far', name: 'Far', members: 1, at: far }])
    const plotOf = (t: typeof town) => ({ x: far[0] + t.cols / 2, z: far[1] + t.rows / 2, w: PLOT_CELLS, d: PLOT_CELLS })
    expect(cells(plotOf(town)).every((k) => groundAt(town, k) !== null)).toBe(true)
    // it closes (or moves away): where it stood is sea again, the others stand where they were
    const after = layoutTown(town.lots.slice(0, 2).map((l) => ({ id: l.id, name: l.name, members: 1, at: l.at })))
    // sea, on the grid or off it
    expect(cells(plotOf(after)).every((k) => groundAt(after, k) === null)).toBe(true)
    expect(after.lots.map((l) => rectCenter(after, l.building))).toEqual(town.lots.slice(0, 2).map((l) => rectCenter(town, l.building)))
    expectOneIsland(after)
  })

  it('keeps the island whole for plots placed in a ring', () => {
    const at = (x: number, z: number) => ({ id: `${x},${z}`, name: '', members: 1, at: [x, z] as [number, number] })
    expectOneIsland(layoutTown([at(-40, -40), at(20, -40), at(20, 20), at(-40, 20)]))
  })
  it('keeps a company\'s own look, or gives it a steady one from its id', () => {
    const town = layoutTown([
      { id: 'a', name: 'A', members: 1, style: 'brick', seed: 1234 },
      { id: 'b', name: 'B', members: 1 },
    ])
    expect(town.lots[0]).toMatchObject({ style: 'brick', seed: 1234 })
    expect(town.lots[1].seed).toBe(seedOfId('b'))
    expect(layoutTown([{ id: 'b', name: 'B', members: 1 }]).lots[0].seed).toBe(town.lots[1].seed)
  })
})

function expectOneIsland(t: Town) {
  const isLand = (x: number, z: number) => x >= 0 && z >= 0 && x < t.cols && z < t.rows && t.ground[z * t.cols + x] !== null
  // all land is one piece
  const land: string[] = []
  for (let z = 0; z < t.rows; z++) for (let x = 0; x < t.cols; x++) if (isLand(x, z)) land.push(`${x},${z}`)
  const reached = new Set<string>()
  const stack = [land[0].split(',').map(Number) as [number, number]]
  while (stack.length) {
    const [x, z] = stack.pop()!
    const k = `${x},${z}`
    if (reached.has(k) || !isLand(x, z)) continue
    reached.add(k)
    stack.push([x + 1, z], [x - 1, z], [x, z + 1], [x, z - 1])
  }
  expect(reached.size).toBe(land.length)
  for (const l of t.lots) for (const k of cells(l.plot)) expect(groundAt(t, k)).toBe('pave')
}
