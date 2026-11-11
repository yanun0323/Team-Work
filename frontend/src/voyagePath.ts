// The flights that bring the camera to an island, as paths in time. No React.
//
// The camera follows a plane high over the sea, looking down at a slant steeper than the game's; the island comes in from the edge
// and grows as the camera comes down to it, tilts to the game's view and stays there while the plane flies on.
// Going to another island first takes off from this one's airport and flies away along the screen, to the right, or
// back to the left for the player's own island (`Departure`), straight on over open sea until the other island has
// come; then the plane and camera jump unseen to open sea before it (`crossing`, `drift`), and it comes in the same
// way from that side (`approach`), flying on across it and off the screen.

import * as THREE from 'three'
import { create } from 'zustand'
import { poseAt, TAKEOFF, type Obstacle } from './Airport'
import { ISO_DIR, SCREEN_RIGHT, type Shot, type View } from './camera'
import type { Intro } from './boot'

/** The plane's cruising height; above the tallest building and the low clouds. */
export const CRUISE_Y = 46
/** The clouds it flies over. */
export const CLOUD_Y = 30
/** The cruise's zoom, as a share of the island's: far enough out for the island to grow as it comes. */
export const CRUISE_ZOOM = 0.3
const MIN_CRUISE_ZOOM = 1.5
/** Cruising speed, in world units per second. */
export const CRUISE_SPEED = 140
/** The radius of the turn from the runway onto the way out. */
const TURN_RADIUS = 30
/** The plane on screen, in pixels nose to tail, whatever the zoom; and its own length. */
const PLANE_PX = 90
const PLANE_LENGTH = 8.8
/** How many times its cruising size the plane starts the startup landing at, shrinking as the camera comes down. */
export const INTRO_GROW = 2
/** Seconds to come in on another island, once it is there. */
export const ARRIVAL_SECONDS = 4
/** Share of an approach the plane takes to get over the island; the camera settles in the rest, as it flies on. */
const PLANE_SHARE = 0.7
/** How long the take-off is, in the airport's own time, sped up this much. */
const TAKEOFF_FROM = TAKEOFF[0] + 1
const TAKEOFF_SPEEDUP = 5
export const TAKEOFF_SECONDS = (TAKEOFF[1] - TAKEOFF_FROM) / TAKEOFF_SPEEDUP
/** Seconds from the speed it climbs out at to cruising speed. */
const SPEED_UP = 2
/** Seconds the camera takes to leave the player's view for the plane's. */
export const DEPART_CAMERA_SECONDS = 3.2
/** How far along the climb the plane reaches cruising height. */
const CLIMB = 80
/** Banking: the sideways pull, in world units per second², that leans the plane a radian-ish, and the most it leans. */
const BANK_PULL = 200
const MAX_BANK = 0.6

/**
 * The cruise's view: looking down at a slant, between straight down and the game's view (about 42°), from the same
 * side as the game's view so the screen's axes stay put.
 */
export const TOP_ELEVATION = THREE.MathUtils.degToRad(65)
const ISO_ELEVATION = Math.asin(ISO_DIR.y)
const ACROSS = new THREE.Vector2(ISO_DIR.x, ISO_DIR.z).normalize()

/** The direction to the camera, `k` of the way (0 to 1) from looking down to the game's view. */
export function viewDir(k: number, out = new THREE.Vector3()) {
  if (k >= 1) return out.copy(ISO_DIR)
  const e = TOP_ELEVATION + (ISO_ELEVATION - TOP_ELEVATION) * k
  return out.set(ACROSS.x * Math.cos(e), Math.sin(e), ACROSS.y * Math.cos(e))
}

/** 0 before `a`, 1 after `b`, easing in and out between. */
export function smooth(a: number, b: number, x: number) {
  const k = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1)
  return k * k * (3 - 2 * k)
}

/** The point on the ground that puts `p` in the middle of the screen, looking along `dir`. */
export function groundUnder(p: THREE.Vector3, dir: THREE.Vector3, out = new THREE.Vector3()) {
  return out.copy(p).addScaledVector(dir, -p.y / dir.y)
}

/**
 * How far a camera must look from a point for nothing within `radius` of it to show, at this zoom, looking down at
 * the cruise's slant or steeper: the screen's height reaches further over the ground the more it slants.
 */
export function clearDistance(view: Pick<View, 'width' | 'height'>, zoom: number, radius: number) {
  return Math.hypot(view.width / 2, view.height / 2 / Math.sin(TOP_ELEVATION)) / zoom + radius
}

export const cruiseZoom = (islandZoom: number) => Math.max(MIN_CRUISE_ZOOM, islandZoom * CRUISE_ZOOM)

/** How much bigger than its own size the plane is drawn, so it is never tiny when the camera is far out. */
export const planeScale = (zoom: number) => Math.max(1, PLANE_PX / (PLANE_LENGTH * zoom))

/** Heading about y for a plane whose nose is along +x, flying along (dx, dz). */
export const headingOf = (dx: number, dz: number) => Math.atan2(-dz, dx)

/** How far the plane leans into a turn, from its speed and how sharply its path bends. */
const bank = (speed: number, curvature: number) => THREE.MathUtils.clamp(Math.atan((curvature * speed * speed) / BANK_PULL), -MAX_BANK, MAX_BANK)

export interface Pose {
  p: THREE.Vector3
  heading: number
  /** Nose up, radians. */
  pitch: number
  /** Leaning into a turn: positive lowers the right wing (+z, nose along +x). */
  roll: number
  /** Unit, flat: where it is going. */
  dir: THREE.Vector3
  speed: number
  gear: boolean
}

export const newPose = (): Pose => ({ p: new THREE.Vector3(), heading: 0, pitch: 0, roll: 0, dir: new THREE.Vector3(1, 0, 0), speed: 0, gear: false })

/** What the camera shows at a moment of a flight. */
export interface Frame {
  plane: Pose
  target: THREE.Vector3
  zoom: number
  /** 0 looking down, 1 the game's view. */
  tilt: number
  /** How much of the high clouds show, 0 to 1. */
  clouds: number
  /** How many times its own size the plane is drawn. */
  scale: number
}

export const newFrame = (): Frame => ({ plane: newPose(), target: new THREE.Vector3(), zoom: 1, tilt: 0, clouds: 0, scale: 1 })

// ---------------------------------------------------------------- leaving an island

/** The way out along the screen: right to another island, left back to the player's own. */
export const wayOut = (home: boolean) => SCREEN_RIGHT.clone().multiplyScalar(home ? -1 : 1)

export interface Departure {
  /** The airport's middle, in world units. */
  airport: THREE.Vector3
  obstacles: Obstacle[]
  /** Where the take-off ends, and its speed. */
  climbFrom: THREE.Vector3
  climbSpeed: number
  /** The turn from the runway onto the way out, in radians; positive turns its heading up (towards -z). */
  turn: number
  /** Where the turn ends, flat; from there it flies straight on along `out`. */
  turnEnd: THREE.Vector3
  out: THREE.Vector3
  /** Seconds from the start of the take-off until the island left is out of sight, the camera out at cruise. */
  clear: number
}

const scratch = new THREE.Object3D()

/**
 * Taking off from the airport at `airport` east along its runway, then turning onto the way out (`wayOut`) and flying
 * straight on: for `home`, back over the island it left. `clear` is when an island up to `radius` across, round the
 * origin, has gone from the screen at `zoom`.
 */
export function departure(airport: THREE.Vector3, obstacles: Obstacle[], view: Pick<View, 'width' | 'height'>, zoom: number, radius: number, home = false): Departure {
  poseAt(TAKEOFF[1], scratch, obstacles)
  const climbFrom = scratch.position.clone().add(airport)
  poseAt(TAKEOFF[1] - 0.1, scratch, obstacles)
  const climbSpeed = (climbFrom.x - airport.x - scratch.position.x) / 0.1 * TAKEOFF_SPEEDUP
  const out = wayOut(home)
  const turn = headingOf(out.x, out.z)
  const d: Departure = { airport, obstacles, climbFrom, climbSpeed, turn, turnEnd: new THREE.Vector3(), out, clear: 0 }
  d.turnEnd.copy(flatAt(d, TURN_RADIUS * Math.abs(turn), newPose(), true).p)
  // the island gone from the screen for good: past it along the way out
  const pose = newPose()
  const target = new THREE.Vector3()
  const down = viewDir(0)
  const sight = { view, radius }
  d.clear = 60
  for (let t = Math.max(TAKEOFF_SECONDS, DEPART_CAMERA_SECONDS); t < 60; t += 0.02) {
    departAt(d, t, pose)
    if (pose.p.x * out.x + pose.p.z * out.z <= 0) continue
    if (!inSight(groundUnder(pose.p, down, target), zoom, new THREE.Vector3(), sight)) {
      d.clear = t
      break
    }
  }
  return d
}

/** Where the path is, flat, `s` world units after the take-off: round the turn, then straight on. */
function flatAt(d: Departure, s: number, out: Pose, turning = false) {
  const r = TURN_RADIUS
  const turned = r * Math.abs(d.turn)
  if (s < turned || turning) {
    const sign = Math.sign(d.turn)
    const h = (sign * s) / r
    out.p.set(d.climbFrom.x + r * Math.sin(s / r), 0, d.climbFrom.z + sign * r * (Math.cos(h) - 1))
    out.dir.set(Math.cos(h), 0, -Math.sin(h))
    // a turn up its heading is to the left: the left wing down
    out.roll = -sign
  } else {
    out.p.copy(d.turnEnd).addScaledVector(d.out, s - turned)
    out.dir.copy(d.out)
    out.roll = 0
  }
  return out
}

/** World units flown in the `t` seconds after take-off: speeding up from the climb-out to cruising speed. */
function climbed(d: Departure, t: number) {
  const ramp = Math.min(t, SPEED_UP)
  const s = d.climbSpeed * ramp + ((CRUISE_SPEED - d.climbSpeed) / (2 * SPEED_UP)) * ramp * ramp
  return s + CRUISE_SPEED * Math.max(0, t - SPEED_UP)
}

/** The plane `t` seconds after it starts its take-off. */
export function departAt(d: Departure, t: number, out: Pose) {
  if (t < TAKEOFF_SECONDS) {
    poseAt(TAKEOFF_FROM + t * TAKEOFF_SPEEDUP, scratch, d.obstacles)
    out.p.copy(scratch.position).add(d.airport)
    out.heading = scratch.rotation.y
    out.pitch = scratch.rotation.z
    out.roll = 0
    out.dir.set(1, 0, 0)
    poseAt(TAKEOFF_FROM + (t + 0.05) * TAKEOFF_SPEEDUP, scratch, d.obstacles)
    out.speed = (scratch.position.x + d.airport.x - out.p.x) / 0.05
    // wheels up once well clear of the runway
    out.gear = out.p.y < 4
    return out
  }
  const s = climbed(d, t - TAKEOFF_SECONDS)
  const k = s / CLIMB
  flatAt(d, s, out)
  out.speed = Math.min(CRUISE_SPEED, d.climbSpeed + (CRUISE_SPEED - d.climbSpeed) * Math.min(1, (t - TAKEOFF_SECONDS) / SPEED_UP))
  out.roll *= bank(out.speed, 1 / TURN_RADIUS)
  out.p.y = d.climbFrom.y + (CRUISE_Y - d.climbFrom.y) * smooth(0, 1, k)
  out.heading = headingOf(out.dir.x, out.dir.z)
  // levelling off from the take-off's climb
  out.pitch = 0.2 * (1 - smooth(0, 1, k))
  out.gear = false
  return out
}

/**
 * The camera `t` seconds into leaving: from the player's view `from`, onto the plane, out to `cruise` and looking
 * down, with the high clouds coming in.
 */
export function departFrame(d: Departure, from: Shot, cruise: number, t: number, out: Frame) {
  departAt(d, t, out.plane)
  const T = DEPART_CAMERA_SECONDS
  out.tilt = 1 - smooth(T * 0.3, T, t)
  const dir = viewDir(out.tilt, new THREE.Vector3())
  groundUnder(out.plane.p, dir, out.target)
  out.target.lerpVectors(from.target, out.target, smooth(T * 0.05, T * 0.8, t))
  out.zoom = from.zoom * (cruise / from.zoom) ** smooth(T * 0.1, T, t)
  out.clouds = smooth(T * 0.45, T, t)
  // the plane grows to its cruising size as it climbs, never a giant on the runway
  out.scale = 1 + (planeScale(out.zoom) - 1) * THREE.MathUtils.clamp(out.plane.p.y / CRUISE_Y, 0, 1)
  return out
}

// ---------------------------------------------------------------- coming in

export interface Approach {
  /** The plane's path, a cubic Bézier from where it is to over the island. */
  path: [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3]
  seconds: number
  /** Seconds to fly the path; then on, straight along `exit`. */
  flight: number
  exit: THREE.Vector3
  exitSpeed: number
  to: Shot
  zoomFrom: number
  /** Seconds in when the island first shows: the camera starts turning to the game's view from then on. */
  tiltFrom: number
  /** How many times its cruising size the plane starts at, shrinking to it as the camera comes down. */
  grow: number
}

/** The island, `radius` round the middle of the view `to`, and the screen it is looked for on. */
export interface Sight {
  view: Pick<View, 'width' | 'height'>
  radius: number
}

/**
 * Coming in on the island seen from `to`, starting at `from`, flying along `dir` at `speed`, the camera out at
 * `zoomFrom`; over in `seconds`. The camera turns to the game's view from when the island comes into `sight`.
 */
export function approach(from: THREE.Vector3, dir: THREE.Vector3, speed: number, to: Shot, zoomFrom: number, seconds: number, sight: Sight, grow = 1): Approach {
  const flight = seconds * PLANE_SHARE
  const over = new THREE.Vector3(to.target.x, CRUISE_Y, to.target.z)
  const exit = over.clone().sub(from).setY(0)
  const d = exit.length()
  if (d < 1e-3) exit.copy(dir)
  exit.normalize()
  const p0 = from.clone()
  const p1 = p0.clone().addScaledVector(dir, (speed * flight) / 3)
  const p2 = over.clone().addScaledVector(exit, -d / 3)
  const a: Approach = { path: [p0, p1, p2, over], seconds, flight, exit, exitSpeed: d / flight, to: { target: to.target.clone(), zoom: to.zoom }, zoomFrom, tiltFrom: 0, grow }
  a.tiltFrom = firstSight(a, sight)
  return a
}

/** How steeply the camera looks down while it has not started turning, as a sine: the screen's height on the ground. */
const TOP_SIN = Math.sin(TOP_ELEVATION)
const SCREEN_AHEAD = new THREE.Vector3(-ISO_DIR.x, 0, -ISO_DIR.z).normalize()

/** Whether any of the island shows, the camera looking down at `target` at `zoom`. */
export function inSight(target: THREE.Vector3, zoom: number, island: THREE.Vector3, sight: Sight) {
  const x = island.x - target.x, z = island.z - target.z
  const u = x * SCREEN_RIGHT.x + z * SCREEN_RIGHT.z
  const v = x * SCREEN_AHEAD.x + z * SCREEN_AHEAD.z
  return Math.abs(u) - sight.radius < sight.view.width / 2 / zoom && (Math.abs(v) - sight.radius) * TOP_SIN < sight.view.height / 2 / zoom
}

/** The first moment the island shows, the camera still looking down; the end if it never does before. */
function firstSight(a: Approach, sight: Sight) {
  const pose = newPose()
  const target = new THREE.Vector3()
  const down = viewDir(0)
  const T = a.seconds
  for (let t = 0; t < T; t += 0.02) {
    approachAt(a, t, pose)
    groundUnder(t < a.flight ? pose.p : a.path[3], down, target)
    target.lerp(a.to.target, smooth(T * 0.3, T, t))
    const zoom = a.zoomFrom * (a.to.zoom / a.zoomFrom) ** smooth(T * 0.1, T, t)
    if (inSight(target, zoom, a.to.target, sight)) return t
  }
  return T * 0.5
}

const d1 = new THREE.Vector3()
const d2 = new THREE.Vector3()
const e0 = new THREE.Vector3()
const e1 = new THREE.Vector3()
const e2 = new THREE.Vector3()

/** The plane `t` seconds into an approach; past the island, flying on. */
export function approachAt(a: Approach, t: number, out: Pose) {
  const [p0, p1, p2, p3] = a.path
  if (t >= a.flight) {
    const on = t - a.flight
    out.p.copy(p3).addScaledVector(a.exit, a.exitSpeed * on)
    // climbing gently away
    out.p.y += on * 3
    out.dir.copy(a.exit)
    out.speed = a.exitSpeed
    out.pitch = 0.05
    out.roll = 0
  } else {
    const u = THREE.MathUtils.clamp(t / a.flight, 0, 1)
    const v = 1 - u
    out.p.set(0, 0, 0).addScaledVector(p0, v * v * v).addScaledVector(p1, 3 * v * v * u).addScaledVector(p2, 3 * v * u * u).addScaledVector(p3, u * u * u)
    // first and second derivatives along u, from the control polygon's edges
    e0.subVectors(p1, p0)
    e1.subVectors(p2, p1)
    e2.subVectors(p3, p2)
    d1.set(0, 0, 0).addScaledVector(e0, 3 * v * v).addScaledVector(e1, 6 * v * u).addScaledVector(e2, 3 * u * u)
    d2.subVectors(e1, e0).multiplyScalar(6 * v).addScaledVector(e2.sub(e1), 6 * u)
    const flat = Math.hypot(d1.x, d1.z)
    out.dir.set(d1.x, 0, d1.z).normalize()
    out.speed = flat / a.flight
    const cross = d1.z * d2.x - d1.x * d2.z
    out.roll = flat > 1e-6 ? -bank(out.speed, cross / flat ** 3) : 0
    out.pitch = 0
  }
  out.heading = headingOf(out.dir.x, out.dir.z)
  out.gear = false
  return out
}

/** The camera `t` seconds into an approach: following the plane, then coming down onto the island and tilting to the game's view. */
export function approachFrame(a: Approach, t: number, out: Frame) {
  approachAt(a, t, out.plane)
  const T = a.seconds
  out.tilt = smooth(a.tiltFrom, T, t)
  const dir = viewDir(out.tilt, new THREE.Vector3())
  // the camera follows the plane only as far as over the island, so it never runs past it and comes back
  groundUnder(t < a.flight ? out.plane.p : a.path[3], dir, out.target)
  out.target.lerp(a.to.target, smooth(T * 0.3, T, t))
  out.zoom = a.zoomFrom * (a.to.zoom / a.zoomFrom) ** smooth(T * 0.1, T, t)
  out.clouds = 1 - smooth(T * 0.4, T * 0.85, t)
  out.scale = planeScale(out.zoom)
  if (a.grow !== 1) {
    // its size on screen, from `grow` times its cruising size down to its own over the island
    const end = PLANE_LENGTH * a.to.zoom * planeScale(a.to.zoom)
    const px = THREE.MathUtils.lerp(PLANE_PX * a.grow, end, smooth(T * 0.1, T, t))
    out.scale = px / (PLANE_LENGTH * out.zoom)
  }
  return out
}

/** Which way the plane comes in at the start: from the lower left of the screen towards the upper right. */
const IN = SCREEN_RIGHT.clone().multiplyScalar(0.85).addScaledVector(new THREE.Vector3(-ISO_DIR.x, 0, -ISO_DIR.z).normalize(), 0.5).normalize()

/**
 * Comes in from far over the sea onto the island seen from `to`, `radius` across, on a screen this size; starting
 * at least `room` away from it.
 */
export function introApproach(to: Shot, view: Pick<View, 'width' | 'height'>, radius: number, seconds: number, room = radius): Approach {
  const zoomFrom = cruiseZoom(to.zoom)
  // far enough out for a stretch of open sea first, as the startup screen clears
  const far = clearDistance(view, zoomFrom, Math.max(room, radius)) * 1.4
  // from a little to one side, so the path curves in
  const from = IN.clone().applyAxisAngle(THREE.Object3D.DEFAULT_UP, -0.35).multiplyScalar(-far).add(to.target).setY(CRUISE_Y)
  const dir = IN.clone().applyAxisAngle(THREE.Object3D.DEFAULT_UP, 0.3)
  return approach(from, dir, far / (seconds * PLANE_SHARE), to, zoomFrom, seconds, { view, radius }, INTRO_GROW)
}

/**
 * How far the flights have jumped the plane and the camera (`crossing`): the sea's ripples and the clouds flown over
 * are drawn this much further on, so the jump never shows.
 */
export const drift = new THREE.Vector3()

/**
 * Coming in on the island seen from `to`, `sight.radius` across, along `out`, from the plane flying straight along it
 * out at `zoomFrom`: the plane jumps to open sea before the island, at least `room` from it, with the camera, and
 * crosses it from there. Returns the approach and how far it jumped, flat.
 */
export function crossing(plane: Pose, out: THREE.Vector3, to: Shot, zoomFrom: number, seconds: number, sight: Sight, room = sight.radius) {
  // the camera looks at the ground a little off the plane: a plane's height more is plenty
  const far = clearDistance(sight.view, zoomFrom, Math.max(room, sight.radius)) + CRUISE_Y
  const from = new THREE.Vector3(to.target.x, plane.p.y, to.target.z).addScaledVector(out, -far)
  const jump = from.clone().sub(plane.p).setY(0)
  return { a: approach(from, out, plane.speed, to, zoomFrom, seconds, sight), jump }
}

/**
 * How much shadow the plane at `p` casts, the sun towards `toSun`: all of it while its shadow falls on the island,
 * `radius` round the origin, none out at sea, past where the sun's shadow box may end (World.tsx); fading between.
 */
export function planeShadow(p: THREE.Vector3, toSun: THREE.Vector3, radius: number) {
  const k = p.y / Math.max(toSun.y, 0.05)
  return 1 - smooth(radius * 0.5, radius, Math.hypot(p.x - toSun.x * k, p.z - toSun.z * k))
}

// ---------------------------------------------------------------- the scene's side

interface VoyageState {
  /** A flight has the camera: the player's controls wait. */
  active: boolean
  /** Taking off from the island shown, which is still there: its airport's own plane keeps off the runway. */
  leaving: boolean
  /**
   * The screen's controls and panels are off the screen: from the start until the plane has brought the camera in,
   * and from leaving an island until it has landed on the next. Never with reduced motion, which flies no plane.
   */
  away: boolean
  /** A startup landing asked for, picked up by the scene's next frame. */
  intro: Intro | null
}

const calm = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

export const useVoyage = create<VoyageState>(() => ({ active: false, leaving: false, away: !calm, intro: null }))

/** Starts the startup landing: the camera comes in on the island following a plane. */
export function startIntro(intro: Intro) {
  useVoyage.setState({ active: true, away: true, intro })
}
