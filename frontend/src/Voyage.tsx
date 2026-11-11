// The flights that bring the camera to an island (voyagePath.ts), in the scene: the plane the camera follows, the
// sparse clouds it flies over, and the camera itself while one is under way. The player's controls wait meanwhile;
// any input skips to the end, or, leaving an island, to out over open sea. The screen's controls and panels
// are off the screen meanwhile (`away`, fusion.css): leaving an island they slide off before the plane takes off,
// and they slide back on once it has brought the camera in.

import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { Plane, runwayObstacles } from './Airport'
import { setPilot, skipBoot } from './boot'
import { CAMERA_DISTANCE, islandView, MIN_ZOOM, type Shot } from './camera'
import { Fade } from './Fade'
import { light } from './daylight'
import { CELL, hash, rectCenter, type Town } from './layout'
import { MAX_FRAME, NO_OUTLINE_LAYER } from './PixelPass'
import { playSound } from './sound'
import { toon } from './toon'
import {
  approachFrame, ARRIVAL_SECONDS, clearDistance, CLOUD_Y, crossing, cruiseZoom, departFrame, departure,
  drift, introApproach, newFrame, planeShadow, useVoyage, viewDir, type Approach, type Departure, type Frame,
} from './voyagePath'

type Leg =
  | { kind: 'arrive'; t: number; a: Approach }
  | { kind: 'depart'; t: number; d: Departure; from: Shot; cruise: number; swaps: Array<() => void>; swapped: boolean }

/** How far past the screen's edge, in plane lengths, the plane flies on before it goes. */
const OFF_SCREEN = 0.6

/** Seconds the screen's controls and panels take to slide off it before the plane takes off; fusion.css matches it. */
const UI_OUT_SECONDS = 0.4
/** The longest the plane flies on once the camera has landed, if it never leaves the screen. */
const EXIT_LIMIT = 10
/** The longest it flies on over open sea for an island that never says it has come (the same one gone to again, say). */
const HOLD_LIMIT = 16
/** Swaps the islands anyway this long after the island left should be out of sight: frames stop in a hidden window. */
const SWAP_LATE_MS = 3000

/** Room round an island the plane must be beyond for none of it to show; another island may be bigger. */
const islandRadius = (town: Town) => Math.max(town.radius, 60) * 1.5

export function Voyage({ town, landing, clouds }: { town: Town; landing: number; clouds: boolean }) {
  const camera = useThree((s) => s.camera) as THREE.OrthographicCamera
  const controls = useThree((s) => s.controls) as unknown as { target: THREE.Vector3; minZoom: number } | null
  const size = useThree((s) => s.size)
  const live = useRef({ town, size, controls })
  live.current = { town, size, controls }
  const leg = useRef<Leg | null>(null)
  /** The island gone to has come, so the plane may come in. */
  const ready = useRef(false)
  const holding = useRef(0)
  const exit = useRef<{ a: Approach; t: number; scale: number } | null>(null)
  const frame = useMemo<Frame>(newFrame, [])
  const plane = useRef<THREE.Group>(null)
  const pitch = useRef(0)
  const roll = useRef(0)
  const scale = useRef(1)
  /** How much shadow the plane casts: none out at sea (`planeShadow`). */
  const shade = useRef(0)
  const [shown, setShown] = useState(false)
  const [gear, setGear] = useState(true)
  const cloudAmount = useRef(0)

  const distance = () => Math.max(CAMERA_DISTANCE, live.current.town.radius * 3)
  const shotNow = () => islandView(live.current.town, live.current.size)

  const place = (target: THREE.Vector3, zoom: number, tilt: number) => {
    const c = live.current.controls
    if (!c) return
    c.target.copy(target)
    const d = distance()
    camera.position.copy(target).addScaledVector(viewDir(tilt), d)
    camera.far = d * 3
    camera.lookAt(target)
    camera.zoom = zoom
    camera.updateProjectionMatrix()
  }

  const finish = (l: Extract<Leg, { kind: 'arrive' }>) => {
    const to = l.a.to
    place(to.target, to.zoom, 1)
    if (live.current.controls) live.current.controls.minZoom = Math.min(MIN_ZOOM, to.zoom)
    exit.current = { a: l.a, t: Math.max(l.t, l.a.seconds), scale: scale.current }
    leg.current = null
    useVoyage.setState({ active: false, leaving: false, away: false })
  }

  const swapNow = (l: Extract<Leg, { kind: 'depart' }>) => {
    if (l.swapped) return
    l.swapped = true
    ready.current = false
    holding.current = 0
    // skipped before it took off: it is out over the sea at once
    if (l.t < 0) setShown(true)
    l.t = Math.max(l.t, l.d.clear)
    useVoyage.setState({ leaving: false })
    for (const swap of l.swaps.splice(0)) swap()
  }

  /** Takes off from the island shown, to change it for another once it is out of sight; to the left for `home`. */
  const depart = (swap: () => void, home: boolean) => {
    const now = leg.current
    if (now?.kind === 'depart') {
      // already away: swap along with the first, or at once over open sea
      if (now.swapped) {
        ready.current = false
        holding.current = 0
        swap()
      } else now.swaps.push(swap)
      return
    }
    if (now?.kind === 'arrive') finish(now)
    const { town: t, size: s, controls: c } = live.current
    const [ax, az] = rectCenter(t, t.airport)
    const cruise = cruiseZoom(shotNow().zoom)
    const d = departure(new THREE.Vector3(ax, 0, az), runwayObstacles(t), s, cruise, islandRadius(t), home)
    const from = { target: c ? c.target.clone() : shotNow().target, zoom: camera.zoom }
    // the screen's controls and panels slide off it first; the take-off starts at 0
    const l: Extract<Leg, { kind: 'depart' }> = { kind: 'depart', t: -UI_OUT_SECONDS, d, from, cruise, swaps: [swap], swapped: false }
    leg.current = l
    exit.current = null
    pitch.current = 0
    roll.current = 0
    setGear(true)
    setShown(false)
    useVoyage.setState({ active: true, leaving: true, away: true })
    setTimeout(() => { if (leg.current === l) swapNow(l) }, (UI_OUT_SECONDS + d.clear) * 1000 + SWAP_LATE_MS)
  }

  useEffect(() => {
    setPilot((swap, home) => depart(swap, home))
    return () => {
      setPilot(null)
      const l = leg.current
      if (l?.kind === 'depart') for (const swap of l.swaps.splice(0)) swap()
      leg.current = null
      useVoyage.setState({ active: false, leaving: false, away: false, intro: null })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // the island gone to has come
  const seenLanding = useRef(landing)
  useEffect(() => {
    if (landing === seenLanding.current) return
    seenLanding.current = landing
    ready.current = true
  }, [landing])

  // any input: straight to the end, or out over open sea
  const active = useVoyage((s) => s.active)
  useEffect(() => {
    if (!active) return
    const skip = () => {
      skipBoot()
      const l = leg.current
      if (l?.kind === 'arrive') l.t = l.a.seconds
      else if (l?.kind === 'depart') swapNow(l)
    }
    const inputs = new AbortController()
    for (const type of ['pointerdown', 'wheel', 'keydown']) window.addEventListener(type, skip, { capture: true, signal: inputs.signal })
    return () => inputs.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  const posePlane = (f: Frame, dt: number, s = f.scale) => {
    const g = plane.current
    if (!g) return
    const p = f.plane
    g.position.copy(p.p)
    // eased, so it never snaps where the take-off's path bends over a building, or into and out of a turn
    pitch.current += (p.pitch - pitch.current) * Math.min(1, dt * 6)
    roll.current += (p.roll - roll.current) * Math.min(1, dt * 4)
    g.rotation.set(roll.current, p.heading, pitch.current, 'YZX')
    scale.current = s
    g.scale.setScalar(s)
    shade.current = planeShadow(p.p, light.toSun, live.current.town.radius)
    if (p.gear !== gear) setGear(p.gear)
  }

  /** Whether the plane has flown off the screen. */
  const at = useMemo(() => new THREE.Vector3(), [])
  const offScreen = (p: THREE.Vector3, s: number) => {
    at.copy(p).project(camera)
    // a plane length past the edge, as a share of half the screen
    const past = (len: number) => 1 + (OFF_SCREEN + 0.5) * 8.8 * s * camera.zoom / (len / 2)
    return Math.abs(at.x) > past(live.current.size.width) || Math.abs(at.y) > past(live.current.size.height)
  }

  // before everything else that follows the camera (the sea, the sun's shadow box, the clouds), so a jump never lags
  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, MAX_FRAME)
    const asked = useVoyage.getState().intro
    if (asked && live.current.controls) {
      useVoyage.setState({ intro: null })
      const { town: t, size: s } = live.current
      leg.current = { kind: 'arrive', t: -asked.hold, a: introApproach(shotNow(), s, t.radius, asked.seconds, islandRadius(t)) }
      exit.current = null
      setGear(false)
      setShown(true)
    }

    const l = leg.current
    if (l?.kind === 'arrive') {
      l.t += dt
      if (l.t >= l.a.seconds) finish(l)
      else {
        approachFrame(l.a, Math.max(0, l.t), frame)
        place(frame.target, frame.zoom, frame.tilt)
        posePlane(frame, dt)
        cloudAmount.current = frame.clouds
      }
    } else if (l?.kind === 'depart') {
      const before = l.t
      l.t += dt
      // the screen has cleared: off it goes
      if (before < 0 && l.t >= 0) {
        setShown(true)
        playSound('soundTakeoff')
      }
      if (!l.swapped && l.t >= l.d.clear) swapNow(l)
      departFrame(l.d, l.from, l.cruise, Math.max(0, l.t), frame)
      if (l.swapped) {
        holding.current += dt
        if (holding.current >= HOLD_LIMIT) ready.current = true
        if (ready.current) {
          // over open sea before the island arrived, on the same way: it comes in from the side the plane flies to
          const { town: t, size: s } = live.current
          const c = crossing(frame.plane, l.d.out, shotNow(), l.cruise, ARRIVAL_SECONDS, { view: s, radius: t.radius }, islandRadius(t))
          drift.add(c.jump)
          leg.current = { kind: 'arrive', t: 0, a: c.a }
          ready.current = false
          approachFrame(c.a, 0, frame)
        }
      }
      place(frame.target, frame.zoom, frame.tilt)
      posePlane(frame, dt)
      cloudAmount.current = frame.clouds
    } else if (exit.current) {
      const e = exit.current
      e.t += dt
      approachFrame(e.a, e.t, frame)
      posePlane(frame, dt, e.scale)
      cloudAmount.current = 0
      if (offScreen(frame.plane.p, e.scale) || e.t >= e.a.seconds + EXIT_LIMIT) {
        exit.current = null
        setShown(false)
      }
    } else cloudAmount.current = 0
  }, -1)

  return (
    <>
      <group ref={plane}>
        <Fade show={shown} shade={shade}><Plane body="#f4f4f0" tail="#3b6fb0" gear={gear} /></Fade>
      </group>
      {clouds && <HighClouds amount={cloudAmount} />}
    </>
  )
}

// ---------------------------------------------------------------- the clouds flown over

/** Side of the squares the sea is cut into for clouds: some have one, at a place of its own. */
const SQUARE = 56
const CLOUDY = 0.3
/** Cloud boxes are this many times the low clouds' (Ambient.tsx), seen from this high. */
const PUFF = 2.5
const MOST = 200

interface Puff { x: number; z: number; parts: Array<{ p: [number, number, number]; s: [number, number, number]; crown: boolean }> }

/** The cloud in square (i, j), if it has one; always the same. */
function puffAt(i: number, j: number): Puff | null {
  if (hash(i, j, 1) >= CLOUDY) return null
  const u = CELL * PUFF
  const len = 3 + Math.floor(hash(i, j, 4) * 4)
  const wide = 2 + Math.floor(hash(i, j, 5) * 2)
  const parts: Puff['parts'] = [{ p: [0, 0, 0], s: [len * u, u * 0.6, wide * u], crown: false }]
  if (len >= 4) {
    parts.push({ p: [(hash(i, j, 6) - 0.5) * (len - 2) * u, 0, (wide / 2 + 0.5) * u], s: [2 * u, u * 0.6, u], crown: false })
    // the biggest get a lump on the other side too, so none reads as a plain box from above
    if (len >= 5) parts.push({ p: [(hash(i, j, 8) - 0.5) * (len - 3) * u, 0, -(wide / 2 + 0.5) * u], s: [3 * u, u * 0.6, u], crown: false })
    parts.push({ p: [(hash(i, j, 7) - 0.5) * u, u * 0.6, 0], s: [(len - 2) * u, u * 0.6, (wide - 1) * u], crown: true })
  }
  return { x: (i + 0.15 + hash(i, j, 2) * 0.7) * SQUARE, z: (j + 0.15 + hash(i, j, 3) * 0.7) * SQUARE, parts }
}

/**
 * Sparse flat clouds well below the plane, over all the sea round what the camera looks at; each square of sea
 * always has the same one, so they pass by as the camera flies; moved on by the flights' jumps (`drift`), so those never
 * show. `amount` fades them all.
 */
function HighClouds({ amount }: { amount: { current: number } }) {
  const base = useRef<THREE.InstancedMesh>(null)
  const crown = useRef<THREE.InstancedMesh>(null)
  const mats = useMemo(() => {
    const m = [toon('#e6edf4').clone(), toon('#ffffff').clone()]
    for (const x of m) x.transparent = true
    return m
  }, [])
  useEffect(() => () => mats.forEach((m) => m.dispose()), [mats])
  useLayoutEffect(() => {
    for (const m of [base.current, crown.current]) if (m) m.count = 0
  }, [])
  const controls = useThree((s) => s.controls) as unknown as { target: THREE.Vector3 } | null
  const m4 = useMemo(() => new THREE.Matrix4(), [])
  const at = useMemo(() => new THREE.Vector3(), [])
  const spot = useMemo(() => new THREE.Vector3(), [])
  const one = useMemo(() => new THREE.Quaternion(), [])
  const box = useMemo(() => new THREE.Vector3(), [])

  useFrame(({ camera, size }) => {
    const b = base.current, c = crown.current
    if (!b || !c) return
    const k = amount.current
    const on = k > 0 && !!controls
    b.visible = c.visible = on
    if (!on) return
    for (const m of mats) {
      m.opacity = k
      m.depthWrite = k === 1
    }
    // out of the outline pass while see-through, like everything else that fades
    for (const m of [b, c]) m.layers.set(k === 1 ? 0 : NO_OUTLINE_LAYER)
    // where the camera looks, in the clouds' own pattern
    const t = at.copy(controls.target).sub(drift)
    // the clouds sit higher than the ground the camera looks at: look round where its line of sight meets them
    const reach = clearDistance(size, (camera as THREE.OrthographicCamera).zoom, SQUARE * 1.5)
    const i0 = Math.floor((t.x - reach) / SQUARE), i1 = Math.floor((t.x + reach) / SQUARE)
    const j0 = Math.floor((t.z - reach) / SQUARE), j1 = Math.floor((t.z + reach) / SQUARE)
    let nb = 0, nc = 0
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const puff = puffAt(i, j)
      if (!puff) continue
      for (const part of puff.parts) {
        const mesh = part.crown ? c : b
        const n = part.crown ? nc : nb
        if (n >= MOST * 2) continue
        spot.set(puff.x + part.p[0] + drift.x, CLOUD_Y + part.p[1], puff.z + part.p[2] + drift.z)
        mesh.setMatrixAt(n, m4.compose(spot, one, box.set(...part.s)))
        if (part.crown) nc++
        else nb++
      }
    }
    b.count = nb
    c.count = nc
    b.instanceMatrix.needsUpdate = c.instanceMatrix.needsUpdate = true
  })

  return (
    <>
      <instancedMesh ref={base} args={[undefined, undefined, MOST * 2]} material={mats[0]} frustumCulled={false}><boxGeometry /></instancedMesh>
      <instancedMesh ref={crown} args={[undefined, undefined, MOST * 2]} material={mats[1]} frustumCulled={false}><boxGeometry /></instancedMesh>
    </>
  )
}
