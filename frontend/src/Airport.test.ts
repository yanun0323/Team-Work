import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { clearance, poseAt, runwayObstacles } from './Airport'
import { ROOF_TOP } from './Building'
import { AIRPORT, CELL, FLOOR_CELLS, MAX_FLOORS, PLOT_CELLS, rectCenter, RUNWAY_LINE, layoutTown, type Town } from './layout'

// a tall company at each end of the runway's line, and one well off it
const BIG = { members: 40, bytes: 1e13 }
const line = AIRPORT.z + RUNWAY_LINE - PLOT_CELLS / 2
const town = layoutTown([
  { id: 'east', name: 'E', ...BIG, at: [AIRPORT.x + AIRPORT.w + 2, line] },
  { id: 'west', name: 'W', ...BIG, at: [AIRPORT.x - 2 - PLOT_CELLS, line] },
  { id: 'off', name: 'O', ...BIG, at: [AIRPORT.x + AIRPORT.w + 2, AIRPORT.z + AIRPORT.d + 4] },
])

/** The building's box in airport units, x and z. */
function box(t: Town, id: string) {
  const l = t.lots.find((l) => l.id === id)!
  const [ax, az] = rectCenter(t, t.airport)
  const [bx, bz] = rectCenter(t, l.building)
  const hw = (l.building.w * CELL) / 2, hd = (l.building.d * CELL) / 2
  return { x0: bx - ax - hw, x1: bx - ax + hw, z0: bz - az - hd, z1: bz - az + hd, top: l.floors * FLOOR_CELLS * CELL + ROOF_TOP }
}

describe('the plane and buildings in the runway line', () => {
  it('finds the buildings on the line, not the one off it', () => {
    expect(town.lots.every((l) => l.floors === MAX_FLOORS)).toBe(true)
    const obstacles = runwayObstacles(town)
    expect(obstacles).toHaveLength(2)
    expect(obstacles.some((o) => o.x0 > 0) && obstacles.some((o) => o.x1 < 0)).toBe(true)
  })

  it('flies over them all through the cycle, and still lands and lifts off on the runway', () => {
    const obstacles = runwayObstacles(town)
    const plane = new THREE.Object3D()
    for (const id of ['east', 'west']) {
      const b = box(town, id)
      for (let t = 0; t < 74; t += 0.02) {
        poseAt(t, plane, obstacles)
        const { x, y } = plane.position
        // nose to tail along x
        if (x + 4.3 > b.x0 && x - 4.3 < b.x1) expect(y, `${id} at t=${t.toFixed(2)}`).toBeGreaterThan(b.top)
      }
    }
    // on the ground when rolling out and lined up
    poseAt(13, plane, obstacles)
    expect(plane.position.y).toBe(0)
    poseAt(62, plane, obstacles)
    expect(plane.position.y).toBe(0)
  })

  it('keeps the usual path with nothing in the way', () => {
    const a = new THREE.Object3D(), b = new THREE.Object3D()
    for (const t of [5, 10, 66, 70]) {
      poseAt(t, a)
      poseAt(t, b, runwayObstacles(layoutTown([])))
      expect(b.position.toArray()).toEqual(a.position.toArray())
    }
  })

  it('ramps smoothly down to the ground towards the runway', () => {
    const o = [{ x0: 60, x1: 80, top: 30 }]
    expect(clearance(90, o, true).y).toBe(30)
    expect(clearance(70, o, true).y).toBe(30)
    expect(clearance(5, o, true).y).toBe(0)
    expect(clearance(70, o, false).y).toBe(0)
    let last = 0
    for (let x = 0; x <= 60; x += 0.5) {
      const c = clearance(x, o, true)
      expect(c.y).toBeGreaterThanOrEqual(last)
      expect(c.slope).toBeGreaterThanOrEqual(0)
      last = c.y
    }
  })
})
