import { expect, it } from 'vitest'
import { CELL, PLOT_CELLS, REACH_CELLS, canPlace, canMove, layoutTown, type Town } from './layout'
import { mapGridPositions } from './MapGrid'

const expandedLand = (town: Town, x: number, z: number) => {
  for (let dz = -32; dz <= 32; dz++) for (let dx = -32; dx <= 32; dx++) {
    const cx = x + dx + town.cols / 2, cz = z + dz + town.rows / 2
    if (cx >= 0 && cz >= 0 && cx < town.cols && cz < town.rows && town.ground[cz * town.cols + cx]) return true
  }
  return false
}

it('requires the entire plot to fit within 32 cells of existing land', () => {
  const town = layoutTown([])
  // The old nearest-rectangle test accepts this even though its far edge is outside the expansion.
  expect(REACH_CELLS).toBe(32)
  expect(canPlace(town, [52, -24])).toBe(false)
  expect(canPlace(town, [36, -24])).toBe(true)
  expect(canPlace(town, [22, -24])).toBe(true)
  for (let z = -60; z < 40; z += 4) for (let x = -60; x < 60; x += 4) {
    if (!canPlace(town, [x, z])) continue
    for (let dz = 0; dz < PLOT_CELLS; dz++) for (let dx = 0; dx < PLOT_CELLS; dx++) {
      expect(expandedLand(town, x + dx, z + dz), `plot ${x},${z} extends beyond existing land + 32`).toBe(true)
    }
  }
})

it('clips grid segments instead of drawing a rectangular blanket across forbidden sea', () => {
  const town = layoutTown([])
  const positions = mapGridPositions(town)
  expect(positions.length).toBeGreaterThan(0)
  const seen = new Set<string>()
  for (let i = 0; i < positions.length; i += 6) {
    const [x, y, z, ex, ey, ez] = positions.slice(i, i + 6)
    expect(y).toBe(0)
    expect(ey).toBe(0)
    expect(Math.abs(ex - x) + Math.abs(ez - z)).toBe(CELL)
    const key = [x, z, ex, ez].join(',')
    expect(seen.has(key)).toBe(false)
    seen.add(key)
    for (const n of [x, z, ex, ez]) expect(Number.isInteger(n / CELL)).toBe(true)
    const cx = Math.min(x, ex) / CELL, cz = Math.min(z, ez) / CELL
    expect(expandedLand(town, cx, cz) || expandedLand(town, cx - (x === ex ? 1 : 0), cz - (z === ez ? 1 : 0))).toBe(true)
  }
})

it('uses the current island while moving, but allows the selected company’s own footprint', () => {
  const town = layoutTown([{ id: 'a', name: 'A', members: 1, at: [40, 20] }])
  expect(canPlace(town, [40, 20])).toBe(false)
  expect(canMove(town, 'a', [40, 20])).toBe(true)
  expect(canMove(town, 'a', [52, 20])).toBe(true)
  expect(canMove(town, 'a', [80, 20])).toBe(false)
})

it('matches the land and placement fixtures also checked by the backend', async () => {
  const { default: fixtures } = await import('../../backend/internal/usecase/testdata/plot_placement.json')
  for (const f of fixtures) {
    const town = layoutTown(f.plots.map((at, i) => ({ id: String(i), name: '', members: 0, at: at as [number, number] })))
    let hash = 2166136261
    for (const cell of town.ground) hash = Math.imul(hash ^ (cell ? 1 : 0), 16777619) >>> 0
    expect([town.cols, town.rows, hash]).toEqual([f.cols, f.rows, f.landHash])
    for (const sample of f.samples) {
      const at = sample.at as [number, number]
      expect(canPlace(town, at), `place ${at}`).toBe(sample.place)
      if (f.plots.length) expect(canMove(town, '0', at), `move ${at}`).toBe(sample.move)
    }
  }
})

it('draws exactly the union of legal footprints, excluding occupied and unusable cells', () => {
  const town = layoutTown([{ id: 'a', name: 'A', members: 0, at: [-8, -8] }])
  for (const moved of [undefined, 'a']) {
    const covered = new Set<string>()
    for (let z = -town.rows / 2 - REACH_CELLS; z < town.rows / 2 + REACH_CELLS; z++) {
      for (let x = -town.cols / 2 - REACH_CELLS; x < town.cols / 2 + REACH_CELLS; x++) {
        if (!canPlace(town, [x, z], moved)) continue
        for (let dz = 0; dz < PLOT_CELLS; dz++) for (let dx = 0; dx < PLOT_CELLS; dx++) covered.add(`${x + dx},${z + dz}`)
      }
    }
    const expected = new Set<string>()
    for (const cell of covered) {
      const [x, z] = cell.split(',').map(Number)
      expected.add([x, z, x + 1, z].join(','))
      expected.add([x, z + 1, x + 1, z + 1].join(','))
      expected.add([x, z, x, z + 1].join(','))
      expected.add([x + 1, z, x + 1, z + 1].join(','))
    }
    const positions = mapGridPositions(town, moved)
    const actual = new Set<string>()
    for (let i = 0; i < positions.length; i += 6) actual.add([positions[i], positions[i + 2], positions[i + 3], positions[i + 5]].map((n) => n / CELL).join(','))
    expect(actual).toEqual(expected)
    expect(positions.length / 6).toBe(actual.size)
    expect(covered.has('-8,-8')).toBe(!!moved)
    expect(covered.has('-20,-30')).toBe(false)
  }
})
