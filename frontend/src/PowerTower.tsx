// The power tower (基地台), drawn as a cell tower: a tapering steel lattice on a fenced pad in the airfield's far corner
// (layout.ts `POWER_TOWER`), with two platforms of panel antennas, microwave dishes on its legs, an equipment cabinet
// at its foot, and a pole on top whose beacon blinks after dark. Clicking it opens the tower's
// panel, where this computer is paired with others and goes to their islands.

import { useFrame, type ThreeEvent } from '@react-three/fiber'
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { POWER_TOWER, rectCenter, type Town } from './layout'
import { Merged } from './Merged'
import { NO_OUTLINE_LAYER } from './PixelPass'
import { usePrefs } from './prefs'
import { toon, toonGlow } from './toon'

type V3 = [number, number, number]
const PI = Math.PI

function B({ p, s, c, r, shadow = true, glow }: { p: V3; s: V3; c: string; r?: V3; shadow?: boolean; glow?: string }) {
  return (
    <mesh position={p} rotation={r} scale={s} material={glow ? toonGlow(c, glow) : toon(c)} castShadow={shadow} receiveShadow>
      <boxGeometry />
    </mesh>
  )
}

const STEEL = '#9aa2ae'
const STEEL_DARK = '#6b7280'
const PAD = '#c4c0cc'
const FENCE = '#7d8590'
/** Panel antennas and microwave dish faces. */
const PANEL = '#eef0f3'
const DISH = '#d9dde3'
const CABINET = '#b9bec8'
const CABLE = '#3a3f4a'
/** Takes clicks without being drawn. */
const HIT = new THREE.MeshBasicMaterial({ visible: false })
/** Top of the paving, as on the airfield. */
const PAVE = 0.08

/** Half the leg spread at the foot and at the lattice's top, and how high the lattice goes; a pole carries on to the beacon. */
const FOOT = 1.9
const TOP = 0.75
const LATTICE_Y = 34
/** Steps each leg climbs in, inward as it goes up: a voxel taper. */
const STEPS = 16
/** Antenna platforms: height, half side of the frame, and panels on each side of it. */
const PLATFORMS: Array<[number, number, number]> = [[32.2, 1.75, 2], [26.8, 1.55, 1]]
/** Microwave dishes on the legs: height, and the face they look out of (+z towards the town, -x to the side). */
const DISHES: Array<[number, 'z' | 'x']> = [[21.4, 'z'], [16.8, 'x']]

/** Where a leg is at height y: from the foot's spread in to the top's. */
const spread = (y: number) => FOOT + (TOP - FOOT) * Math.min(1, y / LATTICE_Y)

export function PowerTower({ town, hover, still, onHover, onSelect }: {
  town: Town
  /** Under the pointer, with nothing else open: shaded to show it can be clicked. */
  hover: boolean
  /** Editing the map: the tower can't be moved, so it takes no clicks. */
  still: boolean
  onHover: (on: boolean) => void
  onSelect: () => void
}) {
  const [ax, az] = rectCenter(town, town.airport)
  const detail = usePrefs((s) => s.detail)
  const steel = useMemo(() => {
    const out: Array<{ p: V3; s: V3; c: string; r?: V3 }> = []
    const step = LATTICE_Y / STEPS
    // four legs, each a stack of short posts stepping in towards the top
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (let i = 0; i < STEPS; i++) {
      const y = i * step
      const r = spread(y + step / 2)
      out.push({ p: [sx * r, y + step / 2, sz * r], s: [0.34, step + 0.02, 0.34], c: STEEL })
    }
    // a ring of braces at every step, and a diagonal across each face in between, zigzagging up
    for (let i = 0; i < STEPS; i++) {
      const y = (i + 1) * step
      const r = spread(y)
      for (const sz of [-1, 1]) out.push({ p: [0, y, sz * r], s: [r * 2, 0.16, 0.16], c: STEEL_DARK })
      for (const sx of [-1, 1]) out.push({ p: [sx * r, y, 0], s: [0.16, 0.16, r * 2], c: STEEL_DARK })
      const m = spread(y - step / 2)
      const tilt = Math.atan2(step, m * 2) * (i % 2 ? 1 : -1)
      const len = Math.hypot(step, m * 2)
      for (const sz of [-1, 1]) out.push({ p: [0, y - step / 2, sz * m], s: [len, 0.12, 0.12], c: STEEL_DARK, r: [0, 0, tilt] })
      for (const sx of [-1, 1]) out.push({ p: [sx * m, y - step / 2, 0], s: [0.12, 0.12, len], c: STEEL_DARK, r: [-tilt, 0, 0] })
    }
    // the pole above the lattice, up to the beacon, and the cable ladder up the middle
    out.push({ p: [0, (LATTICE_Y + POWER_TOWER.h) / 2, 0], s: [0.42, POWER_TOWER.h - LATTICE_Y, 0.42], c: STEEL })
    out.push({ p: [0, PLATFORMS[0][0] / 2, 0], s: [0.3, PLATFORMS[0][0], 0.3], c: CABLE })
    // antenna platforms: a square frame round the tower with tall white panels standing on each side
    for (const [y, half, n] of PLATFORMS) {
      for (const sz of [-1, 1]) out.push({ p: [0, y, sz * half], s: [half * 2 + 0.2, 0.2, 0.2], c: STEEL_DARK })
      for (const sx of [-1, 1]) out.push({ p: [sx * half, y, 0], s: [0.2, 0.2, half * 2 + 0.2], c: STEEL_DARK })
      for (let k = 0; k < n; k++) {
        const along = n === 1 ? 0 : (k / (n - 1) - 0.5) * half * 1.1
        for (const sz of [-1, 1]) out.push({ p: [along, y + 0.7, sz * (half + 0.22)], s: [0.52, 2.2, 0.22], c: PANEL })
        for (const sx of [-1, 1]) out.push({ p: [sx * (half + 0.22), y + 0.7, along], s: [0.22, 2.2, 0.52], c: PANEL })
      }
    }
    // the equipment cabinet beside the foot, its cables crossing on a bridge to the ladder
    out.push({ p: [-3.2, 1.1, 0], s: [1.3, 2.2, 2.4], c: CABINET })
    out.push({ p: [-2.53, 1.1, 0], s: [0.04, 1.8, 0.04], c: STEEL_DARK })
    out.push({ p: [-1.6, 2.35, 0], s: [3.2, 0.14, 0.5], c: CABLE })
    return out
  }, [])
  const click = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation()
    // a press that moved was a pan, not a click
    if (e.delta <= 5 && !still) onSelect()
  }
  const half = POWER_TOWER.w / 2
  return (
    <group position={[ax + POWER_TOWER.x, 0, az + POWER_TOWER.z]} onClick={click}
      onPointerOver={(e) => { e.stopPropagation(); onHover(true); document.body.style.cursor = still ? '' : 'pointer' }}
      onPointerOut={() => { onHover(false); document.body.style.cursor = '' }}>
      <Merged deps={[detail, steel]}>
      {/* a concrete pad, fenced at its corners */}
      <B p={[0, PAVE / 2, 0]} s={[POWER_TOWER.w, PAVE, POWER_TOWER.d]} c={PAD} />
      {detail && [-1, 1].flatMap((sx) => [-1, 1].map((sz) => (
        <B key={`${sx}${sz}`} p={[sx * (half - 0.26), 0.78, sz * (half - 0.26)]} s={[0.24, 1.56, 0.24]} c={FENCE} />
      )))}
      {detail && [-1, 1].map((sz) => <B key={`rail${sz}`} p={[0, 1.36, sz * (half - 0.26)]} s={[POWER_TOWER.w - 0.52, 0.1, 0.1]} c={FENCE} shadow={false} />)}
      {detail && [-1, 1].map((sx) => <B key={`side${sx}`} p={[sx * (half - 0.26), 1.36, 0]} s={[0.1, 0.1, POWER_TOWER.d - 0.52]} c={FENCE} shadow={false} />)}
      {steel.map((b, i) => <B key={i} {...b} />)}
      {DISHES.map(([y, face]) => <Dish key={y} y={y} face={face} />)}
      </Merged>
      <Beacon />
      {/* the lattice is mostly air: a box the size of the tower takes the pointer, unseen */}
      <mesh position={[0, POWER_TOWER.h / 2, 0]} scale={[POWER_TOWER.w, POWER_TOWER.h + 1, POWER_TOWER.d]} material={HIT}>
        <boxGeometry />
      </mesh>
      <Shade on={hover} />
    </group>
  )
}

/** A microwave dish on a leg, a short drum looking straight out of `face`. */
function Dish({ y, face }: { y: number; face: 'z' | 'x' }) {
  const out = spread(y) + 0.45
  const p: V3 = face === 'z' ? [0.5, y, out] : [-out, y, -0.5]
  const r: V3 = face === 'z' ? [PI / 2, 0, 0] : [0, 0, PI / 2]
  return (
    <mesh position={p} rotation={r} scale={[0.75, 0.45, 0.75]} material={toon(DISH)} castShadow receiveShadow>
      <cylinderGeometry args={[1, 1, 1, 12]} />
    </mesh>
  )
}

/** The red light on top: on after dark, blinking slowly unless motion is reduced. */
function Beacon() {
  const ref = useRef<THREE.Mesh>(null)
  const calm = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  useFrame(({ clock }) => {
    if (!ref.current || calm) return
    ref.current.visible = clock.elapsedTime % 2.4 < 1.6
  })
  return (
    <mesh ref={ref} position={[0, POWER_TOWER.h + 0.31, 0]} scale={[0.52, 0.52, 0.52]} material={toonGlow('#e5533a', '#ff6a55')} castShadow={false}>
      <boxGeometry />
    </mesh>
  )
}

/** A see-through grey box round the tower while the pointer is on it, as over the airport. */
function Shade({ on }: { on: boolean }) {
  const mat = useMemo(() => new THREE.MeshBasicMaterial({ color: '#1c1f2e', transparent: true, opacity: 0, depthWrite: false }), [])
  const mesh = useRef<THREE.Mesh>(null)
  useEffect(() => () => mat.dispose(), [mat])
  useLayoutEffect(() => mesh.current?.layers.set(NO_OUTLINE_LAYER), [])
  useFrame((_, dt) => {
    const to = on ? 0.5 : 0
    mat.opacity += Math.sign(to - mat.opacity) * Math.min(Math.abs(to - mat.opacity), 4 * dt)
    if (mesh.current) mesh.current.visible = mat.opacity > 0.001
  })
  return (
    <mesh ref={mesh} position={[0, (POWER_TOWER.h + 0.6) / 2, 0]} scale={[POWER_TOWER.w + 0.2, POWER_TOWER.h + 0.9, POWER_TOWER.d + 0.2]}
      material={mat} raycast={() => null} renderOrder={2}>
      <boxGeometry />
    </mesh>
  )
}
