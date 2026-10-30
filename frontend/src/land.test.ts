import { describe, expect, it } from 'vitest'
import { area, contours, landField, sample } from './land'
import { CELL, cellCenter, layoutTown } from './layout'

const teams = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `t${i}`, name: `T${i}`, members: 3 }))

describe('fusion island outline', () => {
  for (const n of [1, 2, 5]) {
    const town = layoutTown(teams(n))
    const field = landField(town)

    it(`keeps every model's cell well inside the grass (${n} teams)`, () => {
      const cells: Array<[number, number]> = town.trees.map((t) => [t.x, t.z])
      for (const l of town.lots) for (let z = l.plot.z; z < l.plot.z + l.plot.d; z++) for (let x = l.plot.x; x < l.plot.x + l.plot.w; x++) cells.push([x, z])
      for (const [x, z] of cells) {
        const [cx, cz] = cellCenter(town, x, z)
        // all four corners of the cell are on land, not just its centre
        for (const [dx, dz] of [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]].map(([a, b]) => [a * CELL, b * CELL])) {
          expect(sample(field, field.sdf, cx + dx, cz + dz), `cell ${x},${z}`).toBeLessThan(0)
        }
      }
    })

    it(`traces one closed grass outline, with sea all around (${n} teams)`, () => {
      const loops = contours(field, field.land, 0.5, true)
      expect(loops).toHaveLength(1)
      const [loop] = loops
      // the outline wraps the land cells, give or take its rounded coast
      const land = town.ground.filter(Boolean).length * CELL * CELL
      expect(Math.abs(area(loop))).toBeGreaterThan(land * 0.9)
      expect(Math.abs(area(loop))).toBeLessThan(land * 1.1)
      for (let k = 0; k < loop.length; k++) {
        const [x1, z1] = loop[k]
        const [x2, z2] = loop[(k + 1) % loop.length]
        // consecutive points are neighbours on the field, so the loop has no jumps
        expect(Math.hypot(x2 - x1, z2 - z1)).toBeLessThan(0.5)
      }
      expect(sample(field, field.sdf, town.cols * CELL, town.rows * CELL)).toBeGreaterThan(3)
    })
  }
})
