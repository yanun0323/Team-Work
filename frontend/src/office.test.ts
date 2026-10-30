import { describe, expect, it } from 'vitest'
import { BUILDING_SIZES, CELL } from './layout'
import { OFFICE_SCALE, officeCapacity, officePlan, type Area } from './office'
import { findPath, isFree, nearestFree, officeGrid, type Grid, type P } from './walk'

const overlap = (a: Area, b: Area) => Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.z - b.z) < (a.d + b.d) / 2
const plant = ([x, z]: [number, number]): Area => ({ x, z, w: 0.5, d: 0.5 })

describe('fusion office floor', () => {
  const cases = BUILDING_SIZES.flatMap((size) => {
    const cap = officeCapacity(size * CELL, CELL)
    return [...new Set([0, 1, 2, 6, 9, 12, cap].filter((n) => n <= cap))].map((n) => [size, n])
  })
  it('has room for more desks in a bigger building', () => {
    const caps = BUILDING_SIZES.map((size) => officeCapacity(size * CELL, CELL))
    expect(caps[0]).toBeGreaterThanOrEqual(1)
    for (let i = 1; i < caps.length; i++) expect(caps[i]).toBeGreaterThan(caps[i - 1])
  })
  for (const [size, n] of cases) {
    it(`fits ${n} employees in a ${size} × ${size} building without anything overlapping, however it is rolled`, () => {
      const FOOTPRINT = size * CELL
      for (const seed of [undefined, ...Array.from({ length: 40 }, (_, i) => i * 7919 + 3)]) {
        const plan = officePlan(n, FOOTPRINT, CELL, seed)
        expect(plan.seats).toHaveLength(n)
        const things = [...plan.stations, plan.nook, ...[plan.reception, plan.meeting, plan.lounge, plan.shelf].filter((a) => !!a), ...plan.plants.map(plant)]
        for (const a of things) {
          // inside the walls
          expect(Math.abs(a.x) + a.w / 2).toBeLessThanOrEqual(plan.half)
          expect(Math.abs(a.z) + a.d / 2).toBeLessThanOrEqual(plan.half)
          for (const b of things) if (a !== b) expect(overlap(a, b), JSON.stringify([a, b])).toBe(false)
        }
        // one desk per ground cell: each station sits inside a cell of its own
        const cells = plan.stations.map((st) => {
          const [x, z] = [st.x * OFFICE_SCALE + FOOTPRINT / 2, st.z * OFFICE_SCALE + FOOTPRINT / 2]
          const [cx, cz] = [Math.floor(x / CELL), Math.floor(z / CELL)]
          expect(x - (st.w / 2) * OFFICE_SCALE).toBeGreaterThanOrEqual(cx * CELL - 1e-9)
          expect(x + (st.w / 2) * OFFICE_SCALE).toBeLessThanOrEqual((cx + 1) * CELL + 1e-9)
          expect(z - (st.d / 2) * OFFICE_SCALE).toBeGreaterThanOrEqual(cz * CELL - 1e-9)
          expect(z + (st.d / 2) * OFFICE_SCALE).toBeLessThanOrEqual((cz + 1) * CELL + 1e-9)
          return `${cx},${cz}`
        })
        expect(new Set(cells).size).toBe(n)
        // every seat is on its own station
        plan.seats.forEach(([x, z], i) => {
          const s = plan.stations[i]
          expect(Math.abs(x - s.x)).toBeLessThan(s.w / 2)
          expect(Math.abs(z - s.z)).toBeLessThan(s.d / 2)
        })
      }
    })
  }
  it('keeps the entrance clear and leaves a walkway behind every chair, however it is rolled', () => {
    // a free walking cell behind a station (towards +z, where the chair is), within its width
    const behind = (g: Grid, s: Area): P | undefined => {
      for (let z = 0; z < g.rows; z++) for (let x = 0; x < g.cols; x++) {
        const [px, pz] = [g.x0 + x * g.step, g.z0 + z * g.step]
        if (isFree(g, x, z) && Math.abs(px - s.x) < s.w / 2 && pz > s.z + s.d / 2 && pz < s.z + s.d / 2 + 1) return [x, z]
      }
    }
    for (const size of BUILDING_SIZES) {
      const cap = officeCapacity(size * CELL, CELL)
      for (const n of new Set([1, 2, Math.ceil(cap / 2), cap])) for (const seed of [undefined, ...Array.from({ length: 20 }, (_, i) => i * 7919 + 3)]) {
        const plan = officePlan(n, size * CELL, CELL, seed)
        const things = [
          ...plan.stations, plan.nook, ...[plan.reception, plan.meeting, plan.lounge, plan.shelf].filter((a) => !!a), ...plan.plants.map(plant),
          ...(plan.cooler ? [{ x: plan.cooler[0], z: plan.cooler[1], w: 0.4, d: 0.4 }] : []),
        ]
        for (const a of things) expect(overlap(a, plan.entrance), JSON.stringify([size, n, seed, a])).toBe(false)
        const g = officeGrid(plan)
        const door = nearestFree(g, 0, plan.half - 0.3) as P
        for (const s of plan.stations) {
          const spot = behind(g, s)
          expect(spot, JSON.stringify([size, n, seed, s])).toBeDefined()
          expect(findPath(g, door, spot as P)).not.toBeNull()
        }
        // the coffee counter and sofa stand against the back wall, with open floor to walk up to them from
        expect(plan.nook.z - plan.nook.d / 2).toBeCloseTo(-plan.half)
        const [ex, ez] = plan.nookEntry
        const entry = nearestFree(g, ex, ez) as P
        expect(Math.hypot(g.x0 + entry[0] * g.step - ex, g.z0 + entry[1] * g.step - ez), JSON.stringify([size, n, seed])).toBeLessThan(0.5)
        expect(findPath(g, door, entry)).not.toBeNull()
      }
    }
  })
  it('lays out the same room for the same seed, and different rooms for different seeds', () => {
    const plan = (seed: number) => JSON.stringify(officePlan(6, 10 * CELL, CELL, seed))
    expect(plan(42)).toBe(plan(42))
    const rooms = new Set(Array.from({ length: 20 }, (_, i) => plan(i * 101)))
    expect(rooms.size).toBeGreaterThan(5)
    expect(new Set(Array.from({ length: 20 }, (_, i) => officePlan(6, 10 * CELL, CELL, i * 101).mirror)).size).toBe(2)
  })
})
