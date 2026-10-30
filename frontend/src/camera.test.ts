import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { drawerWidth, focusView, ISO_DIR, MAX_ZOOM, MIN_ZOOM, SCREEN_RIGHT, SCREEN_UP, shotAt, type Shot } from './camera'

/** Screen position (pixels from the canvas centre, y up) of a world point, for a camera looking at `target`. */
const project = (p: THREE.Vector3, target: THREE.Vector3, zoom: number) => {
  const d = p.clone().sub(target)
  return [d.dot(SCREEN_RIGHT) * zoom, d.dot(SCREEN_UP) * zoom]
}

describe('fusion camera', () => {
  it('has screen axes that match a camera looking down ISO_DIR', () => {
    const cam = new THREE.OrthographicCamera()
    cam.position.copy(ISO_DIR).multiplyScalar(100)
    cam.lookAt(0, 0, 0)
    cam.updateMatrixWorld()
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0)
    const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1)
    expect(right.distanceTo(SCREEN_RIGHT)).toBeLessThan(1e-6)
    expect(up.distanceTo(SCREEN_UP)).toBeLessThan(1e-6)
  })

  it('zooms in further by a scale, keeping the same centre', () => {
    const box = { x: 7, z: -3, w: 12, d: 12, height: 3 }
    const view = { width: 1280, height: 756, coverRight: drawerWidth(1280) }
    const a = focusView(box, view)
    const b = focusView(box, view, 1.14)
    expect(b.zoom / a.zoom).toBeCloseTo(1.14, 6)
    const [ua] = project(new THREE.Vector3(box.x, 0, box.z), a.target, a.zoom)
    const [ub] = project(new THREE.Vector3(box.x, 0, box.z), b.target, b.zoom)
    expect(ub).toBeCloseTo(ua, 3)
  })

  for (const [width, height] of [[1280, 756], [900, 900], [600, 800]]) {
    it(`centres a building in the space left of the drawer (${width}×${height})`, () => {
      const box = { x: 7, z: -3, w: 4, d: 4, height: 9 }
      const cover = drawerWidth(width)
      const { target, zoom } = focusView(box, { width, height, coverRight: cover })
      expect(target.y).toBeCloseTo(0, 6)
      expect(zoom).toBeGreaterThanOrEqual(MIN_ZOOM)
      expect(zoom).toBeLessThanOrEqual(MAX_ZOOM)
      const xs: number[] = []
      const ys: number[] = []
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (const y of [0, box.height]) {
        const [u, v] = project(new THREE.Vector3(box.x + sx * 2, y, box.z + sz * 2), target, zoom)
        xs.push(u)
        ys.push(v)
      }
      const left = -width / 2
      const free = width - cover
      // centred in the free area, and fully inside it
      expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(left + free / 2, 3)
      expect((Math.min(...ys) + Math.max(...ys)) / 2).toBeCloseTo(0, 3)
      expect(Math.min(...xs)).toBeGreaterThan(left)
      expect(Math.max(...xs)).toBeLessThan(left + free)
      expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(height)
    })
  }

  it('gives the drawer half the width, but at least 380px when there is room', () => {
    expect(drawerWidth(1400)).toBe(700)
    expect(drawerWidth(600)).toBe(380)
    expect(drawerWidth(320)).toBe(320)
  })
})

describe('flying between two views', () => {
  // where a point on the map shows on screen, in pixels from the screen centre
  const onScreen = (q: THREE.Vector3, s: Shot) => {
    const d = q.clone().sub(s.target)
    return [d.dot(SCREEN_RIGHT) * s.zoom, d.dot(SCREEN_UP) * s.zoom]
  }
  const from: Shot = { target: new THREE.Vector3(-30, 0, 12), zoom: 9 }
  const to: Shot = { target: new THREE.Vector3(14, 0, -20), zoom: 42 }
  it('starts and ends on the two views', () => {
    expect(shotAt(from, to, 0).target.distanceTo(from.target)).toBeLessThan(1e-9)
    expect(shotAt(from, to, 1).target.distanceTo(to.target)).toBeLessThan(1e-9)
    expect(shotAt(from, to, 1).zoom).toBeCloseTo(to.zoom)
    expect(shotAt(from, to, 0.5).target.y).toBeCloseTo(0)
  })
  it('moves everything on screen in a straight line, with no swing', () => {
    for (const q of [new THREE.Vector3(0, 0, 0), new THREE.Vector3(40, 0, 30), new THREE.Vector3(-25, 6, -40)]) {
      const [a, b] = [onScreen(q, from), onScreen(q, to)]
      const len = Math.hypot(b[0] - a[0], b[1] - a[1])
      for (let u = 0; u <= 1; u += 0.05) {
        const p = onScreen(q, shotAt(from, to, u))
        const off = Math.abs((b[0] - a[0]) * (a[1] - p[1]) - (a[0] - p[0]) * (b[1] - a[1])) / len
        expect(off, `${q.toArray()} at ${u.toFixed(2)}`).toBeLessThan(1e-6)
      }
    }
  })
  it('slides straight across when the zoom stays the same', () => {
    const s = shotAt(from, { ...to, zoom: from.zoom }, 0.5)
    expect(s.target.distanceTo(from.target.clone().lerp(to.target, 0.5))).toBeLessThan(1e-9)
    expect(s.zoom).toBeCloseTo(from.zoom)
  })
})
