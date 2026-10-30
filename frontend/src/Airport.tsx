// The airport: a fixed field behind the town (layout.ts `AIRPORT`). A terminal and a control tower along the
// far side, an apron (停機坪) in front of them with a parked plane and a helipad beside it, two taxiways down
// to a runway along x on the town side. A plane keeps landing, taxiing to its stand, waiting, and taking off
// again. Clicking anywhere on it opens the settings.

import { useFrame, type ThreeEvent } from '@react-three/fiber'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { Fade } from './Fade'
import { AIRPORT, CELL, rectCenter, RUNWAY_CELLS, RUNWAY_LINE, type Town } from './layout'
import { NO_OUTLINE_LAYER } from './PixelPass'
import { usePrefs } from './prefs'
import { toon } from './toon'

type V3 = [number, number, number]

function B({ p, s, c, shadow = true }: { p: V3; s: V3; c: string; shadow?: boolean }) {
  return (
    <mesh position={p} scale={s} material={toon(c)} castShadow={shadow} receiveShadow>
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

/** Runway: along x on the town side, three cells wide. */
const RUNWAY_Z = (RUNWAY_LINE - AIRPORT.d / 2) * CELL
const RUNWAY_W = RUNWAY_CELLS * CELL
const RUNWAY_HALF = HALF_W - 3
/** Taxiways from the apron down to the runway. */
const TAXI_X = [-6, 14]
const TAXI_W = 1.5 * CELL
/** Apron, in front of the terminal. */
const APRON = { x0: -10, x1: 32, z0: -13, z1: -3 }
/** Terminal and tower along the far side. */
export const TERMINAL = { x0: -4, x1: 32, z0: -19, z1: -13, h: 5 }
const TOWER = { x: -14, z: -15, h: 14 }
/** The top of the tower's cab, the airport's highest point. */
export const AIRPORT_TOP = TOWER.h + 3
const HELIPAD = { x: -28, z: -8, r: 3.4 }

/** A short airliner, nose along +x, wheels on y = 0: about four cells long. */
/** `gear` false: wheels up, for a plane cruising past. */
export function Plane({ body, tail, gear = true }: { body: string; tail: string; gear?: boolean }) {
  return (
    <>
      {/* fuselage, nose and tail cone */}
      <B p={[0, 1.25, 0]} s={[6.4, 1.1, 1.1]} c={body} />
      <B p={[3.6, 1.15, 0]} s={[0.8, 0.85, 0.85]} c={body} />
      <B p={[4.15, 1.05, 0]} s={[0.4, 0.5, 0.55]} c={body} />
      <B p={[-3.7, 1.45, 0]} s={[1.0, 0.7, 0.7]} c={body} />
      {/* cockpit windows, a window line and a stripe in the airline's colour */}
      <B p={[3.75, 1.42, 0]} s={[0.5, 0.18, 0.88]} c="#2c3f52" shadow={false} />
      <B p={[0.3, 1.45, 0]} s={[5.4, 0.14, 1.12]} c="#3b5670" shadow={false} />
      <B p={[0.3, 1.0, 0]} s={[6.2, 0.16, 1.12]} c={tail} shadow={false} />
      {/* wings, engines under them */}
      <B p={[0.1, 0.95, 0]} s={[1.6, 0.14, 8.4]} c={body} />
      <B p={[-0.5, 0.97, 0]} s={[0.5, 0.1, 8.0]} c="#c9ced8" shadow={false} />
      {[-1.9, 1.9].map((z) => (
        <group key={z}>
          <B p={[0.55, 0.6, z]} s={[1.3, 0.55, 0.55]} c="#c9ced8" />
          <B p={[1.22, 0.6, z]} s={[0.06, 0.42, 0.42]} c="#3a3f4a" shadow={false} />
        </group>
      ))}
      {/* tail fin and stabilisers */}
      <B p={[-3.5, 2.5, 0]} s={[1.3, 1.6, 0.14]} c={tail} />
      <B p={[-3.9, 1.6, 0]} s={[0.9, 0.12, 3.2]} c={body} />
      {/* landing gear */}
      {gear && <B p={[2.8, 0.35, 0]} s={[0.14, 0.7, 0.14]} c="#3a3f4a" />}
      {gear && [-0.7, 0.7].map((z) => <B key={z} p={[-0.4, 0.3, z]} s={[0.4, 0.6, 0.2]} c="#2a2e36" />)}
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
  { t: 21, p: [EAST, 0, -1], h: PI / 2 },
  { t: 22, p: [EAST - 1, 0, -2.6], h: PI * 0.8 },
  { t: 23, p: [EAST - 3, 0, -3], h: PI },
  { t: 25, p: [6.5, 0, -3], h: PI },
  { t: 26.5, p: [4.6, 0, -5], h: PI * 0.6 },
  { t: 28, p: [4, 0, -8], h: PI / 2 },
  // at the stand
  { t: 40, p: [4, 0, -8], h: PI / 2 },
  // pushed back, the nose swinging round to the west
  { t: 45, p: [4.5, 0, -3.5], h: PI },
  { t: 47, p: [4.5, 0, -3.5], h: PI },
  { t: 50, p: [WEST + 2, 0, -3.5], h: PI },
  { t: 51.5, p: [WEST, 0, -1.5], h: PI * 1.5 },
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
  useLayoutEffect(() => {
    if (calm) {
      clock.current = STAND_AT
      setShown(true)
    }
    if (ref.current) poseAt(clock.current, ref.current)
  }, [calm])
  useFrame((_, dt) => {
    if (calm || !ref.current) return
    clock.current = (clock.current + Math.min(dt, 0.1)) % CYCLE
    const t = clock.current
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

/** Flat markings: never casting a shadow, just over what they are painted on. */
const paint = (x: number, z: number, w: number, d: number, c = MARK, y = PAVE + 0.005): { p: V3; s: V3; c: string } => ({ p: [x, y, z], s: [w, 0.01, d], c })

export function Airport({ town, hover, still, calm, onHover, onSelect }: {
  town: Town
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
    for (const sx of [4, 22]) {
      out.push(paint(sx, -7, 0.3, 6, YELLOW))
      out.push(paint(sx, -11.2, 1.8, 0.3, YELLOW))
    }
    out.push(paint((APRON.x0 + APRON.x1) / 2, -3.6, APRON.x1 - APRON.x0 - 1, 0.3, YELLOW))
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
      onPointerOver={(e) => { e.stopPropagation(); onHover(true); document.body.style.cursor = still ? '' : 'pointer' }}
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

      {/* terminal: a long low hall, glass facing the apron, a white roof with a band of the airport colour */}
      <B p={[tx, TERMINAL.h / 2, tz]} s={[tw, TERMINAL.h, td]} c="#dfe3ea" />
      <B p={[tx, TERMINAL.h * 0.45, TERMINAL.z1 + 0.02]} s={[tw - 1.2, TERMINAL.h * 0.62, 0.06]} c="#5b8ab4" />
      {detail && Array.from({ length: Math.floor(tw / 2) }, (_, i) => (
        <B key={i} p={[TERMINAL.x0 + 1 + i * 2, TERMINAL.h * 0.45, TERMINAL.z1 + 0.06]} s={[0.12, TERMINAL.h * 0.62, 0.04]} c="#3d4a5c" shadow={false} />
      ))}
      <B p={[tx, TERMINAL.h + 0.15, tz]} s={[tw + 0.6, 0.3, td + 0.6]} c="#f4f4f0" />
      {/* air-conditioning units on the roof */}
      {detail && [-12, -5, 6, 13].map((dx) => <B key={dx} p={[tx + dx, TERMINAL.h + 0.6, tz - 0.6]} s={[2.2, 0.6, 1.6]} c="#b9bec8" />)}
      <B p={[tx, TERMINAL.h - 0.25, TERMINAL.z1 + 0.32]} s={[tw + 0.6, 0.3, 0.06]} c="#3b6fb0" shadow={false} />
      {/* a jet bridge out to each stand */}
      {[4, 22].map((sx) => (
        <group key={sx}>
          <B p={[sx + 3, 2.2, -11.5]} s={[1.0, 1.0, 3.4]} c="#c9ced8" />
          <B p={[sx + 3, 0.85, -10.2]} s={[0.3, 1.7, 0.3]} c="#3a3f4a" />
        </group>
      ))}

      {/* control tower: a shaft with a glass cab and an antenna */}
      <group position={[TOWER.x, 0, TOWER.z]}>
        <B p={[0, 0.6, 0]} s={[3.2, 1.2, 3.2]} c="#dfe3ea" />
        <B p={[0, TOWER.h / 2, 0]} s={[1.6, TOWER.h, 1.6]} c="#e8ebf0" />
        <B p={[0, TOWER.h + 0.1, 0]} s={[3.2, 0.2, 3.2]} c="#c9ced8" />
        <B p={[0, TOWER.h + 1.0, 0]} s={[2.9, 1.6, 2.9]} c="#5b8ab4" />
        <B p={[0, TOWER.h + 1.95, 0]} s={[3.4, 0.3, 3.4]} c="#3a3f4a" />
        <B p={[0, TOWER.h + 2.8, 0]} s={[0.1, 1.4, 0.1]} c="#3a3f4a" />
        <B p={[0, TOWER.h + 3.55, 0]} s={[0.25, 0.25, 0.25]} c="#e5533a" />
      </group>

      {/* windsock at the runway's end */}
      {detail && <group position={[RUNWAY_HALF - 4, 0, RUNWAY_Z - RUNWAY_W / 2 - 2.2]}>
        <B p={[0, 1.5, 0]} s={[0.12, 3, 0.12]} c="#3a3f4a" />
        <B p={[0.55, 2.8, 0]} s={[0.9, 0.42, 0.42]} c="#ff8a3c" />
        <B p={[1.25, 2.78, 0]} s={[0.5, 0.32, 0.32]} c="#f4f4f0" />
      </group>}

      {/* a plane at the other stand, and the one that comes and goes */}
      <group position={[22, 0, -8]} rotation={[0, PI / 2, 0]}>
        <Plane body="#f4f4f0" tail="#c8643f" />
      </group>
      <Flight calm={calm} />
      <Shade on={hover} />
    </group>
  )
}
