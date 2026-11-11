import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { runwayObstacles } from './Airport'
import { FULL_INTRO } from './boot'
import { ISO_DIR, SCREEN_RIGHT, type Shot } from './camera'
import { layoutTown, rectCenter } from './layout'
import {
  approach, approachAt, approachFrame, clearDistance, CRUISE_SPEED, CRUISE_Y, crossing, cruiseZoom, DEPART_CAMERA_SECONDS, departAt, departFrame,
  departure, groundUnder, inSight, INTRO_GROW, introApproach, newFrame, newPose, planeScale, planeShadow, startIntro, TAKEOFF_SECONDS, useVoyage,
  viewDir, wayOut,
} from './voyagePath'

const view = { width: 1440, height: 900 }
const shot: Shot = { target: new THREE.Vector3(3, 0, -4), zoom: 12 }
const radius = 90

/** The camera's right, flattened: what stays put on screen as it tilts. */
const rightOf = (dir: THREE.Vector3) => new THREE.Vector3(dir.z, 0, -dir.x).normalize()
const flat = (a: THREE.Vector3, b: THREE.Vector3) => Math.hypot(a.x - b.x, a.z - b.z)
/** Along the screen's horizontal: positive to the right. */
const across = (v: THREE.Vector3) => v.x * SCREEN_RIGHT.x + v.z * SCREEN_RIGHT.z

describe('viewDir', () => {
  it('tilts from a slant between straight down and the game view, to the game view, keeping the screen the same way round', () => {
    expect(viewDir(1).toArray()).toEqual(ISO_DIR.toArray())
    // clearly steeper than the game's view, clearly short of straight down
    const elevation = (k: number) => THREE.MathUtils.radToDeg(Math.asin(viewDir(k).y))
    expect(elevation(0)).toBeGreaterThan(elevation(1) + 15)
    expect(elevation(0)).toBeLessThan(75)
    expect(elevation(0.5)).toBeLessThan(elevation(0))
    expect(elevation(0.5)).toBeGreaterThan(elevation(1))
    for (const k of [0, 0.5]) {
      expect(viewDir(k).length()).toBeCloseTo(1)
      expect(rightOf(viewDir(k)).distanceTo(SCREEN_RIGHT)).toBeLessThan(1e-9)
    }
  })
})

describe('planeScale', () => {
  it('draws the plane bigger only when the camera is far out', () => {
    expect(planeScale(40)).toBe(1)
    expect(planeScale(3)).toBeGreaterThan(planeScale(5))
  })
})

describe('the startup approach', () => {
  const a = introApproach(shot, view, radius, 4.5)
  const f = newFrame()

  it('starts with the island out of sight, looking down from far out', () => {
    approachFrame(a, 0, f)
    expect(f.tilt).toBe(0)
    expect(f.zoom).toBeCloseTo(cruiseZoom(shot.zoom))
    expect(f.clouds).toBe(1)
    expect(flat(f.target, shot.target)).toBeGreaterThan(clearDistance(view, f.zoom, radius))
  })

  it('lands exactly on the island in the game view, the plane flying on past it', () => {
    approachFrame(a, a.seconds, f)
    expect(f.tilt).toBe(1)
    expect(f.zoom).toBeCloseTo(shot.zoom)
    expect(f.target.distanceTo(shot.target)).toBeLessThan(1e-9)
    expect(f.clouds).toBe(0)
    expect(flat(f.plane.p, shot.target)).toBeGreaterThan(10)
  })

  it('starts turning to the game view as soon as the island shows, not before', () => {
    const sight = { view, radius }
    // the camera before it turns, at a moment
    const seen = (t: number) => {
      approachFrame(a, t, f)
      return inSight(f.target, f.zoom, shot.target, sight)
    }
    expect(seen(0)).toBe(false)
    expect(a.tiltFrom).toBeGreaterThan(0)
    expect(a.tiltFrom).toBeLessThan(a.seconds * 0.5)
    expect(seen(a.tiltFrom - 0.02)).toBe(false)
    expect(approachFrame(a, a.tiltFrom - 0.02, f).tilt).toBe(0)
    expect(seen(a.tiltFrom)).toBe(true)
    expect(approachFrame(a, a.tiltFrom + 0.3, f).tilt).toBeGreaterThan(0)
  })

  it('starts with the plane bigger than its cruising size, shrinking to its own as the camera comes down', () => {
    approachFrame(a, 0, f)
    expect(f.scale * f.zoom).toBeCloseTo(planeScale(f.zoom) * f.zoom * INTRO_GROW)
    let px = Infinity
    for (let t = 0; t <= a.seconds; t += 0.05) {
      approachFrame(a, t, f)
      // its size on screen
      const now = f.scale * f.zoom
      expect(now).toBeLessThanOrEqual(px + 1e-9)
      px = now
    }
    expect(f.scale).toBeCloseTo(planeScale(shot.zoom))
  })

  it('comes ever closer and further in on the way, never past the island and back (by more than a pixel)', () => {
    let gap = Infinity, zoom = 0
    for (let t = 0; t <= a.seconds; t += 0.02) {
      approachFrame(a, t, f)
      const now = flat(f.target, shot.target)
      expect(now).toBeLessThanOrEqual(gap + 0.1)
      expect(f.zoom).toBeGreaterThanOrEqual(zoom - 1e-9)
      gap = now
      zoom = f.zoom
    }
  })
})

describe('approach', () => {
  it('sets off the way and as fast as the plane was flying, and flies on smoothly over the island', () => {
    const from = new THREE.Vector3(300, CRUISE_Y, 50)
    const dir = new THREE.Vector3(0, 0, 1)
    const a = approach(from, dir, CRUISE_SPEED, shot, 5, 4, { view, radius })
    const p = newPose()
    approachAt(a, 0, p)
    expect(p.p.distanceTo(from)).toBeLessThan(1e-9)
    expect(p.dir.distanceTo(dir)).toBeLessThan(1e-9)
    expect(p.speed).toBeCloseTo(CRUISE_SPEED)
    // over the island at the end of its path, and no jump into flying on
    approachAt(a, a.flight, p)
    expect(flat(p.p, shot.target)).toBeLessThan(1e-6)
    const before = approachAt(a, a.flight - 1e-4, newPose()).p
    expect(before.distanceTo(p.p)).toBeLessThan(0.05)
    // turning in from heading across, it leans into the turn
    approachAt(a, a.flight * 0.2, p)
    expect(Math.abs(p.roll)).toBeGreaterThan(0.05)
  })
})

describe('leaving an island', () => {
  const town = layoutTown([{ id: 'a', name: 'A', members: 3, bytes: 0 }])
  const [ax, az] = rectCenter(town, town.airport)
  const airport = new THREE.Vector3(ax, 0, az)
  const cruise = cruiseZoom(shot.zoom)
  const p = newPose()

  for (const home of [false, true]) {
    const d = departure(airport, runwayObstacles(town), view, cruise, radius, home)
    const way = home ? 'left, back home' : 'right, to another island'

    it(`rolls down the runway from the airport, wheels down (${way})`, () => {
      departAt(d, 0, p)
      expect(p.p.y).toBe(0)
      expect(p.gear).toBe(true)
      expect(Math.abs(p.p.z - az)).toBeLessThan(30)
      departAt(d, TAKEOFF_SECONDS + 1, p)
      expect(p.gear).toBe(false)
    })

    it(`flies on without a jump, turning onto the way out: ${way}`, () => {
      let last = departAt(d, 0, newPose()).p.clone()
      for (let t = 0.01; t < d.clear + 3; t += 0.01) {
        departAt(d, t, p)
        expect(p.p.distanceTo(last)).toBeLessThan(CRUISE_SPEED * 0.01 + 0.5)
        last = p.p.clone()
      }
      // straight on along the screen, at cruising height and speed
      departAt(d, d.clear + 3, p)
      expect(p.dir.distanceTo(wayOut(home))).toBeLessThan(1e-9)
      expect(Math.sign(across(p.dir))).toBe(home ? -1 : 1)
      expect(p.p.y).toBeCloseTo(CRUISE_Y)
      expect(p.speed).toBeCloseTo(CRUISE_SPEED)
      expect(p.roll).toBe(0)
    })

    it(`turns ${home ? 'back at once' : 'only a little'} after the take-off`, () => {
      // where it heads a second after the take-off
      departAt(d, TAKEOFF_SECONDS + 0.2, p)
      if (home) expect(across(p.dir)).toBeLessThan(across(new THREE.Vector3(1, 0, 0)))
      expect(Math.abs(p.roll)).toBeGreaterThan(0.05)
    })

    it(`has the island off the screen once clear, past it the way out (${way})`, () => {
      expect(d.clear).toBeGreaterThanOrEqual(DEPART_CAMERA_SECONDS)
      expect(d.clear).toBeLessThan(60)
      const f = departFrame(d, { target: new THREE.Vector3(), zoom: 20 }, cruise, d.clear, newFrame())
      expect(f.zoom).toBeCloseTo(cruise)
      expect(inSight(f.target, f.zoom, new THREE.Vector3(), { view, radius })).toBe(false)
      expect(Math.sign(across(f.plane.p))).toBe(home ? -1 : 1)
    })
  }

  it('leaves the player view for the plane, far out and looking down', () => {
    const d = departure(airport, runwayObstacles(town), view, cruise, radius)
    const from: Shot = { target: new THREE.Vector3(10, 0, 10), zoom: 20 }
    const f = newFrame()
    departFrame(d, from, cruise, 0, f)
    expect(f.target.distanceTo(from.target)).toBeLessThan(1e-9)
    expect(f.zoom).toBeCloseTo(20)
    expect(f.tilt).toBe(1)
    expect(f.scale).toBe(1)
    departFrame(d, from, cruise, d.clear + 2, f)
    expect(f.tilt).toBe(0)
    expect(f.zoom).toBeCloseTo(cruise)
    expect(f.scale).toBeCloseTo(planeScale(cruise))
    // the plane in the middle of the screen: the camera looks at the ground along its line of sight through it
    expect(f.target.distanceTo(groundUnder(f.plane.p, viewDir(0)))).toBeLessThan(1e-6)
  })

  it('flies higher than before: the island is smaller as it goes and comes', () => {
    expect(cruise).toBeLessThanOrEqual(shot.zoom * 0.3 + 1e-9)
  })
})

describe('crossing to the island arrived', () => {
  const sight = { view, radius }
  const cruise = cruiseZoom(shot.zoom)
  const f = newFrame()

  for (const home of [false, true]) {
    const out = wayOut(home)
    const plane = newPose()
    plane.p.set(900, CRUISE_Y, -700)
    plane.dir.copy(out)
    plane.speed = CRUISE_SPEED
    const { a, jump } = crossing(plane, out, shot, cruise, 4, sight)
    const side = home ? 'from the left' : 'from the right'

    it(`jumps flat, on over open sea, the same way at the same speed (${side})`, () => {
      expect(jump.y).toBe(0)
      const start = approachAt(a, 0, newPose())
      expect(start.p.distanceTo(plane.p.clone().add(jump))).toBeLessThan(1e-9)
      expect(start.dir.distanceTo(out)).toBeLessThan(1e-9)
      expect(start.speed).toBeCloseTo(CRUISE_SPEED)
      approachFrame(a, 0, f)
      expect(f.zoom).toBeCloseTo(cruise)
      expect(f.tilt).toBe(0)
      expect(inSight(f.target, f.zoom, shot.target, sight)).toBe(false)
    })

    it(`brings the island in ${side} of the screen, flies straight over it and on, off the other side`, () => {
      // the island ahead of the plane: on the screen's side it flies to
      const start = approachAt(a, 0, newPose()).p
      expect(Math.sign(across(shot.target) - across(start))).toBe(home ? -1 : 1)
      for (let t = 0; t <= a.seconds + 3; t += 0.1) {
        const q = approachAt(a, t, newPose())
        expect(q.dir.distanceTo(out)).toBeLessThan(1e-6)
      }
      approachAt(a, a.flight, plane)
      expect(flat(plane.p, shot.target)).toBeLessThan(1e-6)
      approachFrame(a, a.seconds, f)
      expect(f.target.distanceTo(shot.target)).toBeLessThan(1e-9)
      expect(f.tilt).toBe(1)
    })
  }
})

describe('planeShadow', () => {
  const up = new THREE.Vector3(0.3, 0.8, 0.2).normalize()
  it('casts the whole shadow over the island and none out at sea, fading between', () => {
    // straight above the point its shadow falls on
    const over = (x: number, z: number) => new THREE.Vector3(x, CRUISE_Y, z).addScaledVector(up, CRUISE_Y / up.y).setY(CRUISE_Y)
    expect(planeShadow(over(0, 0), up, radius)).toBe(1)
    expect(planeShadow(over(radius * 2, 0), up, radius)).toBe(0)
    const mid = planeShadow(over(radius * 0.75, 0), up, radius)
    expect(mid).toBeGreaterThan(0)
    expect(mid).toBeLessThan(1)
  })
})

describe('the screen while a plane has the camera', () => {
  it('starts with the controls off the screen, and keeps them off through the startup landing', () => {
    expect(useVoyage.getState().away).toBe(true)
    useVoyage.setState({ away: false })
    startIntro(FULL_INTRO)
    expect(useVoyage.getState()).toMatchObject({ active: true, away: true, intro: FULL_INTRO })
    useVoyage.setState({ active: false, away: false, intro: null })
  })
})
