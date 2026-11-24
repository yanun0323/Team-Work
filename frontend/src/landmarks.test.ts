// The park on the island: its ground kept as a plot is, its things in the town's cells, the footpath to its way in,
// and the people using it.
import { describe, expect, it } from 'vitest'
import { benchMate, islandPlaces, stepCrowd, townsfolk, type Scene, type Townsfolk } from './crowd'
import {
  canMove, canPlace, landGained, layoutTown, placementArea, placeProblem, PLOT_CELLS, siteId, STAFFING_ID, STAFFING_LOT, STAFFING_SPOT, staffingLot,
  type LandmarkInput, type Spot, type TeamInput, type Town,
} from './layout'
import { PARK_STAGES } from './park'
import { benchSeats, cellPos, crowdSize, freeCells, GRASS_COST, isFree, townGrid, type P } from './walk'

const teams: TeamInput[] = [
  { id: 'a', name: 'A', members: 4, at: [-8, -8] },
  { id: 'b', name: 'B', members: 2, at: [10, -8] },
]
const at: Spot = [-8, 10]
const park = (stage = 1): LandmarkInput[] => [{ kind: 'park', stage, at }]
const parkOf = (town: Town) => town.sites.find((s) => s.kind === 'park')!

describe('the park on the island', () => {
  it('stands on lawn of its own, its things moved into the town', () => {
    const town = layoutTown(teams, true, park(2))
    const p = parkOf(town)
    expect(p.at).toEqual(at)
    expect(p.plot).toEqual({ x: at[0] + town.cols / 2, z: at[1] + town.rows / 2, w: PLOT_CELLS, d: PLOT_CELLS })
    for (let z = p.plot.z; z < p.plot.z + p.plot.d; z++) for (let x = p.plot.x; x < p.plot.x + p.plot.w; x++) {
      expect(town.ground[z * town.cols + x]).toBe('park')
    }
    for (const [x, z] of p.walks) expect(x >= p.plot.x && z >= p.plot.z && x < p.plot.x + PLOT_CELLS && z < p.plot.z + PLOT_CELLS).toBe(true)
    // its trees grow with the town's, and no other tree grows on its ground
    for (const t of p.trees) expect(town.trees).toContainEqual(t)
    const own = new Set(p.trees.map((t) => `${t.x},${t.z}`))
    for (const t of town.trees) if (!own.has(`${t.x},${t.z}`)) {
      expect(t.x + 2 <= p.plot.x - 1 || t.x >= p.plot.x + PLOT_CELLS + 1 || t.z + 2 <= p.plot.z - 1 || t.z >= p.plot.z + PLOT_CELLS + 1).toBe(true)
    }
    expect(layoutTown(teams).sites).toEqual([])
  })

  it('takes the land a company there would, and keeps companies off it', () => {
    const withPark = layoutTown(teams, true, park())
    const asCompany = layoutTown([...teams, { id: 'p', name: 'P', members: 0, at }])
    expect([withPark.cols, withPark.rows]).toEqual([asCompany.cols, asCompany.rows])
    expect(withPark.ground.map((g) => !!g)).toEqual(asCompany.ground.map((g) => !!g))
    expect(canPlace(withPark, at)).toBe(false)
    expect(canPlace(withPark, [at[0] + 8, at[1]])).toBe(false)
    expect(placeProblem(withPark, at)).toBe('taken')
    expect(canPlace(layoutTown(teams), at)).toBe(true)
    // building beside it gains no land under it
    const gained = new Set(landGained(withPark, [at[0] + PLOT_CELLS + 2, at[1]]).map((s) => `${s}`))
    for (let z = at[1]; z < at[1] + PLOT_CELLS; z++) for (let x = at[0]; x < at[0] + PLOT_CELLS; x++) expect(gained.has(`${x},${z}`)).toBe(false)
  })

  it('is kept clear when the town hands out places', () => {
    const loose = Array.from({ length: 6 }, (_, i): TeamInput => ({ id: `t${i}`, name: `T${i}`, members: 2 }))
    const town = layoutTown(loose, false, [{ kind: 'park', stage: 1, at: [-8, -8] }])
    for (const l of town.lots) expect(Math.max(Math.abs(l.at[0] + 8), Math.abs(l.at[1] + 8))).toBeGreaterThanOrEqual(PLOT_CELLS)
  })

  it('is joined by a footpath at its way in', () => {
    const town = layoutTown(teams, true, park())
    const p = parkOf(town)
    const door = [p.plot.x + PLOT_CELLS / 2 - 1, p.plot.z + PLOT_CELLS]
    expect(town.ground[door[1] * town.cols + door[0]]).toBe('path')
    expect(town.ground[door[1] * town.cols + door[0] + 1]).toBe('path')
    // no footpath crosses it, nor a lamp stands on it
    expect(town.ground.filter((g, k) => g === 'path' && (k % town.cols) >= p.plot.x && (k % town.cols) < p.plot.x + PLOT_CELLS
      && Math.floor(k / town.cols) >= p.plot.z && Math.floor(k / town.cols) < p.plot.z + PLOT_CELLS)).toEqual([])
  })

  it('has people keep to its gravel, go round what stands in it, and sit on its benches and blankets', () => {
    const town = layoutTown(teams, true, park(PARK_STAGES))
    const p = parkOf(town)
    const g = townGrid(town)
    const cost = (x: number, z: number) => g.cost![z * g.cols + x]
    for (const [x, z] of p.walks) {
      expect(isFree(g, x, z)).toBe(true)
      expect(cost(x, z)).toBe(1)
    }
    expect(isFree(g, p.plot.x + 1, p.plot.z + 6)).toBe(true)
    expect(cost(p.plot.x + 1, p.plot.z + 6)).toBe(GRASS_COST)
    for (const r of [...p.props, ...p.beds, ...p.blankets, ...p.blocks]) expect(isFree(g, r.x, r.z)).toBe(false)
    const seats = benchSeats(town, g)
    const low = seats.filter((s) => s.low)
    expect(low).toHaveLength(p.blankets.length * 2)
    expect(seats.length - low.length).toBe(p.props.filter((r) => r.kind === 'bench').reduce((n, b) => n + b.w * b.d, 0) + town.lots.length * 8)
    // more people come out for a bigger park
    expect(crowdSize(town)).toBe(crowdSize(layoutTown(teams, true)) + PARK_STAGES + 1)
  })
})

describe('people in the park', () => {
  function scene(stage: number): Scene {
    const town = layoutTown(teams, true, park(stage))
    const grid = townGrid(town)
    const cells = freeCells(grid)
    return { grid, seats: benchSeats(town, grid), cells, paved: cells, places: islandPlaces(town, grid), swim: [], night: 0, followed: -1 }
  }

  it('walk once round its loop, the ring round the flower bed while it is small, then the loop round the lawn', () => {
    for (const stage of [1, 2]) {
      const s = scene(stage)
      expect(s.places.loops).toHaveLength(1)
      const loop = s.places.loops[0]
      const [x, z] = cellPos(s.grid, ...s.cells[0])
      const p = townsfolk({ x, z, route: [], heading: 0, mode: 'standing', wait: 0, seat: null, toSeat: false })
      // a choice past the doors and before standing about
      stepCrowd([p], s, 0.1, () => 0.65)
      expect(p.mode).toBe('walking')
      const route = p.route as P[]
      const corners = route.slice(-loop.length - 1)
      expect(corners.at(-1)).toEqual(corners[0])
      expect(new Set(corners.map((c) => `${c}`))).toEqual(new Set(loop.map((c) => `${c}`)))
    }
  })

  it('without a park, choose as before', () => {
    const town = layoutTown(teams)
    const grid = townGrid(town)
    const places = islandPlaces(town, grid)
    expect(places.loops).toEqual([])
  })

  it('sit facing each other on a blanket, and count as sitting together', () => {
    const s = scene(1)
    const [a, b] = s.seats.filter((x) => x.low)
    const sit = (seat: typeof a): Townsfolk => townsfolk({ x: seat.at[0], z: seat.at[1], route: [], heading: seat.heading, mode: 'sitting', wait: 10, seat, toSeat: false })
    expect(Math.cos(a.heading - b.heading)).toBeCloseTo(-1)
    const people = [sit(a), sit(b)]
    expect(benchMate(people, 0)).toBe(1)
    expect(benchMate(people, 1)).toBe(0)
  })
})

describe('moving the landmarks and the staffing agency', () => {
  it('moves a landmark as a company is moved: off its own ground, never onto a company or the airport', () => {
    const town = layoutTown(teams, true, park())
    const id = siteId('park')
    // its own ground, or a little off it, counts as free
    expect(canMove(town, id, [at[0] + 2, at[1]])).toBe(true)
    expect(canMove(town, id, teams[0].at!)).toBe(false)
    expect(canMove(town, id, [0, -30])).toBe(false)
    // a company may not take it, but may take where it was once it has gone
    expect(canPlace(town, at)).toBe(false)
    const moved = layoutTown(teams, true, [{ kind: 'park', stage: 1, at: [at[0] + PLOT_CELLS + 2, at[1]] }])
    expect(canPlace(moved, at)).toBe(true)
    // the land it would bring, from where it is going
    const far: Spot = [at[0], at[1] + PLOT_CELLS + 20]
    const gained = landGained(town, far, id)
    expect(gained.length).toBeGreaterThan(0)
    expect(gained.some(([x, z]) => x >= far[0] && z >= far[1] && x < far[0] + PLOT_CELLS && z < far[1] + PLOT_CELLS)).toBe(true)
  })

  it('moves the staffing agency by the plot round its paving, keeping its grass from the airport and every plot', () => {
    const town = layoutTown(teams, true, park())
    expect(town.staffingAt).toEqual(STAFFING_SPOT)
    expect(staffingLot(STAFFING_SPOT)).toEqual(STAFFING_LOT)
    expect(canMove(town, STAFFING_ID, STAFFING_SPOT)).toBe(true)
    const area = placementArea(town, STAFFING_ID)
    expect([area.inset, area.size]).toEqual([(PLOT_CELLS - STAFFING_LOT.w) / 2, STAFFING_LOT.w])
    // its paving may come within the plot round it of a company, but no closer than the grass kept
    const [cx, cz] = teams[0].at!
    const inset = (PLOT_CELLS - STAFFING_LOT.w) / 2
    expect(canMove(town, STAFFING_ID, [cx - PLOT_CELLS + inset - 2, cz])).toBe(true)
    expect(canMove(town, STAFFING_ID, [cx - PLOT_CELLS + inset - 1, cz])).toBe(false)
    expect(canMove(town, STAFFING_ID, at)).toBe(false)
    expect(canMove(town, STAFFING_ID, [0, -30])).toBe(false)

    // moved, it stands there, companies keep clear of it there, and its old ground is free
    const to: Spot = [cx - PLOT_CELLS - 4, cz]
    expect(canMove(town, STAFFING_ID, to)).toBe(true)
    const after = layoutTown(teams, true, park(), to)
    expect(after.staffingAt).toEqual(to)
    const lot = staffingLot(to)
    expect(after.staffing).toEqual({ ...lot, x: lot.x + after.cols / 2, z: lot.z + after.rows / 2 })
    expect(canPlace(after, to)).toBe(false)
    expect(placeProblem(after, to)).toBe('taken')
    expect(canPlace(after, STAFFING_SPOT)).toBe(canPlace(layoutTown(teams, true, park(), to), STAFFING_SPOT))
    expect(canPlace(layoutTown(teams, true, park()), STAFFING_SPOT)).toBe(false)
    // and the footpaths start from its door there
    const door = after.staffing.x + after.staffing.w / 2 - 1
    expect(after.ground[(after.staffing.z + after.staffing.d) * after.cols + door]).toBe('path')
  })
})
