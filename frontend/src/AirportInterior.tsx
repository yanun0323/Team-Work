// The airport seen from inside, shown while it is open: the terminal without its roof and a glass-walled
// tower cab. The hall stands on a solid base, so its floor has a real opening in it. Two escalators sink
// through that opening towards the camera and run in under its near edge, where the floor hides whoever
// rides them; nothing further down is drawn. A passenger comes up one, checks in, passes security and
// boards at a gate; later they get off a plane, pass customs and leave down the other.

import { useFrame } from '@react-three/fiber'
import { useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { Clear, CUT, FLOOR_TOP } from './Building'
import type { Look } from './core/domain/types'
import { BRIDGE_DX, HALL_LIFT, hash, STANDS, TERMINAL, TOWER } from './layout'
import { OFFICE_SCALE } from './office'
import { Figure, lookOf, newRig, pose, type Rig } from './People'
import { usePrefs } from './prefs'
import { toon } from './toon'
import { MAX_FRAME } from './PixelPass'
import { advance, inSteps, type P, type Walker } from './walk'

type V3 = [number, number, number]

const calm = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

function B({ p, s, c, shadow = true }: { p: V3; s: V3; c: string; shadow?: boolean }) {
  return (
    <mesh position={p} scale={s} material={toon(c)} castShadow={shadow} receiveShadow>
      <boxGeometry />
    </mesh>
  )
}

const WALL = 0.2
const BLUE = '#3b6fb0'
const PAINT = '#eef1f5'
/** Facing the glass; figures sit with their back to the seat's far edge. */
const TO_GLASS = Math.PI
/** Height of a chair's seat over the floor, for a figure built in office units. */
const SEAT = 0.23 * OFFICE_SCALE

const DEPART_Z = -15.6
const RETURN_Z = -13.6
const SERVICE_Z = -17.4
const SEATS_Z = -17.3
const DESK_Z = -18.4
const STAFF_Z = -19
const CHECK_IN = [-6, -3.5, -1]
export const SECURITY_X = 5
export const ARCH_Z = DEPART_Z
/** The one opening each way in the line at `SECURITY_X`: half-widths of the arch and of the customs lane. */
export const ARCH_HALF = 0.75
export const CUSTOMS_HALF = 0.7
export const CUSTOMS_Z = RETURN_Z
const CUSTOMS_X = 4.2
const GATES = STANDS.map((x) => x + BRIDGE_DX)
/** At a gate's door, on the way out to the jet bridge. */
export const DOOR_Z = TERMINAL.z1 - 0.45
const SHOP = { x0: 16, x1: 20.4 }
const CAFE = { x0: 20.6, x1: 24.6 }

/**
 * The opening in the floor. Escalators run along x: the head is at `WELL.x0`, and they sink towards +x, which
 * is towards the camera, so they pass under the floor at `WELL.x1` and end out of sight at `FOOT_X`.
 */
const WELL = { x0: -5.6, x1: 0, z0: -14.5, z1: -11.5 }
const FOOT_X = 1.2
const SLOPE = 0.42
export const UP_Z = -12.3
export const DOWN_Z = -13.7
const STEPS_W = 1.05
/** Where passengers step on and off, between the opening and the west wall: a lane each way. */
const AISLE_UP_X = -6.95
const AISLE_DOWN_X = -6.25
/** At a gate's door, boarders keep to one side and arrivals to the other. */
const DOOR_LANE = 0.32
/** Round the opening's far side, on the way from customs to the aisle. */
const PAST_WELL_Z = -15
/** Below this, a rider is past the floor's edge and hidden by it. */
export const HIDDEN_Y = FLOOR_TOP - (WELL.x1 + 0.3 - WELL.x0) * SLOPE

const inLane = (z: number) => Math.abs(z - UP_Z) < STEPS_W || Math.abs(z - DOWN_Z) < STEPS_W

/** Height of what is underfoot, in the hall's own coordinates: an escalator's slope, else the hall's floor. */
export function floorY(x: number, z: number): number {
  if (x < WELL.x0 || x > FOOT_X || !inLane(z)) return FLOOR_TOP
  return FLOOR_TOP - (x - WELL.x0) * SLOPE
}

export interface Stop {
  at: P
  /** Seconds to stand here. */
  wait: number
}

/** One passenger's whole round; the last stop leads back to the first. */
export function passengerLoop(i: number): Stop[] {
  const far = i % 2 === 1
  const gate = GATES[far ? 1 : 0]
  const look = i % 4 === 1 ? 17 : 21.4
  const browse: Stop[] = far ? [
    { at: [look, DEPART_Z], wait: 0 },
    { at: [look, SERVICE_Z], wait: 3 },
    { at: [look, DEPART_Z], wait: 0 },
  ] : []
  return [
    // up from below
    { at: [FOOT_X, UP_Z], wait: 2 },
    { at: [WELL.x0, UP_Z], wait: 0 },
    { at: [AISLE_UP_X, UP_Z], wait: 0 },
    { at: [AISLE_UP_X, DEPART_Z], wait: 0 },
    // departing: check-in, security, then out through a gate's door
    { at: [CHECK_IN[i % 3], SERVICE_Z], wait: 3 },
    { at: [3.6, DEPART_Z], wait: 1.5 },
    { at: [SECURITY_X + 1, DEPART_Z], wait: 0 },
    ...browse,
    { at: [gate - DOOR_LANE, DEPART_Z], wait: 0 },
    { at: [gate - DOOR_LANE, DOOR_Z], wait: 4 },
    // arriving: in through that door, customs, then back down
    { at: [gate + DOOR_LANE, DOOR_Z], wait: 0 },
    { at: [gate + DOOR_LANE, RETURN_Z], wait: 0 },
    { at: [SECURITY_X + 1, CUSTOMS_Z], wait: 0 },
    { at: [CUSTOMS_X, CUSTOMS_Z], wait: 2 },
    { at: [FOOT_X + 0.2, PAST_WELL_Z], wait: 0 },
    { at: [AISLE_DOWN_X, PAST_WELL_Z], wait: 0 },
    { at: [AISLE_DOWN_X, DOWN_Z], wait: 0 },
    { at: [WELL.x0, DOWN_Z], wait: 0 },
    { at: [FOOT_X, DOWN_Z], wait: 0 },
  ]
}

/** Out of sight: under the floor, or gone through a gate's door. */
export const outOfSight = (x: number, z: number) => floorY(x, z) < HIDDEN_Y || z > DOOR_Z - 0.01

export const PASSENGERS = 10
const SPEED = 1 // office units a second, as in People
/** Queueing: how far ahead someone looks, and how wide a person is. */
export const QUEUE_GAP = 1.1
const QUEUE_WIDTH = 0.5

export interface Passenger {
  stops: Stop[]
  next: number
  walker: Walker & { phase: number }
  wait: number
  /** How far they moved in the last step. */
  moved: number
}

/** Spread round their loops, so nobody starts on top of anybody else. */
export function newPassenger(i: number): Passenger {
  const stops = passengerLoop(i)
  const next = Math.floor((stops.length * i) / PASSENGERS)
  const [x, z] = stops[next].at
  return { stops, next, walker: { x, z, route: [], heading: 0, phase: 0 }, wait: hash(i, 22) * 2, moved: 0 }
}

/** The way someone is about to walk, or null when standing. */
function going(w: Walker): P | null {
  const to = w.route[0]
  if (!to) return null
  const [dx, dz] = [to[0] - w.x, to[1] - w.z]
  const d = Math.hypot(dx, dz)
  return d > 1e-6 ? [dx / d, dz / d] : null
}

/** Who `i` has to wait for: the nearest person just ahead. People meeting head-on pass each other. */
function blockerOf(people: Passenger[], i: number): number | null {
  const me = people[i].walker
  const dir = going(me)
  if (!dir || outOfSight(me.x, me.z)) return null
  let best: number | null = null
  let nearest = Infinity
  people.forEach((p, j) => {
    const o = p.walker
    if (j === i || outOfSight(o.x, o.z)) return
    const [dx, dz] = [o.x - me.x, o.z - me.z]
    const along = dx * dir[0] + dz * dir[1]
    // side by side: the later one gives way, or the two would walk as one
    if (along > QUEUE_GAP || along < (j < i ? -0.25 : 1e-6)) return
    if (Math.abs(dx * dir[1] - dz * dir[0]) > QUEUE_WIDTH) return
    const their = going(o)
    if (their && their[0] * dir[0] + their[1] * dir[1] < -0.5) return
    if (along < nearest) { nearest = along; best = j }
  })
  return best
}

/** Everyone takes a step, except those held up; in a ring of people waiting for each other, the first goes. */
export function stepPassengers(people: Passenger[], dt: number) {
  for (const p of people) {
    if (p.walker.route.length) continue
    p.wait -= dt
    if (p.wait <= 0) {
      p.next = (p.next + 1) % p.stops.length
      p.walker.route = [p.stops[p.next].at]
      p.wait = p.stops[p.next].wait
    }
  }
  const blocker = people.map((_, i) => blockerOf(people, i))
  people.forEach((p, i) => {
    let at = blocker[i]
    let lowest = i
    for (let n = 0; at !== null && at !== i && n < people.length; n++) {
      lowest = Math.min(lowest, at)
      at = blocker[at]
    }
    const free = blocker[i] === null || (at === i && lowest === i)
    p.moved = free ? advance(p.walker, SPEED * OFFICE_SCALE * dt) : 0
  })
}

function Seated({ look, seed, at, heading, floor = FLOOR_TOP }: { look: Look; seed: number; at: P; heading: number; floor?: number }) {
  const rig = useMemo(newRig, [])
  useLayoutEffect(() => {
    pose(rig, { x: at[0], z: at[1], route: [], heading, phase: 0 }, true, 0, floor, 1)
    if (rig.root) rig.root.rotation.y = heading
  }, [rig, at, heading, floor])
  return <Figure look={look} rig={rig} seed={seed} scale={OFFICE_SCALE} />
}

function Passengers() {
  const people = useMemo(() => Array.from({ length: PASSENGERS }, (_, i) => ({
    ...newPassenger(i), rig: newRig() as Rig, look: lookOf(i + 40),
  })), [])
  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, MAX_FRAME)
    if (!calm) inSteps(dt, (step) => stepPassengers(people, step))
    for (const p of people) {
      const w = p.walker
      const y = floorY(w.x, w.z)
      // riders stand still on the steps
      pose(p.rig, w, false, y < FLOOR_TOP ? 0 : p.moved / OFFICE_SCALE, y, dt)
      if (p.rig.root) p.rig.root.visible = !outOfSight(w.x, w.z)
    }
  })
  return <>{people.map((p, i) => <Figure key={i} look={p.look} rig={p.rig} seed={i * 11 + 5} scale={OFFICE_SCALE} />)}</>
}

/** A staff member's uniform over someone's own colouring. */
const uniform = (i: number): Look => ({ ...lookOf(i + 70), shirt: '#2f4f7a', pants: '#2c3444', extra: 'none' })

function Chair({ x, z, heading, c }: { x: number; z: number; heading: number; c: string }) {
  const back = heading === TO_GLASS ? -1 : 1
  return (
    <>
      <B p={[x, FLOOR_TOP + SEAT / 2, z]} s={[0.72, SEAT, 0.62]} c={c} />
      <B p={[x, FLOOR_TOP + 0.55, z + back * 0.3]} s={[0.72, 0.8, 0.12]} c={c} />
    </>
  )
}

function Plant({ x, z }: { x: number; z: number }) {
  return (
    <>
      <B p={[x, FLOOR_TOP + 0.25, z]} s={[0.5, 0.5, 0.5]} c="#b0643f" />
      <B p={[x, FLOOR_TOP + 0.85, z]} s={[0.7, 0.8, 0.7]} c="#4f9a58" />
    </>
  )
}

function Suitcase({ x, z, c }: { x: number; z: number; c: string }) {
  return (
    <>
      <B p={[x, FLOOR_TOP + 0.3, z]} s={[0.36, 0.56, 0.2]} c={c} />
      <B p={[x, FLOOR_TOP + 0.68, z]} s={[0.18, 0.2, 0.04]} c="#3a3f4a" shadow={false} />
    </>
  )
}

/** Dark panel on the back wall with rows of little amber and green flights. */
function Board({ x, w }: { x: number; w: number }) {
  const z = TERMINAL.z0 + WALL + 0.05
  return (
    <>
      <B p={[x, 3, z]} s={[w, 1.3, 0.1]} c="#23283a" shadow={false} />
      {[0, 1, 2, 3].map((row) => Array.from({ length: 5 }, (_, col) => (
        <B key={`${row}-${col}`} p={[x - w / 2 + 0.55 + (col * (w - 1.1)) / 4, 3.42 - row * 0.28, z + 0.06]}
          s={[(w - 1.1) / 5, 0.1, 0.02]} c={col === 4 ? (hash(row, 3) < 0.6 ? '#7fe08a' : '#ff8a5c') : '#ffd27a'} shadow={false} />
      )))}
    </>
  )
}

function SecurityCheck({ detail }: { detail: boolean }) {
  const x = SECURITY_X
  const wall = TERMINAL.z0 + WALL
  const front = TERMINAL.z1 - WALL
  const customsBack = CUSTOMS_Z - CUSTOMS_HALF
  const customsFront = CUSTOMS_Z + CUSTOMS_HALF
  return (
    <>
      {/* the whole width is closed: glass from the back wall to the arch, on to customs, and on to the front */}
      <Clear p={[x, 1.2, (wall + ARCH_Z - ARCH_HALF) / 2]} s={[0.1, 2.4, ARCH_Z - ARCH_HALF - wall]} c={BLUE} />
      <Clear p={[x, 1.2, (ARCH_Z + ARCH_HALF + customsBack) / 2]} s={[0.1, 2.4, customsBack - ARCH_Z - ARCH_HALF]} c={BLUE} />
      <Clear p={[x, 1.2, (customsFront + front) / 2]} s={[0.1, 2.4, front - customsFront]} c={BLUE} />
      {[ARCH_Z + ARCH_HALF, customsBack, customsFront].map((z) => <B key={z} p={[x, 1.2, z]} s={[0.2, 2.4, 0.2]} c="#56637e" />)}
      {/* a solid lower wall and top rail, so the closed stretches read as closed through the glass */}
      {([[wall, ARCH_Z - ARCH_HALF], [ARCH_Z + ARCH_HALF, customsBack], [customsFront, front]] as const).map(([a, b]) => (
        <group key={a}>
          <B p={[x, FLOOR_TOP + 0.55, (a + b) / 2]} s={[0.16, 1.1, b - a]} c="#8d97a8" />
          <B p={[x, 2.42, (a + b) / 2]} s={[0.16, 0.1, b - a]} c="#56637e" />
        </group>
      ))}
      {/* customs, for arrivals: a green frame over the lane, and an officer at a booth beside it */}
      <B p={[x, 2.5, CUSTOMS_Z]} s={[0.2, 0.2, CUSTOMS_HALF * 2 + 0.2]} c="#3f8a5a" />
      <B p={[CUSTOMS_X, FLOOR_TOP + 0.5, CUSTOMS_Z + 1]} s={[1.5, 1, 0.4]} c="#c9ced8" />
      <B p={[CUSTOMS_X, FLOOR_TOP + 1.03, CUSTOMS_Z + 1]} s={[1.6, 0.06, 0.5]} c="#3f8a5a" />
      <Chair x={CUSTOMS_X} z={CUSTOMS_Z + 1.65} heading={TO_GLASS} c="#2f3a4a" />
      <Seated look={uniform(12)} seed={215} at={[CUSTOMS_X, CUSTOMS_Z + 1.65]} heading={TO_GLASS} />
      {/* walk-through arch */}
      {[-0.55, 0.55].map((dz) => <B key={dz} p={[x, 1.1, ARCH_Z + dz]} s={[0.2, 2.2, 0.14]} c="#c9ced8" />)}
      <B p={[x, 2.25, ARCH_Z]} s={[0.24, 0.24, 1.3]} c="#c9ced8" />
      <B p={[x, 2.4, ARCH_Z]} s={[0.1, 0.06, 0.3]} c="#7fe08a" shadow={false} />
      {/* X-ray machine and its belt */}
      <B p={[3.5, FLOOR_TOP + 0.35, -16.7]} s={[2.8, 0.7, 0.62]} c="#3a3f4a" />
      <B p={[3.5, FLOOR_TOP + 0.72, -16.7]} s={[1.1, 0.95, 0.72]} c="#c9ced8" />
      {detail && <B p={[2.5, FLOOR_TOP + 0.8, -16.7]} s={[0.4, 0.2, 0.3]} c="#c8643f" />}
      <Chair x={4.3} z={-17.8} heading={TO_GLASS} c="#2f3a4a" />
      <Seated look={uniform(3)} seed={210} at={[4.3, -17.8]} heading={TO_GLASS} />
    </>
  )
}

const SHOP_Z = (TERMINAL.z0 + WALL + WELL.z0) / 2
const SHOP_D = WELL.z0 - TERMINAL.z0 - WALL

function Shop({ detail }: { detail: boolean }) {
  const { x0, x1 } = SHOP
  const cx = (x0 + x1) / 2
  const w = x1 - x0
  const COLOURS = ['#e85d4a', '#f2c14e', '#4fae6a', '#8a5cc8', '#3f7fd0', '#ef8fb0']
  return (
    <>
      <B p={[cx, FLOOR_TOP + 0.005, SHOP_Z]} s={[w, 0.01, SHOP_D]} c="#f4e4c8" shadow={false} />
      <B p={[cx, 3.3, TERMINAL.z0 + WALL + 0.12]} s={[w, 0.5, 0.24]} c="#c8643f" />
      {/* shelves along the back wall, full of goods */}
      <B p={[cx, 1.1, -18.9]} s={[w - 0.4, 2.2, 0.36]} c="#8a5f3c" />
      {detail && [0.55, 1.15, 1.75].map((y) => Array.from({ length: 7 }, (_, i) => (
        <B key={`${y}-${i}`} p={[x0 + 0.55 + i * ((w - 1.1) / 6), y, -18.68]} s={[0.36, 0.38, 0.1]} c={COLOURS[Math.floor(hash(i, y * 100) * COLOURS.length)]} shadow={false} />
      )))}
      {/* a display table and the till, a shop assistant behind it */}
      <B p={[x0 + 2.9, FLOOR_TOP + 0.42, -17.1]} s={[1.5, 0.84, 0.9]} c="#d9b78a" />
      {detail && [-0.45, 0, 0.45].map((dx, i) => <B key={dx} p={[x0 + 2.9 + dx, FLOOR_TOP + 1, -17.1]} s={[0.32, 0.3, 0.32]} c={COLOURS[i]} />)}
      <Chair x={x1 - 0.7} z={-18.3} heading={TO_GLASS} c="#2f3a4a" />
      <Seated look={uniform(4)} seed={220} at={[x1 - 0.7, -18.3]} heading={TO_GLASS} />
    </>
  )
}

function Cafe({ detail }: { detail: boolean }) {
  const { x0, x1 } = CAFE
  const cx = (x0 + x1) / 2
  const w = x1 - x0
  return (
    <>
      <B p={[cx, FLOOR_TOP + 0.005, SHOP_Z]} s={[w, 0.01, SHOP_D]} c="#c9a27a" shadow={false} />
      <B p={[cx, 3.3, TERMINAL.z0 + WALL + 0.12]} s={[w, 0.5, 0.24]} c="#3f8a5a" />
      <B p={[cx, FLOOR_TOP + 0.5, DESK_Z]} s={[w - 0.4, 1, 0.6]} c="#6b4a33" />
      <B p={[cx, FLOOR_TOP + 1.04, DESK_Z]} s={[w - 0.2, 0.08, 0.72]} c="#e8e2d6" />
      {detail && <B p={[x0 + 0.8, FLOOR_TOP + 1.3, DESK_Z]} s={[0.5, 0.46, 0.4]} c="#c9ced8" />}
      {detail && [x0 + 1.6, x0 + 2.0].map((x) => <B key={x} p={[x, FLOOR_TOP + 1.14, DESK_Z + 0.1]} s={[0.14, 0.14, 0.14]} c="#f5f5f0" shadow={false} />)}
      {[x0 + 2.4, x0 + 3.5].map((x) => (
        <group key={x}>
          <B p={[x, FLOOR_TOP + 0.33, -16.7]} s={[0.1, 0.66, 0.1]} c="#3a3f4a" />
          <B p={[x, FLOOR_TOP + 0.7, -16.7]} s={[0.8, 0.06, 0.8]} c="#f4f4f0" />
        </group>
      ))}
      <Chair x={cx + 0.8} z={STAFF_Z} heading={TO_GLASS} c="#6b4a33" />
      <Seated look={uniform(5)} seed={230} at={[cx + 0.8, STAFF_Z]} heading={TO_GLASS} />
    </>
  )
}

const STEP_GAP = 0.42

/** One escalator: a dark trough with moving steps and rails, sloping from the head down under the floor. */
function Escalator({ z, up }: { z: number; up: boolean }) {
  const steps = useRef<Array<THREE.Group | null>>([])
  const run = FOOT_X - WELL.x0
  const count = Math.round(run / STEP_GAP)
  const length = run * Math.hypot(1, SLOPE)
  const angle = Math.atan(SLOPE)
  const mid = (WELL.x0 + FOOT_X) / 2
  const midY = FLOOR_TOP - (run * SLOPE) / 2
  const place = (i: number, shift: number) => {
    const k = (((i / count + shift) % 1) + 1) % 1
    return [WELL.x0 + k * run, FLOOR_TOP - k * run * SLOPE] as const
  }
  useFrame(({ clock }) => {
    if (calm) return
    const shift = ((clock.elapsedTime * SPEED * OFFICE_SCALE) / run) * (up ? -1 : 1)
    steps.current.forEach((g, i) => {
      if (!g) return
      const [x, y] = place(i, shift)
      g.position.set(x, y, z)
    })
  })
  return (
    <>
      <mesh position={[mid, midY - 0.2, z]} rotation={[0, 0, -angle]} scale={[length, 0.4, STEPS_W + 0.1]} material={toon('#333845')} castShadow receiveShadow>
        <boxGeometry />
      </mesh>
      {Array.from({ length: count }, (_, i) => (
        <group key={i} ref={(g) => void (steps.current[i] = g)} position={[place(i, 0)[0], place(i, 0)[1], z]}>
          {/* a real stair: tread, riser and a yellow edge */}
          <B p={[0, -0.02, 0]} s={[STEP_GAP, 0.04, STEPS_W - 0.06]} c="#8b92a1" />
          <B p={[STEP_GAP / 2 - 0.02, -0.1, 0]} s={[0.04, STEP_GAP * SLOPE, STEPS_W - 0.06]} c="#565c6b" shadow={false} />
          <B p={[-STEP_GAP / 2 + 0.03, 0.002, 0]} s={[0.05, 0.01, STEPS_W - 0.06]} c="#f2c14e" shadow={false} />
        </group>
      ))}
      {[-1, 1].map((side) => (
        <group key={side}>
          <mesh position={[mid, midY + 0.42, z + side * (STEPS_W / 2 + 0.05)]} rotation={[0, 0, -angle]} scale={[length, 0.84, 0.1]} material={toon('#eef1f5')} castShadow>
            <boxGeometry />
          </mesh>
          <mesh position={[mid, midY + 0.88, z + side * (STEPS_W / 2 + 0.05)]} rotation={[0, 0, -angle]} scale={[length, 0.09, 0.14]} material={toon('#23262f')}>
            <boxGeometry />
          </mesh>
        </group>
      ))}
    </>
  )
}

/** The hall's floor on its solid base, leaving the opening, whose far walls and bottom are in shadow colours. */
function HallFloor() {
  const { x0, x1, z0, z1 } = TERMINAL
  const well = WELL
  const h = FLOOR_TOP + HALL_LIFT
  const y = FLOOR_TOP - h / 2
  const block = (a: number, b: number, c: number, e: number) => (
    <B key={`${a},${c}`} p={[(a + b) / 2, y, (c + e) / 2]} s={[b - a, h, e - c]} c="#e6e8ec" />
  )
  const [w, d] = [well.x1 - well.x0, well.z1 - well.z0]
  const [cx, cz] = [(well.x0 + well.x1) / 2, (well.z0 + well.z1) / 2]
  return (
    <>
      {block(x0, x1, z0, well.z0)}
      {block(x0, x1, well.z1, z1)}
      {block(x0, well.x0, well.z0, well.z1)}
      {block(well.x1, x1, well.z0, well.z1)}
      {/* inside the opening */}
      <B p={[cx, -HALL_LIFT + 0.02, cz]} s={[w, 0.04, d]} c="#1b1d25" shadow={false} />
      <B p={[cx, y, well.z0 + 0.02]} s={[w, h - 0.02, 0.04]} c="#4a505f" shadow={false} />
      <B p={[well.x0 + 0.02, y, cz]} s={[0.04, h - 0.02, d]} c="#3c414e" shadow={false} />
      {/* a curb and glass along the sides, open at the head */}
      {[well.z0, well.z1].map((z) => (
        <group key={z}>
          <B p={[cx, FLOOR_TOP + 0.08, z]} s={[w, 0.16, 0.12]} c="#c9ced8" />
          <Clear p={[cx, FLOOR_TOP + 0.6, z]} s={[w, 1, 0.05]} c="#5b8ab4" />
        </group>
      ))}
      <B p={[well.x1, FLOOR_TOP + 0.08, cz]} s={[0.12, 0.16, d]} c="#c9ced8" />
      <Clear p={[well.x1, FLOOR_TOP + 0.6, cz]} s={[0.05, 1, d]} c="#5b8ab4" />
      <Escalator z={UP_Z} up />
      <Escalator z={DOWN_Z} up={false} />
    </>
  )
}

function Terminal({ crowd, detail }: { crowd: boolean; detail: boolean }) {
  const { x0, x1, z0, z1 } = TERMINAL
  const w = x1 - x0
  const d = z1 - z0
  const cx = (x0 + x1) / 2
  const cz = (z0 + z1) / 2
  const chairs = [7.4, 8.4, 9.4, 10.4, 11.4, 26, 27, 28, 29, 30, 33.8, 34.8]
  return (
    <>
      <HallFloor />
      {/* back and west walls, with a band of the airport colour */}
      <B p={[cx, CUT / 2, z0 + WALL / 2]} s={[w, CUT, WALL]} c={PAINT} />
      <B p={[x0 + WALL / 2, CUT / 2, cz]} s={[WALL, CUT, d]} c={PAINT} />
      <B p={[cx, CUT + 0.06, z0 + WALL / 2]} s={[w, 0.12, WALL + 0.04]} c={BLUE} shadow={false} />
      <B p={[x0 + WALL / 2, CUT + 0.06, cz]} s={[WALL + 0.04, 0.12, d]} c={BLUE} shadow={false} />
      <>
        {/* carpet under each gate's seats, the way back marked on the floor */}
        {[[6.4, 15.4], [25.4, 35.6]].map(([a, b]) => <B key={a} p={[(a + b) / 2, FLOOR_TOP + 0.005, -17.4]} s={[b - a, 0.01, 3.8]} c="#8ea9c9" shadow={false} />)}
        <B p={[(SECURITY_X + x1) / 2, FLOOR_TOP + 0.006, RETURN_Z - 0.6]} s={[x1 - SECURITY_X - 0.4, 0.01, 0.08]} c="#e5b33a" shadow={false} />
        <B p={[cx, FLOOR_TOP + 0.06, z0 + WALL + 0.02]} s={[w - WALL * 2, 0.12, 0.04]} c="#56637e" shadow={false} />
        {/* the two walls facing the camera, glass towards the apron */}
        <Clear p={[cx, CUT / 2, z1 - WALL / 2]} s={[w, CUT, WALL]} c="#5b8ab4" />
        <Clear p={[x1 - WALL / 2, CUT / 2, cz]} s={[WALL, CUT, d - WALL * 2]} c="#5b8ab4" />

        {/* check-in: three desks, a staff member behind each, a departures board above */}
        {CHECK_IN.map((x, i) => (
          <group key={x}>
            <B p={[x, FLOOR_TOP + 0.5, DESK_Z]} s={[1.5, 1, 0.5]} c="#c9ced8" />
            <B p={[x, FLOOR_TOP + 1.03, DESK_Z]} s={[1.6, 0.06, 0.6]} c={BLUE} />
            <Chair x={x} z={STAFF_Z} heading={TO_GLASS} c="#2f3a4a" />
            <Seated look={uniform(i)} seed={i + 200} at={[x, STAFF_Z]} heading={TO_GLASS} />
          </group>
        ))}
        <Board x={-3.5} w={7} />
        <SecurityCheck detail={detail} />
        <Shop detail={detail} />
        <Cafe detail={detail} />

        {/* a gate desk and a row of seats at each jet bridge */}
        {GATES.map((x, i) => (
          <group key={x}>
            <B p={[x, FLOOR_TOP + 0.5, DESK_Z]} s={[1.5, 1, 0.5]} c="#c9ced8" />
            <B p={[x, FLOOR_TOP + 1.03, DESK_Z]} s={[1.6, 0.06, 0.6]} c={BLUE} />
            <Board x={x} w={2.4} />
            <Chair x={x} z={STAFF_Z} heading={TO_GLASS} c="#2f3a4a" />
            <Seated look={uniform(6 + i)} seed={240 + i} at={[x, STAFF_Z]} heading={TO_GLASS} />
            {/* the door out to the bridge */}
            <B p={[x, 1.2, z1 - 0.28]} s={[1.2, 2.4, 0.08]} c="#3d4a5c" shadow={false} />
          </group>
        ))}
        {chairs.map((x) => <Chair key={x} x={x} z={SEATS_Z} heading={TO_GLASS} c="#56637e" />)}
        {crowd && chairs.filter((_, i) => hash(i, 31) < 0.6).map((x, i) => (
          <Seated key={x} look={lookOf(i + 20)} seed={i + 300} at={[x, SEATS_Z - 0.03]} heading={TO_GLASS} />
        ))}
        {detail && (
          <>
            <Suitcase x={10.9} z={-16.5} c="#c8643f" />
            <Suitcase x={27.5} z={-16.5} c="#3f8a5a" />
            <Suitcase x={34.3} z={-16.5} c="#8a5cc8" />
            {[-7.3, 15.7, 25, 35.3].map((x) => <Plant key={x} x={x} z={-18.9} />)}
          </>
        )}
      </>
      {crowd && <Passengers />}
    </>
  )
}

/** The glass cab at the top of the tower, in the tower's own coordinates: two controllers at a console. */
function TowerCab() {
  const floor = TOWER.h + 0.2
  const lift = floor - FLOOR_TOP
  return (
    <group position={[TOWER.x, 0, TOWER.z]}>
      <B p={[0, floor - 0.05, 0]} s={[2.9, 0.1, 2.9]} c="#6b7486" />
      <group position={[0, lift, 0]}>
        <B p={[0, FLOOR_TOP + 0.4, 0.95]} s={[2.5, 0.8, 0.5]} c="#3a3f4a" />
        {[-0.6, 0.6].map((x) => <B key={x} p={[x, FLOOR_TOP + 0.9, 0.95]} s={[0.5, 0.3, 0.1]} c="#7fe08a" shadow={false} />)}
        {[-0.6, 0.6].map((x) => <Chair key={x} x={x} z={0} heading={TO_GLASS} c="#2f3a4a" />)}
      </group>
      {[-0.6, 0.6].map((x, i) => <Seated key={x} look={uniform(10 + i)} seed={250 + i} at={[x, 0]} heading={TO_GLASS} floor={floor} />)}
      {/* glass all round, low enough to see in */}
      <Clear p={[0, floor + 0.7, -1.4]} s={[2.9, 1.4, 0.1]} c="#5b8ab4" />
      <Clear p={[-1.4, floor + 0.7, 0]} s={[0.1, 1.4, 2.7]} c="#5b8ab4" />
      <Clear p={[0, floor + 0.7, 1.4]} s={[2.9, 1.4, 0.1]} c="#5b8ab4" />
      <Clear p={[1.4, floor + 0.7, 0]} s={[0.1, 1.4, 2.7]} c="#5b8ab4" />
    </group>
  )
}

export function AirportInterior() {
  const crowd = usePrefs((s) => s.crowd)
  const detail = usePrefs((s) => s.detail)
  return (
    <>
      <group position={[0, HALL_LIFT, 0]}><Terminal crowd={crowd} detail={detail} /></group>
      <TowerCab />
    </>
  )
}
