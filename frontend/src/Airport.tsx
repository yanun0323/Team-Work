// The airport: a fixed field behind the town (layout.ts `AIRPORT`). A terminal and a control tower along the
// far side, an apron (停機坪) in front of them with a parked plane being serviced by ground vehicles, a row of
// parked equipment, and a helipad beside it, two taxiways down
// to a runway along x on the town side. A plane keeps landing, taxiing to its stand, waiting, and taking off
// again. Clicking anywhere on it opens the settings; while they are open the terminal and the tower's cab are
// shown from inside (AirportInterior.tsx).

import { useFrame, type ThreeEvent } from '@react-three/fiber'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { AirportInterior } from './AirportInterior'
import { Fade } from './Fade'
import { AIRPORT, CELL, rectCenter, RUNWAY_CELLS, RUNWAY_LINE, BRIDGE_DX, HALL_LIFT, STAND_Z, STANDS, TERMINAL, TOWER, type Town } from './layout'
import { MAX_FRAME, NO_OUTLINE_LAYER } from './PixelPass'
import { usePrefs } from './prefs'
import { playSound, stopSound } from './sound'
import { toon, toonGlow } from './toon'

type V3 = [number, number, number]

/** `glow`: lit from inside after dark, in that colour. */
function B({ p, s, c, r, shadow = true, glow }: { p: V3; s: V3; c: string; r?: V3; shadow?: boolean; glow?: string }) {
  return (
    <mesh position={p} rotation={r} scale={s} material={glow ? toonGlow(c, glow) : toon(c)} castShadow={shadow} receiveShadow>
      <boxGeometry />
    </mesh>
  )
}

// Everything below is in world units about the airport's middle; -z is the far side, +z faces the town.
const HALF_W = 20 * CELL
/** Top of the paving, as on the plots. */
const PAVE = 0.08
const ASPHALT = '#4a4f5c'
const TAXI = '#585d6a'
const CONCRETE = '#c4c0cc'
const MARK = '#f2f0e8'
const YELLOW = '#e5b33a'
/** The terminal's glass front and the tower's cab, lit from inside after dark. */
const LIT_GLASS = '#f2cf86'

/** Runway: along x on the town side, three cells wide. */
const RUNWAY_Z = (RUNWAY_LINE - AIRPORT.d / 2) * CELL
const RUNWAY_W = RUNWAY_CELLS * CELL
const RUNWAY_HALF = HALF_W - 3
/** Taxiways from the apron down to the runway. */
const TAXI_X = [-6, 14]
const TAXI_W = 1.5 * CELL
/** Apron, in front of the terminal. */
const APRON = { x0: -10, x1: TERMINAL.x1, z0: TERMINAL.z1, z1: 1.5 }
/** Where planes cross the apron, clear of the parked one's nose. */
const LANE_Z = 0
const HELIPAD = { x: -28, z: -8, r: 3.4 }

/**
 * Swept wing in three steps, root to tip, each `[x of its middle, chord, z from, z to]`; the span stays 8.4
 * (±4.2). The engines hang under the middle step.
 */
const WING: Array<[number, number, number, number]> = [[0.15, 1.7, 0, 1.45], [-0.15, 1.3, 1.45, 2.9], [-0.5, 0.9, 2.9, 4.2]]
const BELLY = '#c9ced8'
/** Doors, `[x, y, height, width]` on both sides: the front ones by the jet bridge and the catering truck, the rear ones for passengers; and the rear hold, on the -z side, for the belt loader. */
const DOORS: Array<[number, number, number, number]> = [[2.9, 1.3, 0.78, 0.42], [-2.6, 1.3, 0.78, 0.42]]
/** Cabin windows, one by one between the doors, about as far apart as they are wide. */
const WINDOWS = Array.from({ length: 15 }, (_, i) => -2.25 + i * (4.8 / 14))

/**
 * A short airliner, nose along +x, wheels on y = 0: about four cells long. White over a grey belly with a
 * stripe in the airline's colour, the wing swept back with winglets. Jet bridge and ground vehicles are
 * placed against its size, doors and wings, so keep its length, span and door heights.
 * `gear` false: wheels up, for a plane cruising past.
 */
export function Plane({ body, tail, gear = true }: { body: string; tail: string; gear?: boolean }) {
  // less detail: no doors or navigation lights
  const detail = usePrefs((s) => s.detail)
  return (
    <>
      {/* fuselage: two crossed boxes for a rounder section, the nose and tail cone tapering in steps */}
      <B p={[0, 1.25, 0]} s={[6.4, 1.1, 0.9]} c={body} />
      <B p={[0, 1.25, 0]} s={[6.4, 0.9, 1.1]} c={body} />
      <B p={[3.5, 1.22, 0]} s={[0.6, 0.95, 0.95]} c={body} />
      <B p={[3.975, 1.15, 0]} s={[0.35, 0.72, 0.75]} c={body} />
      <B p={[4.25, 1.08, 0]} s={[0.2, 0.42, 0.45]} c={body} />
      <B p={[-3.5, 1.35, 0]} s={[0.6, 0.9, 0.9]} c={body} />
      <B p={[-4.05, 1.5, 0]} s={[0.5, 0.6, 0.6]} c={body} />
      {/* grey belly under a stripe in the airline's colour */}
      <B p={[0.1, 0.86, 0]} s={[6.2, 0.12, 1.12]} c={BELLY} shadow={false} />
      <B p={[0.1, 0.69, 0]} s={[6.2, 0.02, 0.88]} c={BELLY} shadow={false} />
      <B p={[0.3, 1.0, 0]} s={[6.2, 0.16, 1.12]} c={tail} shadow={false} />
      {/* cockpit windows and the cabin's windows; with less detail, a single window line */}
      <B p={[3.95, 1.445, 0]} s={[0.3, 0.17, 0.78]} c="#2c3f52" shadow={false} />
      {detail
        ? WINDOWS.map((x) => <B key={x} p={[x, 1.45, 0]} s={[0.18, 0.16, 1.12]} c="#3b5670" shadow={false} />)
        : <B p={[0.15, 1.45, 0]} s={[5.3, 0.14, 1.12]} c="#3b5670" shadow={false} />}
      {detail && DOORS.map(([x, y, h, w]) => <B key={x} p={[x, y, 0]} s={[w, h, 1.14]} c={BELLY} shadow={false} />)}
      {detail && <B p={[-2.4, 0.92, -0.2]} s={[0.6, 0.36, 0.74]} c="#aeb5c2" shadow={false} />}
      {/* wings: three swept steps a side, a flap strip along each trailing edge and a winglet in the airline's colour */}
      <B p={[WING[0][0], 0.95, 0]} s={[WING[0][1], 0.14, WING[0][3] * 2]} c={body} />
      {[-1, 1].map((side) => (
        <group key={side}>
          {WING.slice(1).map(([x, chord, z0, z1]) => (
            <B key={x} p={[x, 0.95, side * (z0 + z1) / 2]} s={[chord, 0.14, z1 - z0]} c={body} />
          ))}
          {WING.map(([x, chord, z0, z1]) => {
            // clear of the fuselage at the root, short of each step's ends
            const from = Math.max(z0, 0.55) + 0.02
            const to = z1 - 0.02
            return <B key={x} p={[x - chord / 2 + 0.11, 0.98, side * (from + to) / 2]} s={[0.24, 0.1, to - from]} c={BELLY} shadow={false} />
          })}
          <B p={[-0.7, 1.24, side * 4.16]} s={[0.45, 0.5, 0.1]} c={tail} />
          {/* navigation lights: red on the left wingtip, green on the right, lit after dark */}
          {detail && <B p={[-0.05, 0.98, side * 4.08]} s={[0.18, 0.16, 0.18]} c={side < 0 ? '#d84a3a' : '#4caf6a'} glow={side < 0 ? '#ff6a55' : '#6fe08f'} shadow={false} />}
          {/* engine: nacelle on a pylon, a wider intake lip with a dark fan, an exhaust cone behind */}
          <group position={[0, 0, side * 1.9]}>
            <B p={[0.25, 0.85, 0]} s={[0.5, 0.2, 0.12]} c={BELLY} />
            <B p={[0.5, 0.6, 0]} s={[1.2, 0.55, 0.55]} c={BELLY} />
            <B p={[1.1, 0.6, 0]} s={[0.3, 0.64, 0.64]} c="#dfe3ea" />
            <B p={[1.255, 0.6, 0]} s={[0.02, 0.46, 0.46]} c="#3a3f4a" shadow={false} />
            <B p={[-0.2, 0.6, 0]} s={[0.2, 0.34, 0.34]} c="#6b7280" />
          </group>
        </group>
      ))}
      {/* tail fin, swept in two steps, and the stabilisers */}
      <B p={[-3.45, 2.1, 0]} s={[1.3, 0.8, 0.14]} c={tail} />
      <B p={[-3.75, 2.9, 0]} s={[0.9, 0.8, 0.14]} c={tail} />
      <B p={[-3.85, 1.6, 0]} s={[0.9, 0.12, 1.6]} c={body} />
      {[-1, 1].map((side) => <B key={side} p={[-4.05, 1.6, side * 1.2]} s={[0.6, 0.12, 0.8]} c={body} />)}
      {/* landing gear: a nose leg on twin wheels, a main leg with twin wheels under each wing root */}
      {gear && <>
        <B p={[2.8, 0.45, 0]} s={[0.12, 0.5, 0.12]} c="#3a3f4a" />
        {[-1, 1].map((side) => <B key={side} p={[2.8, 0.15, side * 0.12]} s={[0.3, 0.3, 0.12]} c="#2a2e36" />)}
        {[-1, 1].map((side) => (
          <group key={side} position={[-0.4, 0, side * 0.7]}>
            <B p={[0, 0.5, 0]} s={[0.12, 0.4, 0.12]} c="#3a3f4a" />
            {[-1, 1].map((w) => <B key={w} p={[0, 0.2, w * 0.13]} s={[0.4, 0.4, 0.14]} c="#2a2e36" />)}
          </group>
        ))}
      </>}
    </>
  )
}

interface Key {
  /** Seconds into the cycle. */
  t: number
  p: V3
  /** Heading: rotation about y, 0 nose along +x; unwrapped, so turns go the short way. */
  h: number
  /** Nose up, radians. */
  pitch?: number
}

const PI = Math.PI
const R = RUNWAY_Z
const [WEST, EAST] = TAXI_X
const STAND = STANDS[0]
/**
 * One landing and one take-off, both eastbound: in over the sea, roll out and turn off up the east taxiway,
 * across the apron to the stand facing the terminal, wait, push back, taxi down the west taxiway, line up
 * and go, climbing away over the sea at the other end.
 */
const FLIGHT: Key[] = [
  { t: 0, p: [-130, 34, R], h: 0, pitch: 0.06 },
  { t: 10, p: [-30, 0, R], h: 0, pitch: 0.12 },
  { t: 11, p: [-20, 0, R], h: 0, pitch: 0 },
  { t: 13, p: [-3, 0, R], h: 0 },
  { t: 15, p: [9, 0, R], h: 0 },
  { t: 16.5, p: [EAST - 1, 0, R - 1], h: 0.8 },
  { t: 17.5, p: [EAST, 0, R - 3], h: PI / 2 },
  { t: 21, p: [EAST, 0, LANE_Z + 2.5], h: PI / 2 },
  { t: 23, p: [EAST - 1, 0, LANE_Z + 0.5], h: PI * 0.8 },
  { t: 25, p: [STAND + 0.5, 0, LANE_Z - 1], h: PI * 0.6 },
  { t: 28, p: [STAND, 0, STAND_Z], h: PI / 2 },
  // at the stand
  { t: 40, p: [STAND, 0, STAND_Z], h: PI / 2 },
  // pushed back, the nose swinging round to the west
  { t: 45, p: [STAND + 0.5, 0, LANE_Z], h: PI },
  { t: 47, p: [STAND + 0.5, 0, LANE_Z], h: PI },
  { t: 50, p: [WEST + 2, 0, LANE_Z], h: PI },
  { t: 51.5, p: [WEST, 0, LANE_Z + 2], h: PI * 1.5 },
  { t: 55.5, p: [WEST, 0, R - 3], h: PI * 1.5 },
  { t: 56.5, p: [WEST + 1, 0, R - 1], h: PI * 1.8 },
  { t: 57.5, p: [WEST + 3, 0, R], h: PI * 2 },
  // lined up, then the take-off roll
  { t: 60, p: [WEST + 3, 0, R], h: PI * 2 },
  { t: 62, p: [WEST + 7, 0, R], h: PI * 2 },
  { t: 64, p: [WEST + 19, 0, R], h: PI * 2 },
  { t: 65.6, p: [30, 0, R], h: PI * 2, pitch: 0.16 },
  { t: 67, p: [44, 6, R], h: PI * 2, pitch: 0.24 },
  { t: 74, p: [130, 40, R], h: PI * 2, pitch: 0.2 },
]
/** Seconds from one arrival to the next: the flight takes 74, then the sky stays empty a while. */
const CYCLE = 240
/** A moment while it stands at its stand. */
const STAND_AT = 30
/** Shown from the first key until it is well away over the sea. */
const SHOWN = [0, 73] as const

function poseAt(t: number, out: THREE.Object3D) {
  let i = FLIGHT.findIndex((k) => k.t > t)
  if (i < 0) i = FLIGHT.length - 1
  if (i === 0) i = 1
  const a = FLIGHT[i - 1]
  const b = FLIGHT[i]
  const k = THREE.MathUtils.clamp((t - a.t) / (b.t - a.t), 0, 1)
  out.position.set(...(a.p.map((v, j) => v + (b.p[j] - v) * k) as V3))
  out.rotation.set(0, a.h + (b.h - a.h) * k, (a.pitch ?? 0) + ((b.pitch ?? 0) - (a.pitch ?? 0)) * k, 'YZX')
}

/** The plane that comes and goes; it fades in far out to sea and fades out again. */
function Flight({ calm }: { calm: boolean }) {
  const ref = useRef<THREE.Group>(null)
  // with reduced motion, or the planes turned off, it simply stands at its stand; turned off mid-flight,
  // it goes straight there
  const clock = useRef(calm ? STAND_AT : 0)
  const [shown, setShown] = useState(true)
  useEffect(() => {
    if (calm) { stopSound('soundLanding'); stopSound('soundTakeoff') }
    return () => { stopSound('soundLanding'); stopSound('soundTakeoff') }
  }, [calm])
  useLayoutEffect(() => {
    if (calm) {
      clock.current = STAND_AT
      setShown(true)
    }
    if (ref.current) poseAt(clock.current, ref.current)
  }, [calm])
  useFrame((_, dt) => {
    if (calm || !ref.current) return
    const before = clock.current
    clock.current = (clock.current + Math.min(dt, MAX_FRAME)) % CYCLE
    const t = clock.current
    if (before < 3 && t >= 3) playSound('soundLanding')
    if (before < 60 && t >= 60) playSound('soundTakeoff')
    poseAt(t, ref.current)
    const on = t >= SHOWN[0] && t < SHOWN[1]
    if (on !== shown) setShown(on)
  })
  return (
    <group ref={ref}>
      <Fade show={shown}><Plane body="#f4f4f0" tail="#3b6fb0" /></Fade>
    </group>
  )
}

/** The windsock's sock, hung from the pole's top: it swings about the pole and droops a little in gusts, its white tip flapping faster. Still under reduced motion, but not with the planes off. */
const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
function Windsock() {
  const calm = reducedMotion
  const sock = useRef<THREE.Group>(null)
  const tip = useRef<THREE.Group>(null)
  useFrame(({ clock }) => {
    if (!sock.current || !tip.current) return
    const t = calm ? 0 : clock.elapsedTime
    sock.current.rotation.set(0, 0.18 * Math.sin(t * 0.7) + 0.05 * Math.sin(t * 2.3), -0.05 + 0.05 * Math.sin(t * 1.3))
    tip.current.rotation.set(0, 0.2 * Math.sin(t * 3.1 + 1), 0.08 * Math.sin(t * 2.6))
  })
  return (
    <group ref={sock} position={[0, 2.8, 0]}>
      <B p={[0.55, 0, 0]} s={[0.9, 0.42, 0.42]} c="#ff8a3c" />
      <group ref={tip} position={[1, -0.02, 0]}>
        <B p={[0.25, 0, 0]} s={[0.5, 0.32, 0.32]} c="#f4f4f0" />
      </group>
    </group>
  )
}

/** A see-through grey layer over the whole airport while the pointer is on it: buildings, runway, taxiways, apron and helipad. */
function Shade({ on }: { on: boolean }) {
  const mat = useMemo(() => new THREE.MeshBasicMaterial({ color: '#1c1f2e', transparent: true, opacity: 0, depthWrite: false }), [])
  const refs = useRef<Array<THREE.Mesh | null>>([])
  useEffect(() => () => mat.dispose(), [mat])
  useLayoutEffect(() => refs.current.forEach((m) => m?.layers.set(NO_OUTLINE_LAYER)), [])
  useFrame((_, dt) => {
    const to = on ? 0.5 : 0
    mat.opacity += Math.sign(to - mat.opacity) * Math.min(Math.abs(to - mat.opacity), 4 * dt)
    for (const m of refs.current) if (m) m.visible = mat.opacity > 0.001
  })
  const tw = TERMINAL.x1 - TERMINAL.x0
  const td = TERMINAL.z1 - TERMINAL.z0
  // paved ground gets a thin layer, just over its markings, so planes on it stay above it
  const flat = (x0: number, x1: number, z0: number, z1: number): [V3, V3] => [[(x0 + x1) / 2, PAVE / 2 + 0.03, (z0 + z1) / 2], [x1 - x0 + 0.06, PAVE + 0.06, z1 - z0 + 0.06]]
  const boxes: Array<[V3, V3]> = [
    [[(TERMINAL.x0 + TERMINAL.x1) / 2, TERMINAL.h / 2 + 0.3, (TERMINAL.z0 + TERMINAL.z1) / 2], [tw + 0.7, TERMINAL.h + 0.7, td + 0.7]],
    [[TOWER.x, (TOWER.h + 3) / 2, TOWER.z], [3.5, TOWER.h + 3.6, 3.5]],
    flat(-RUNWAY_HALF, RUNWAY_HALF, RUNWAY_Z - RUNWAY_W / 2 - 0.5, RUNWAY_Z + RUNWAY_W / 2 + 0.5),
    ...TAXI_X.map((x) => flat(x - TAXI_W / 2, x + TAXI_W / 2, APRON.z1, RUNWAY_Z - RUNWAY_W / 2 - 0.5)),
    flat(APRON.x0, APRON.x1, APRON.z0, APRON.z1),
    flat(HELIPAD.x - HELIPAD.r - 0.5, HELIPAD.x + HELIPAD.r + 0.5, HELIPAD.z - HELIPAD.r - 0.5, HELIPAD.z + HELIPAD.r + 0.5),
  ]
  return (
    <>
      {boxes.map(([p, s], i) => (
        <mesh key={i} ref={(m) => void (refs.current[i] = m)} position={p} scale={s} material={mat} raycast={() => null} renderOrder={2}>
          <boxGeometry />
        </mesh>
      ))}
    </>
  )
}

/**
 * From the raised hall down to the plane's front door: a slim sloping tube, as tall as the fuselage, a cab turned onto the door and a wheeled leg under it.
 */
function JetBridge({ x }: { x: number }) {
  const door = { x: x + 0.95, y: 1.4, z: STAND_Z - 2.9 }
  const tube = { x: x + BRIDGE_DX, y0: HALL_LIFT + 0.75, y1: door.y + 0.1, z0: TERMINAL.z1, z1: door.z }
  const run = tube.z1 - tube.z0
  const drop = tube.y0 - tube.y1
  const mid: V3 = [tube.x, (tube.y0 + tube.y1) / 2, (tube.z0 + tube.z1) / 2]
  const tilt: V3 = [Math.atan2(drop, run), 0, 0]
  return (
    <>
      <B p={mid} s={[0.72, 1.05, Math.hypot(run, drop) + 0.4]} r={tilt} c="#c9ced8" />
      <B p={[mid[0] + 0.37, mid[1] + 0.12, mid[2]]} s={[0.02, 0.2, Math.hypot(run, drop) - 0.2]} r={tilt} c="#3d4a5c" shadow={false} />
      <B p={[door.x + 0.25, door.y + 0.1, door.z]} s={[1.0, 1.05, 0.95]} c="#aeb5c2" />
      <B p={[door.x - 0.28, door.y + 0.1, door.z]} s={[0.1, 0.98, 0.82]} c="#3a3f4a" />
      <B p={[tube.x, door.y / 2, door.z - 0.2]} s={[0.22, door.y, 0.22]} c="#3a3f4a" />
      <B p={[tube.x, 0.2, door.z - 0.2]} s={[0.9, 0.24, 0.4]} c="#2a2e36" />
    </>
  )
}

// Ground vehicles, nose along +x, wheels on y = 0, about the size of the plane's engine.
const TIRE = '#2a2e36'
const DARK = '#3a3f4a'
const WHITE = '#f4f4f0'
const BLUE = '#3b6fb0'
const GLASS = '#2c3f52'
const CONE = '#ff8a3c'

function Wheels({ xs, w, r = 0.36 }: { xs: number[]; w: number; r?: number }) {
  return <>{xs.flatMap((x) => [-1, 1].map((side) => <B key={`${x}${side}`} p={[x, r / 2, side * w / 2]} s={[r, r, 0.14]} c={TIRE} shadow={false} />))}</>
}

/** The orange light on a vehicle's roof, lit after dark. */
const Beacon = ({ p }: { p: V3 }) => <B p={p} s={[0.16, 0.14, 0.16]} c="#e58a2b" glow="#ffb347" shadow={false} />

/** Baggage tractor: a low yellow body, a windscreen and a roof on posts. */
function Tractor() {
  return (
    <>
      <B p={[0, 0.4, 0]} s={[1.3, 0.4, 0.9]} c={YELLOW} />
      <B p={[0.12, 0.85, 0]} s={[0.04, 0.45, 0.75]} c={GLASS} shadow={false} />
      {[-1, 1].map((side) => <B key={side} p={[-0.55, 0.85, side * 0.38]} s={[0.06, 0.5, 0.06]} c={DARK} />)}
      <B p={[-0.2, 1.13, 0]} s={[0.8, 0.08, 0.9]} c={DARK} />
      <Beacon p={[-0.2, 1.24, 0]} />
      <Wheels xs={[-0.4, 0.4]} w={0.9} />
    </>
  )
}

const BAGS = ['#c8643f', '#3b6fb0', '#5f8f5a', '#3a3f4a']

/** Baggage cart: a bed under a canopy on four posts, its tow bar to +x; `loaded`, with suitcases on it. */
function Cart({ loaded = false }: { loaded?: boolean }) {
  return (
    <>
      <B p={[0, 0.35, 0]} s={[1.5, 0.1, 0.9]} c={DARK} />
      {[-0.7, 0.7].flatMap((x) => [-0.4, 0.4].map((z) => <B key={`${x}${z}`} p={[x, 0.75, z]} s={[0.06, 0.8, 0.06]} c={DARK} />))}
      <B p={[0, 1.15, 0]} s={[1.5, 0.06, 0.9]} c={BLUE} />
      <B p={[0.9, 0.3, 0]} s={[0.3, 0.05, 0.08]} c={DARK} shadow={false} />
      {loaded && BAGS.map((c, i) => <B key={c} p={[-0.45 + (i % 2) * 0.8, 0.58 + Math.floor(i / 2) * 0.3, (i % 2 ? 0.15 : -0.15)]} s={[0.6, 0.3, 0.45]} c={c} />)}
      <Wheels xs={[-0.5, 0.5]} w={0.9} r={0.28} />
    </>
  )
}

/** A tractor pulling carts: the tractor at x 0, its carts behind it towards -x. */
function Train({ carts }: { carts: boolean[] }) {
  return (
    <>
      <Tractor />
      {carts.map((loaded, i) => <group key={i} position={[-1.75 - i * 1.85, 0, 0]}><Cart loaded={loaded} /></group>)}
    </>
  )
}

/** Belt loader: a sloping belt up to +x, its top end at x 1.7, the driver's seat beside its low end. */
function BeltLoader() {
  const tilt: V3 = [0, 0, 0.14]
  return (
    <>
      <B p={[0, 0.3, 0]} s={[2.6, 0.3, 0.9]} c={YELLOW} />
      <B p={[-0.4, 0.7, -0.3]} s={[0.6, 0.5, 0.3]} c={WHITE} />
      <Beacon p={[-0.4, 1.02, -0.3]} />
      <B p={[0.1, 0.73, 0.15]} s={[3.25, 0.1, 0.55]} r={tilt} c={TIRE} />
      {[-1, 1].map((side) => <B key={side} p={[0.1, 0.8, 0.15 + side * 0.3]} s={[3.25, 0.08, 0.05]} r={tilt} c={YELLOW} shadow={false} />)}
      <Wheels xs={[-0.9, 0.9]} w={0.9} />
    </>
  )
}

/** Fuel truck: a cab at +x, a tank with a band of the airport colour, a hose reel at the back. */
function FuelTruck() {
  return (
    <>
      <B p={[0, 0.3, 0]} s={[4, 0.25, 1.0]} c={DARK} />
      <B p={[1.5, 0.75, 0]} s={[1.0, 1.1, 1.1]} c={WHITE} />
      <B p={[2.01, 0.95, 0]} s={[0.04, 0.4, 0.95]} c={GLASS} shadow={false} />
      <Beacon p={[1.5, 1.38, 0]} />
      <B p={[-0.55, 0.95, 0]} s={[2.8, 1.0, 1.05]} c="#e8ebf0" />
      <B p={[-0.55, 0.95, 0]} s={[2.82, 0.16, 1.07]} c={BLUE} shadow={false} />
      <B p={[-2.0, 0.7, 0]} s={[0.2, 0.5, 0.8]} c={DARK} />
      <Wheels xs={[-1.4, -0.4, 1.4]} w={1.0} />
    </>
  )
}

/** Catering truck: its box lifted on a scissor up to a door at +x, the cab at -x. */
function CateringTruck() {
  return (
    <>
      <B p={[0, 0.3, 0]} s={[3.6, 0.25, 1.0]} c={DARK} />
      <B p={[-1.3, 0.75, 0]} s={[0.9, 0.9, 1.0]} c={WHITE} />
      <B p={[-1.76, 0.9, 0]} s={[0.04, 0.35, 0.85]} c={GLASS} shadow={false} />
      <Beacon p={[-1.3, 1.25, 0]} />
      {[-1, 1].map((side) => <B key={side} p={[0.6, 0.6, side * 0.42]} s={[2.0, 0.08, 0.06]} r={[0, 0, side * 0.2]} c={DARK} />)}
      <B p={[0.6, 1.4, 0]} s={[2.2, 1.2, 1.0]} c={WHITE} />
      <B p={[0.6, 1.85, 0]} s={[2.22, 0.14, 1.02]} c={BLUE} shadow={false} />
      <B p={[1.85, 0.83, 0]} s={[0.3, 0.06, 0.9]} c={DARK} />
      <Wheels xs={[-1.2, 1.2]} w={1.0} />
    </>
  )
}

/** Apron bus: white with a band of the airport colour, its windows lit after dark. */
function Bus() {
  return (
    <>
      <B p={[0, 0.95, 0]} s={[3.6, 1.3, 1.3]} c={WHITE} />
      <B p={[0, 1.15, 0]} s={[3.4, 0.4, 1.32]} c={GLASS} glow={LIT_GLASS} shadow={false} />
      <B p={[1.81, 1.0, 0]} s={[0.04, 0.7, 1.1]} c={GLASS} glow={LIT_GLASS} shadow={false} />
      <B p={[0, 0.6, 0]} s={[3.62, 0.14, 1.32]} c={BLUE} shadow={false} />
      <B p={[-0.4, 1.7, 0]} s={[1.2, 0.2, 0.8]} c="#c9ced8" />
      <Wheels xs={[-1.2, 1.2]} w={1.3} r={0.42} />
    </>
  )
}

/** Stair truck: stairs from the back up to a platform over the cab. */
function StairTruck() {
  const tilt: V3 = [0, 0, 0.478]
  return (
    <>
      <B p={[0, 0.3, 0]} s={[3.4, 0.25, 1.1]} c={DARK} />
      <B p={[1.15, 0.75, 0]} s={[0.9, 0.85, 1.1]} c={WHITE} />
      <B p={[1.61, 0.85, 0]} s={[0.04, 0.35, 0.95]} c={GLASS} shadow={false} />
      <B p={[-0.15, 1.2, 0]} s={[3.04, 0.12, 0.8]} r={tilt} c={YELLOW} />
      {[-1, 1].map((side) => <B key={side} p={[-0.15, 1.65, side * 0.42]} s={[3.04, 0.05, 0.05]} r={tilt} c={WHITE} shadow={false} />)}
      <B p={[1.5, 1.9, 0]} s={[0.7, 0.08, 0.8]} c={YELLOW} />
      {[-1, 1].map((side) => <B key={side} p={[1.5, 2.2, side * 0.42]} s={[0.7, 0.05, 0.05]} c={WHITE} shadow={false} />)}
      <Wheels xs={[-1.1, 1.1]} w={1.1} />
    </>
  )
}

/** Pushback tug: low, wide and yellow, a small cab on top. */
function Tug() {
  return (
    <>
      <B p={[0, 0.4, 0]} s={[2.4, 0.5, 1.4]} c={YELLOW} />
      <B p={[0.6, 0.85, 0]} s={[0.8, 0.45, 1.0]} c={WHITE} />
      <B p={[1.01, 0.88, 0]} s={[0.04, 0.3, 0.85]} c={GLASS} shadow={false} />
      <B p={[1.25, 0.35, 0]} s={[0.12, 0.25, 1.3]} c={DARK} />
      <Beacon p={[0.6, 1.15, 0]} />
      <Wheels xs={[-0.75, 0.75]} w={1.4} />
    </>
  )
}

function Cone() {
  return (
    <>
      <B p={[0, 0.03, 0]} s={[0.42, 0.06, 0.42]} c={CONE} shadow={false} />
      <B p={[0, 0.28, 0]} s={[0.26, 0.46, 0.26]} c={CONE} />
      <B p={[0, 0.3, 0]} s={[0.28, 0.1, 0.28]} c={WHITE} shadow={false} />
    </>
  )
}

/** Equipment parking: a row of stalls between the tower and the first stand, clear of the planes' wings as they taxi. */
const STALL = { x0: -9.4, w: 2.6, n: 5, z0: -10.4, d: 4 }
const stallX = (i: number) => STALL.x0 + (i + 0.5) * STALL.w
const STALL_Z = STALL.z0 + STALL.d / 2

/**
 * Ground vehicles, shown with detail on: a turnaround at the parked plane (stand 30, nose to -z, its wings
 * along x at z ≈ -5) and the equipment parked in the stalls, noses out. All clear of where the other plane
 * taxis: east of x 20 and z < -5 west of x 4.
 */
function GroundCrew() {
  const S = STANDS[1]
  const out = -PI / 2
  return (
    <group position={[0, PAVE, 0]}>
      {/* belt loader up to the rear hold, the baggage train beside its foot */}
      <group position={[S - 2.3, 0, -2.6]}><BeltLoader /></group>
      <group position={[S - 8.2, 0, -2.6]} rotation={[0, PI, 0]}><Train carts={[true, true]} /></group>
      {/* catering at the front door opposite the jet bridge */}
      <group position={[S - 2.5, 0, -7.9]}><CateringTruck /></group>
      {/* fuel truck behind the far wing, its hose up to the wing */}
      <group position={[S + 3.6, 0, -2.9]}><FuelTruck /></group>
      <B p={[S + 2, 0.55, -3.9]} s={[0.1, 0.1, 1.0]} c={TIRE} shadow={false} />
      <B p={[S + 2, 0.72, -4.4]} s={[0.1, 0.36, 0.1]} c={TIRE} shadow={false} />
      {/* cones at the nose, the wingtips and the tail */}
      {([[S, -10.2], [S - 4.7, -5.1], [S + 4.7, -5.1], [S, 0]] as const).map(([cx, cz]) => <group key={`${cx}${cz}`} position={[cx, 0, cz]}><Cone /></group>)}

      {/* the parked equipment */}
      <group position={[stallX(0), 0, STALL_Z]} rotation={[0, out, 0]}><Bus /></group>
      <group position={[stallX(1), 0, STALL_Z]} rotation={[0, out, 0]}><StairTruck /></group>
      <group position={[stallX(2), 0, STALL_Z + 0.8]} rotation={[0, out, 0]}><Train carts={[false]} /></group>
      <group position={[stallX(3), 0, STALL_Z]} rotation={[0, out, 0]}>
        <group position={[0.9, 0, 0]}><Cart /></group>
        <group position={[-0.95, 0, 0]}><Cart /></group>
      </group>
      <group position={[stallX(4), 0, STALL_Z]} rotation={[0, out, 0]}><Tug /></group>
    </group>
  )
}

/** Flat markings: never casting a shadow, just over what they are painted on. */
const paint = (x: number, z: number, w: number, d: number, c = MARK, y = PAVE + 0.005): { p: V3; s: V3; c: string } => ({ p: [x, y, z], s: [w, 0.01, d], c })

export function Airport({ town, open, hover, still, calm, onHover, onSelect }: {
  town: Town
  /** The settings are open: the exterior gives way to the inside. */
  open: boolean
  /** Editing the map: the airport can't be moved, so it takes no clicks. */
  still: boolean
  /** Under the pointer, with nothing else open: shaded to show it can be clicked. */
  hover: boolean
  calm: boolean
  onHover: (on: boolean) => void
  onSelect: () => void
}) {
  const [x, z] = rectCenter(town, town.airport)
  // less detail: no runway lights, window frames, roof units or windsock
  const detail = usePrefs((s) => s.detail)
  const marks = useMemo(() => {
    const out: Array<{ p: V3; s: V3; c: string }> = []
    // runway: edge lines, a dashed centre line, threshold bars at both ends
    for (const side of [-1, 1]) out.push(paint(0, RUNWAY_Z + side * (RUNWAY_W / 2 - 0.3), RUNWAY_HALF * 2 - 1, 0.3))
    for (let rx = -RUNWAY_HALF + 7; rx < RUNWAY_HALF - 7; rx += 4) out.push(paint(rx, RUNWAY_Z, 2.2, 0.22))
    for (const end of [-1, 1]) for (let k = -2; k <= 2; k++) {
      if (k === 0) continue
      out.push(paint(end * (RUNWAY_HALF - 2.4), RUNWAY_Z + k * 0.9, 3, 0.45))
    }
    // taxiways: a yellow line down the middle, curving onto the runway's centre line
    for (const tx of TAXI_X) out.push(paint(tx, (APRON.z1 + RUNWAY_Z) / 2 - 0.5, 0.3, RUNWAY_Z - APRON.z1 - 1, YELLOW))
    // apron: a lead-in line and a stop bar at each stand
    for (const sx of STANDS) {
      out.push(paint(sx, (STAND_Z - 4.6 + LANE_Z) / 2, 0.3, LANE_Z - STAND_Z + 4.6, YELLOW))
      out.push(paint(sx, STAND_Z - 4.6, 1.8, 0.3, YELLOW))
    }
    out.push(paint((APRON.x0 + APRON.x1) / 2, LANE_Z, APRON.x1 - APRON.x0 - 1, 0.3, YELLOW))
    // equipment stalls: dividers and a back line
    if (detail) {
      for (let i = 0; i <= STALL.n; i++) out.push(paint(STALL.x0 + i * STALL.w, STALL_Z, 0.15, STALL.d))
      out.push(paint(STALL.x0 + STALL.n * STALL.w / 2, STALL.z0, STALL.n * STALL.w + 0.15, 0.15))
    }
    // runway edge lights
    if (detail) for (let rx = -RUNWAY_HALF + 1; rx <= RUNWAY_HALF - 1; rx += 6) for (const side of [-1, 1]) {
      out.push({ p: [rx, PAVE + 0.1, RUNWAY_Z + side * (RUNWAY_W / 2 + 0.3)], s: [0.22, 0.2, 0.22], c: '#ffe7a3' })
    }
    return out
  }, [detail])

  const click = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation()
    // a press that moved was a pan, not a click
    if (e.delta <= 5) onSelect()
  }
  const tw = TERMINAL.x1 - TERMINAL.x0
  const td = TERMINAL.z1 - TERMINAL.z0
  const tx = (TERMINAL.x0 + TERMINAL.x1) / 2
  const tz = (TERMINAL.z0 + TERMINAL.z1) / 2
  return (
    <group position={[x, 0, z]} onClick={click}
      onPointerOver={(e) => { e.stopPropagation(); onHover(true); document.body.style.cursor = still || open ? '' : 'pointer' }}
      onPointerOut={() => { onHover(false); document.body.style.cursor = '' }}>
      {/* runway, taxiways and apron, at the plots' paving height */}
      <B p={[0, PAVE / 2, RUNWAY_Z]} s={[RUNWAY_HALF * 2, PAVE, RUNWAY_W]} c={ASPHALT} />
      {TAXI_X.map((tx2) => <B key={tx2} p={[tx2, PAVE / 2 - 0.002, (APRON.z1 + RUNWAY_Z) / 2]} s={[TAXI_W, PAVE, RUNWAY_Z - APRON.z1 + 0.2]} c={TAXI} />)}
      <B p={[(APRON.x0 + APRON.x1) / 2, PAVE / 2, (APRON.z0 + APRON.z1) / 2]} s={[APRON.x1 - APRON.x0, PAVE, APRON.z1 - APRON.z0]} c={CONCRETE} />
      {marks.map((m, i) => <B key={i} {...m} shadow={false} />)}

      {/* helipad: a dark square with a white ring and an H */}
      <group position={[HELIPAD.x, 0, HELIPAD.z]}>
        <B p={[0, PAVE / 2, 0]} s={[HELIPAD.r * 2 + 1, PAVE, HELIPAD.r * 2 + 1]} c={ASPHALT} />
        <mesh position={[0, PAVE + 0.004, 0]} rotation={[-PI / 2, 0, 0]} material={toon(MARK)} receiveShadow>
          <ringGeometry args={[HELIPAD.r - 0.35, HELIPAD.r, 32]} />
        </mesh>
        <B p={[-0.8, PAVE + 0.006, 0]} s={[0.36, 0.01, 2.4]} c={MARK} shadow={false} />
        <B p={[0.8, PAVE + 0.006, 0]} s={[0.36, 0.01, 2.4]} c={MARK} shadow={false} />
        <B p={[0, PAVE + 0.006, 0]} s={[1.6, 0.01, 0.36]} c={MARK} shadow={false} />
      </group>

      <Fade show={!open}>
      {/* terminal: a long low hall, glass facing the apron, a white roof with a band of the airport colour */}
      <B p={[tx, TERMINAL.h / 2, tz]} s={[tw, TERMINAL.h, td]} c="#dfe3ea" />
      <B p={[tx, TERMINAL.h * 0.45, TERMINAL.z1 + 0.02]} s={[tw - 1.2, TERMINAL.h * 0.62, 0.06]} c="#5b8ab4" glow={LIT_GLASS} />
      {detail && Array.from({ length: Math.floor(tw / 2) }, (_, i) => (
        <B key={i} p={[TERMINAL.x0 + 1 + i * 2, TERMINAL.h * 0.45, TERMINAL.z1 + 0.06]} s={[0.12, TERMINAL.h * 0.62, 0.04]} c="#3d4a5c" shadow={false} />
      ))}
      <B p={[tx, TERMINAL.h + 0.15, tz]} s={[tw + 0.6, 0.3, td + 0.6]} c="#f4f4f0" />
      {/* air-conditioning units on the roof */}
      {detail && [-12, -5, 6, 13].map((dx) => <B key={dx} p={[tx + dx, TERMINAL.h + 0.6, tz - 0.6]} s={[2.2, 0.6, 1.6]} c="#b9bec8" />)}
      <B p={[tx, TERMINAL.h - 0.25, TERMINAL.z1 + 0.32]} s={[tw + 0.6, 0.3, 0.06]} c="#3b6fb0" shadow={false} />
      </Fade>
      {/* a jet bridge out to each stand */}
      {STANDS.map((sx) => <JetBridge key={sx} x={sx} />)}

      {/* control tower: a shaft with a glass cab and an antenna */}
      <group position={[TOWER.x, 0, TOWER.z]}>
        <B p={[0, 0.6, 0]} s={[3.2, 1.2, 3.2]} c="#dfe3ea" />
        <B p={[0, TOWER.h / 2, 0]} s={[1.6, TOWER.h, 1.6]} c="#e8ebf0" />
        <B p={[0, TOWER.h + 0.1, 0]} s={[3.2, 0.2, 3.2]} c="#c9ced8" />
        <Fade show={!open}>
          <B p={[0, TOWER.h + 1.0, 0]} s={[2.9, 1.6, 2.9]} c="#5b8ab4" glow={LIT_GLASS} />
          <B p={[0, TOWER.h + 1.95, 0]} s={[3.4, 0.3, 3.4]} c="#3a3f4a" />
          <B p={[0, TOWER.h + 2.8, 0]} s={[0.1, 1.4, 0.1]} c="#3a3f4a" />
          <B p={[0, TOWER.h + 3.55, 0]} s={[0.25, 0.25, 0.25]} c="#e5533a" />
        </Fade>
      </group>

      {/* windsock at the runway's end */}
      {detail && <group position={[RUNWAY_HALF - 4, 0, RUNWAY_Z - RUNWAY_W / 2 - 2.2]}>
        <B p={[0, 1.5, 0]} s={[0.12, 3, 0.12]} c="#3a3f4a" />
        <Windsock />
      </group>}

      {/* a plane at the other stand, and the one that comes and goes */}
      <group position={[STANDS[1], 0, STAND_Z]} rotation={[0, PI / 2, 0]}>
        <Plane body="#f4f4f0" tail="#c8643f" />
      </group>
      {detail && <GroundCrew />}
      <Flight calm={calm} />
      <Fade show={open}><AirportInterior /></Fade>
      <Shade on={hover} />
    </group>
  )
}
