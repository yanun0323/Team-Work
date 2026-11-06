import { CELL, layoutTown } from './layout'
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { boxOnScreen, drawerWidth, focusTarget, focusView, groundReach, hidesPoint, islandView, ISO_DIR, MAX_ZOOM, MIN_ZOOM, SCREEN_RIGHT, SCREEN_UP, shotAt, type Shot, seaCoverZoom, SEA_SIZE } from './camera'

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

  it('centres the box in the free area at any zoom when only panning', () => {
    const box = { x: 7, z: -3, w: 12, d: 12, height: 3 }
    const view = { width: 1200, height: 800, coverRight: 600 }
    const middle = new THREE.Vector3(box.x, box.height / 2, box.z)
    for (const zoom of [8, 20, 50]) {
      const [x, y] = project(middle, focusTarget(box, view, zoom), zoom)
      expect(x).toBeCloseTo(-300)
      expect(y).toBeCloseTo(0)
    }
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


describe('boxOnScreen', () => {
  const view = { width: 1000, height: 600 }
  const plot = { x: 0, z: 0, w: 32, d: 32, height: 0 }
  // how far the plot's far corner sits above its centre on screen
  const reach = new THREE.Vector3(-16, 0, -16).dot(SCREEN_UP)
  /** A camera looking at the point `pixels` above the plot's highest corner on screen, at this zoom. */
  const above = (pixels: number, zoom: number) => new THREE.Vector3().addScaledVector(SCREEN_UP, reach + pixels / zoom)

  it('counts a plot as off screen only once all of it has left', () => {
    const zoom = 20
    expect(boxOnScreen(plot, above(view.height / 2 - 5, zoom), zoom, view)).toBe(true)
    expect(boxOnScreen(plot, above(view.height / 2 + 5, zoom), zoom, view)).toBe(false)
  })

  it('brings a plot back on screen when zooming out', () => {
    const center = above(1000, 20)
    expect(boxOnScreen(plot, center, 20, view)).toBe(false)
    expect(boxOnScreen(plot, center, 6, view)).toBe(true)
  })

  it('sees past either side of the screen', () => {
    const across = new THREE.Vector3(16, 0, -16).dot(SCREEN_RIGHT)
    const at = (pixels: number) => new THREE.Vector3().addScaledVector(SCREEN_RIGHT, pixels / 20)
    expect(boxOnScreen(plot, at(across * 20 + view.width / 2 - 5), 20, view)).toBe(true)
    expect(boxOnScreen(plot, at(across * 20 + view.width / 2 + 5), 20, view)).toBe(false)
    expect(boxOnScreen(plot, at(-(across * 20 + view.width / 2 + 5)), 20, view)).toBe(false)
  })
})

describe('initial island overview', () => {
  for (const at of [[-8, -8], [160, 40], [-160, -90]] as [number, number][]) {
    for (const [width, height] of [[1440, 900], [640, 900]]) {
      it(`fits and centres all land at ${at} in ${width}x${height}`, () => {
        const town = layoutTown([{ id: 'a', name: 'A', members: 0, at }])
        const shot = islandView(town, { width, height })
        const xs: number[] = [], ys: number[] = []
        town.ground.forEach((cell, k) => {
          if (!cell) return
          for (const dx of [0, 1]) for (const dz of [0, 1]) {
            const [x, y] = project(new THREE.Vector3((k % town.cols - town.cols / 2 + dx) * CELL, 0, (Math.floor(k / town.cols) - town.rows / 2 + dz) * CELL), shot.target, shot.zoom)
            xs.push(x); ys.push(y)
          }
        })
        expect(Math.min(...xs)).toBeGreaterThan(-width / 2 + 20)
        expect(Math.max(...xs)).toBeLessThan(width / 2 - 20)
        expect(Math.min(...ys)).toBeGreaterThan(-height / 2 + 20)
        expect(Math.max(...ys)).toBeLessThan(height / 2 - 20)
        // Ground remains close to centre; vertical room also accommodates roofs and the tower.
        expect(Math.abs((Math.min(...xs) + Math.max(...xs)) / 2)).toBeLessThan(20)
        expect(Math.abs((Math.min(...ys) + Math.max(...ys)) / 2)).toBeLessThan(80)
      })
    }
  }
})

describe('seaCoverZoom', () => {
  it('keeps every screen corner on the sea', () => {
    const target = new THREE.Vector3(20, 0, -30)
    const view = { width: 1280, height: 820 }
    const zoom = seaCoverZoom(target, view)
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
      const corner = target.clone()
        .addScaledVector(SCREEN_RIGHT, (sx * view.width) / 2 / zoom)
        .addScaledVector(SCREEN_UP, (sy * view.height) / 2 / zoom)
      // follow the line of sight down to the ground
      corner.addScaledVector(ISO_DIR, -corner.y / ISO_DIR.y)
      expect(Math.max(Math.abs(corner.x), Math.abs(corner.z))).toBeLessThanOrEqual(SEA_SIZE / 2 + 1e-6)
    }
  })
})

describe('groundReach', () => {
  it('holds every screen corner on the ground, however far out the zoom goes', () => {
    const target = new THREE.Vector3(20, 0, -30)
    for (const view of [{ width: 1280, height: 820 }, { width: 2560, height: 1400 }, { width: 600, height: 900 }]) {
      for (const zoom of [0.5, 2, MIN_ZOOM, 30]) {
        const reach = groundReach(view, zoom)
        let far = 0
        for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
          const corner = target.clone()
            .addScaledVector(SCREEN_RIGHT, (sx * view.width) / 2 / zoom)
            .addScaledVector(SCREEN_UP, (sy * view.height) / 2 / zoom)
          corner.addScaledVector(ISO_DIR, -corner.y / ISO_DIR.y)
          far = Math.max(far, Math.abs(corner.x - target.x), Math.abs(corner.z - target.z))
        }
        expect(far).toBeLessThanOrEqual(reach + 1e-6)
        // tight: the farthest corner sits on the square's edge
        expect(far).toBeGreaterThan(reach - 1e-6)
      }
    }
  })
})

describe('focusView, tight', () => {
  it('fits the box to the free area, touching its edges with no margin', () => {
    const box = { x: 14, z: -15, w: 44, d: 8.5, height: 6 }
    const view = { width: 1440, height: 900, coverRight: 700 }
    const { target, zoom } = focusView(box, view, 1, true)
    const corners = [-1, 1].flatMap((sx) => [-1, 1].flatMap((sz) => [0, box.height].map((y) =>
      new THREE.Vector3(box.x + (sx * box.w) / 2, y, box.z + (sz * box.d) / 2).sub(target))))
    const xs = corners.map((c) => c.dot(SCREEN_RIGHT) * zoom + view.width / 2)
    const ys = corners.map((c) => view.height / 2 - c.dot(SCREEN_UP) * zoom)
    const free = view.width - view.coverRight
    const [w, h] = [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)]
    // the tighter direction fills the free area exactly, and the box stays centred in it
    expect(Math.max(w / free, h / view.height)).toBeCloseTo(1, 5)
    expect((Math.max(...xs) + Math.min(...xs)) / 2).toBeCloseTo(free / 2, 5)
    expect((Math.max(...ys) + Math.min(...ys)) / 2).toBeCloseTo(view.height / 2, 5)
  })
})

it('tells a building hides someone standing behind it from the camera, not someone in front or beside it', () => {
  const tower = { x: 0, z: 0, w: 10, d: 10, height: 20 }
  // the camera looks from the +x/+z corner: behind is towards -x/-z
  expect(hidesPoint(tower, new THREE.Vector3(-7, 0.5, -7))).toBe(true)
  expect(hidesPoint(tower, new THREE.Vector3(7, 0.5, 7))).toBe(false)
  expect(hidesPoint(tower, new THREE.Vector3(-7, 0.5, 9))).toBe(false)
  // a low shed far in front of someone further back doesn't reach up into the line of sight
  expect(hidesPoint({ x: 0, z: 0, w: 2, d: 2, height: 1 }, new THREE.Vector3(-20, 0.5, -20))).toBe(false)
})
