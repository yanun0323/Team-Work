// Every landmark at every stage, laid out on the island: what stands on it is in its ground, people can walk from its
// way in to everything they use there, never up a step too high, and stop at its sights.
import { describe, expect, it } from 'vitest'
import { LANDMARK_KINDS, type LandmarkKind } from './core/domain/types'
import { islandPlaces, stepCrowd, townsfolk, type Scene } from './crowd'
import { layoutTown, PLOT_CELLS, type Site, type Spot, type TeamInput } from './layout'
import { siteBoxes, siteMoving } from './siteBoxes'
import { doorOf, HILL_LEVELS, HILL_TOP, MAX_STEP, SITES, sitePlan } from './sites'
import { benchSeats, freeCells, isFree, townGrid, townHeights, type Grid } from './walk'

const teams: TeamInput[] = [
  { id: 'a', name: 'A', members: 4, at: [-8, -8] },
  { id: 'b', name: 'B', members: 2, at: [10, -8] },
]
const at: Spot = [-8, 10]
const every = LANDMARK_KINDS.flatMap((kind) => Array.from({ length: SITES[kind].stages }, (_, i) => [kind, i + 1] as const))
const laid = (kind: LandmarkKind, stage: number, face = 0) => {
  const town = layoutTown(teams, true, [{ kind, stage, at, face }])
  return { town, site: town.sites[0] as Site }
}
const moving = (kind: LandmarkKind, stage: number) => {
  const { town, site } = laid(kind, stage)
  return siteMoving(town, site)
}

/** The free cells people can walk to from `from`, as the grid lets them (four ways, enough for whether at all). */
function reach(g: Grid, from: [number, number]): Set<string> {
  const seen = new Set([`${from}`])
  const todo = [from]
  while (todo.length) {
    const [x, z] = todo.pop()!
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const k = `${x + dx},${z + dz}`
      if (seen.has(k) || !isFree(g, x + dx, z + dz)) continue
      seen.add(k)
      todo.push([x + dx, z + dz])
    }
  }
  return seen
}

describe('each landmark', () => {
  it.each(every)('%s at stage %i keeps what stands on it inside its ground, and off its paths', (kind, stage) => {
    const plan = sitePlan(kind, stage)
    const inside = (x: number, z: number) => x >= 0 && z >= 0 && x < PLOT_CELLS && z < PLOT_CELLS
    const solid = new Set<string>()
    for (const r of [...plan.props, ...plan.beds, ...plan.blankets, ...plan.blocks, ...plan.trees.map((t) => ({ ...t, w: 2, d: 2 }))]) {
      for (let z = r.z; z < r.z + r.d; z++) for (let x = r.x; x < r.x + r.w; x++) {
        expect(inside(x, z)).toBe(true)
        solid.add(`${x},${z}`)
      }
    }
    const over = new Set(plan.raised.map(([x, z]) => `${x},${z}`))
    for (const [x, z] of [...plan.water, ...plan.sea]) if (!over.has(`${x},${z}`)) solid.add(`${x},${z}`)
    for (const [x, z] of [...plan.walks, ...plan.raised.map(([x, z]) => [x, z] as const)]) {
      expect(inside(x, z)).toBe(true)
      expect(solid.has(`${x},${z}`), `${kind} ${stage}: ${x},${z}`).toBe(false)
    }
    for (const s of plan.sights) expect(solid.has(`${s.x},${s.z}`)).toBe(false)
  })

  // the pier turned each way, as it faces open sea
  const turned = [...every, ...[1, 2, 3].flatMap((face) => [1, 2].map((stage) => ['dock', stage, face] as const))]

  it.each(turned)('%s at stage %i (turned %i): everything used there is reached from its way in', (kind, stage, face = 0) => {
    const { town, site } = laid(kind, stage, face)
    const g = townGrid(town)
    // the last cell inside, just short of the way in
    const [dx, dz] = doorOf(site.face)
    const door: [number, number] = [site.plot.x + Math.min(Math.max(dx, 0), PLOT_CELLS - 1), site.plot.z + Math.min(Math.max(dz, 0), PLOT_CELLS - 1)]
    expect(isFree(g, ...door)).toBe(true)
    const can = reach(g, door)
    const places = islandPlaces(town, g)
    for (const s of site.sights) expect(can.has(`${s.x},${s.z}`), `sight ${s.x},${s.z}`).toBe(true)
    expect(places.sights).toHaveLength(town.sites.reduce((n, s) => n + s.sights.length, 0))
    for (const seat of benchSeats(town, g)) {
      const [x, z] = [Math.round((seat.front[0] - g.x0) / g.step), Math.round((seat.front[1] - g.z0) / g.step)]
      if (x >= site.plot.x && z >= site.plot.z && x < site.plot.x + PLOT_CELLS && z < site.plot.z + PLOT_CELLS) expect(can.has(`${x},${z}`), `seat ${x},${z}`).toBe(true)
    }
    for (const [x, z] of site.loop ?? []) expect(can.has(`${x},${z}`)).toBe(true)
    for (const [x, z] of site.walks) expect(can.has(`${x},${z}`), `walk ${x},${z}`).toBe(true)
  })

  it.each(turned)('%s at stage %i (turned %i) has no step between cells higher than one can climb', (kind, stage, face = 0) => {
    const { town, site } = laid(kind, stage, face)
    const g = townGrid(town)
    const h = townHeights(town)
    for (let z = site.plot.z - 1; z <= site.plot.z + PLOT_CELLS; z++) for (let x = site.plot.x - 1; x <= site.plot.x + PLOT_CELLS; x++) {
      if (!isFree(g, x, z)) continue
      for (const [dx, dz] of [[1, 0], [0, 1]]) {
        if (!isFree(g, x + dx, z + dz)) continue
        expect(Math.abs(h[z * town.cols + x] - h[(z + dz) * town.cols + x + dx]), `${kind} ${stage}: ${x},${z}`).toBeLessThanOrEqual(MAX_STEP + 1e-6)
      }
    }
  })

  it.each(every)('%s at stage %i is drawn, and more people come out for it', (kind, stage) => {
    const { town, site } = laid(kind, stage)
    const boxes = siteBoxes(town, site, true)
    expect(boxes.length).toBeGreaterThanOrEqual(siteBoxes(town, site, false).length)
    for (const b of boxes) expect(b.s.every((v) => v > 0)).toBe(true)
    for (const m of siteMoving(town, site)) expect(m.boxes.length).toBeGreaterThan(0)
  })
})

describe('the landmarks in particular', () => {
  it('the lake is not walked on but for its bridge, and the bridge and the hill lift people up', () => {
    const { town, site } = laid('pond', 2)
    const g = townGrid(town)
    const h = townHeights(town)
    const bridge = new Set(site.raised.map(([x, z]) => `${x},${z}`))
    expect(bridge.size).toBeGreaterThan(0)
    for (const [x, z] of site.water) expect(isFree(g, x, z)).toBe(bridge.has(`${x},${z}`))
    for (const [x, z, y] of site.raised) expect(h[z * town.cols + x]).toBeCloseTo(y)
    // a hill of five terraces, climbed by its steps all the way to the top
    const hill = laid('hill', 2)
    expect(HILL_LEVELS).toBeGreaterThanOrEqual(4)
    expect(Math.max(...townHeights(hill.town))).toBeCloseTo(HILL_TOP)
    expect(HILL_TOP).toBeGreaterThan(3)
  })

  it.each([0, 1, 2, 3])('the pier turned %i has its harbour in the sea, its quay and pier walked on', (face) => {
    const { town, site } = laid('dock', 2, face)
    const g = townGrid(town)
    expect(site.face).toBe(face)
    expect(site.sea.length).toBeGreaterThan(0)
    const pier = new Set(site.raised.map(([x, z]) => `${x},${z}`))
    for (const [x, z] of site.sea) {
      expect(town.ground[z * town.cols + x], `${x},${z}`).toBeNull()
      expect(isFree(g, x, z)).toBe(pier.has(`${x},${z}`))
    }
    for (const [x, z] of site.walks) expect(town.ground[z * town.cols + x]).not.toBeNull()
    // the harbour is at the back, which faces the way it is turned
    const back = [[0, -1], [1, 0], [0, 1], [-1, 0]][face]
    const mid = (cells: Array<readonly [number, number] | readonly [number, number, number]>) =>
      cells.reduce((s, [x, z]) => s + (x - site.plot.x - 7.5) * back[0] + (z - site.plot.z - 7.5) * back[1], 0) / cells.length
    expect(mid(site.sea)).toBeGreaterThan(0)
    expect(mid(site.walks)).toBeLessThan(mid(site.sea))
  })

  it('the pier has seats at its edges over the water, and boats once there are enough companies', () => {
    const { town, site } = laid('dock', 1)
    const ledges = benchSeats(town, townGrid(town)).filter((s) => s.top !== undefined)
    expect(ledges).toHaveLength(site.ledges.length)
    // on the boards themselves, legs over the edge
    for (const s of ledges) expect(s.top).toBe(0)
    expect(siteMoving(town, site)).toEqual([])
    const later = laid('dock', 2)
    expect(siteMoving(later.town, later.site).length).toBeGreaterThan(0)
  })

  it('the fountain plays and the clock goes; the lake and the hill keep still', () => {
    expect(moving('pond', 1).length).toBeGreaterThan(0)
    expect(moving('pond', 2)).toEqual([])
    // an hour and a minute hand on each of four faces
    expect(moving('clock', 1)).toHaveLength(8)
    expect(moving('hill', 2)).toEqual([])
  })

  it('people go to a sight and face what it looks at', () => {
    const { town } = laid('clock', 1)
    const grid = townGrid(town)
    const cells = freeCells(grid)
    const s: Scene = { grid, seats: [], cells, paved: cells, places: islandPlaces(town, grid), swim: [], night: 0, followed: -1 }
    s.places.loops = []
    // past the doors, the shore and the loops, before standing about: the sight that far along the list
    const sight = s.places.sights[Math.floor(0.7 * s.places.sights.length)]
    const p = townsfolk({ x: sight.at[0] + 4, z: sight.at[1] + 6, route: [], heading: 0, mode: 'standing', wait: 0, seat: null, toSeat: false })
    stepCrowd([p], s, 0.1, () => 0.7)
    expect(p.doing).toBe('look')
    expect(p.route.at(-1)).toEqual(sight.at)
    for (let k = 0; k < 400 && p.mode === 'walking'; k++) stepCrowd([p], s, 0.1, () => 0.99)
    expect(p.mode).toBe('standing')
    expect(p.heading).toBeCloseTo(sight.heading)
  })
})
