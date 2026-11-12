import { describe, expect, it } from 'vitest'
import { CELL, cellCenter, layoutTown, rectCenter } from './layout'
import { BED, blockedCells, GROUNDS, HALF_LOT, obstacles, STEPS_HALF, type Footprint } from './staffingGrounds'
import { cellPos, findPath, isFree, townGrid } from './walk'

const { path, lamps, flags, planters, ...single } = GROUNDS
const all: Array<[string, Footprint]> = [
  ['path', path],
  ...Object.entries(single),
  ...lamps.map((f, i): [string, Footprint] => [`lamp ${i}`, f]),
  ...flags.map((f, i): [string, Footprint] => [`flag ${i}`, f]),
  ...planters.map((f, i): [string, Footprint] => [`planter ${i}`, f]),
]

/** How near a footprint comes to the rotunda's middle. */
const nearest = (f: Footprint) => Math.hypot(Math.max(0, Math.abs(f.x) - f.w / 2), Math.max(0, Math.abs(f.z) - f.d / 2))
const overlap = (a: Footprint, b: Footprint) => Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.z - b.z) < (a.d + b.d) / 2

describe("the staffing agency's grounds", () => {
  it('keeps everything on its paving', () => {
    for (const [name, f] of all) {
      expect(Math.abs(f.x) + f.w / 2, name).toBeLessThanOrEqual(HALF_LOT)
      expect(Math.abs(f.z) + f.d / 2, name).toBeLessThanOrEqual(HALF_LOT)
    }
  })

  it('keeps everything off the rotunda and its flower bed', () => {
    // the path runs out through the bed's opening, checked below
    for (const [name, f] of all.filter(([, f]) => f !== path)) expect(nearest(f), name).toBeGreaterThanOrEqual(BED.r1)
  })

  it('puts nothing on top of anything else', () => {
    for (const [i, [a, fa]] of all.entries()) for (const [b, fb] of all.slice(i + 1)) expect(overlap(fa, fb), `${a} / ${b}`).toBe(false)
  })

  it('leaves the bed open for the steps and the path', () => {
    for (const half of [STEPS_HALF, path.w / 2]) expect(Math.asin(half / BED.r1)).toBeLessThan(BED.gap)
    expect(path.x).toBe(0)
  })
})

describe('people round the staffing agency', () => {
  const town = layoutTown([{ id: 'a', name: 'A', members: 3 }])
  const grid = townGrid(town)
  const [lx, lz] = rectCenter(town, town.staffing)
  /** The free cells on the paving, about its middle in world units. */
  const free: Array<[number, number, number, number]> = []
  for (let z = town.staffing.z; z < town.staffing.z + town.staffing.d; z++) for (let x = town.staffing.x; x < town.staffing.x + town.staffing.w; x++) {
    const [cx, cz] = cellCenter(town, x, z)
    if (isFree(grid, x, z)) free.push([x, z, cx - lx, cz - lz])
  }

  it('keeps everyone off the rotunda, its bed and what stands round it, with room for a body', () => {
    expect(blockedCells(town, town.staffing).length).toBeGreaterThan(0)
    for (const [x, z, cx, cz] of free) {
      // anywhere in the cell, a figure clears the bed
      const near = Math.hypot(Math.max(0, Math.abs(cx) - CELL / 2), Math.max(0, Math.abs(cz) - CELL / 2))
      expect(near, `${x},${z}`).toBeGreaterThanOrEqual(BED.r1)
      for (const f of obstacles()) {
        const clear = Math.abs(f.x - cx) >= (f.w + CELL) / 2 || Math.abs(f.z - cz) >= (f.d + CELL) / 2
        expect(clear, `${x},${z}`).toBe(true)
      }
    }
  })

  it('still lets them walk up the path to the steps', () => {
    const steps = free.filter(([, , cx, cz]) => Math.abs(cx) < path.w / 2 && cz > 0)
    expect(steps.length).toBeGreaterThan(0)
  })

  it('leaves no free cell on the paving that nobody can get to', () => {
    // from the grass outside the paving's far corner
    const out: [number, number] = [town.staffing.x - 1, town.staffing.z + town.staffing.d]
    expect(isFree(grid, ...out)).toBe(true)
    for (const [x, z] of free) expect(findPath(grid, out, [x, z]), `${x},${z} from ${cellPos(grid, ...out)}`).not.toBeNull()
  })
})
