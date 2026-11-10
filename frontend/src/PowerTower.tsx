// The power tower (電塔): a steel lattice pylon on a fenced pad in the airfield's far corner (layout.ts `POWER_TOWER`).
// Its cross-arms carry insulator strings, and a beacon on top blinks after dark. Clicking it opens the tower's
// panel, where this computer is paired with others and goes to their islands.

import { useFrame, type ThreeEvent } from '@react-three/fiber'
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { POWER_TOWER, rectCenter, type Town } from './layout'
import { NO_OUTLINE_LAYER } from './PixelPass'
import { usePrefs } from './prefs'
import { toon, toonGlow } from './toon'

type V3 = [number, number, number]

function B({ p, s, c, shadow = true, glow }: { p: V3; s: V3; c: string; shadow?: boolean; glow?: string }) {
  return (
    <mesh position={p} scale={s} material={glow ? toonGlow(c, glow) : toon(c)} castShadow={shadow} receiveShadow>
      <boxGeometry />
    </mesh>
  )
}

const STEEL = '#9aa2ae'
const STEEL_DARK = '#6b7280'
const PAD = '#c4c0cc'
const INSULATOR = '#3a3f4a'
const FENCE = '#7d8590'
/** Takes clicks without being drawn. */
const HIT = new THREE.MeshBasicMaterial({ visible: false })
/** Top of the paving, as on the airfield. */
const PAVE = 0.08

/** Half the leg spread at the foot and at the waist, where the legs meet the mast, and the waist's height. */
const FOOT = 3
const WAIST = 0.9
const WAIST_Y = 14.3
/** Steps each leg climbs in, inward as it goes up: a voxel taper. */
const STEPS = 8
/** The cross-arms: height and half span. */
const ARMS: Array<[number, number]> = [[12.2, 4.4], [16.4, 3.5]]

/** Where a leg is at height y: from the foot's spread in to the waist's. */
const spread = (y: number) => FOOT + (WAIST - FOOT) * Math.min(1, y / WAIST_Y)

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
    const out: Array<{ p: V3; s: V3; c: string }> = []
    const step = WAIST_Y / STEPS
    // four legs, each a stack of short posts stepping in towards the mast
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (let i = 0; i < STEPS; i++) {
      const y = i * step
      const r = spread(y + step / 2)
      out.push({ p: [sx * r, y + step / 2, sz * r], s: [0.44, step + 0.02, 0.44], c: STEEL })
    }
    // braces round all four sides every other step, and a diagonal-ish pair of struts between them
    for (let i = 1; i < STEPS; i += 2) {
      const y = i * step
      const r = spread(y)
      for (const sz of [-1, 1]) out.push({ p: [0, y, sz * r], s: [r * 2, 0.2, 0.2], c: STEEL_DARK })
      for (const sx of [-1, 1]) out.push({ p: [sx * r, y, 0], s: [0.2, 0.2, r * 2], c: STEEL_DARK })
    }
    // the mast above the waist, up to the beacon
    out.push({ p: [0, (WAIST_Y + POWER_TOWER.h) / 2, 0], s: [0.9, POWER_TOWER.h - WAIST_Y, 0.9], c: STEEL })
    // cross-arms, along x, with an insulator string hanging off each end
    for (const [y, half] of ARMS) {
      out.push({ p: [0, y, 0], s: [half * 2, 0.4, 0.55], c: STEEL })
      for (const side of [-1, 1]) out.push({ p: [side * (half - 0.32), y - 0.98, 0], s: [0.26, 1.56, 0.26], c: INSULATOR })
    }
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
      {/* a concrete pad, fenced at its corners */}
      <B p={[0, PAVE / 2, 0]} s={[POWER_TOWER.w, PAVE, POWER_TOWER.d]} c={PAD} />
      {detail && [-1, 1].flatMap((sx) => [-1, 1].map((sz) => (
        <B key={`${sx}${sz}`} p={[sx * (half - 0.26), 0.78, sz * (half - 0.26)]} s={[0.24, 1.56, 0.24]} c={FENCE} />
      )))}
      {detail && [-1, 1].map((sz) => <B key={`rail${sz}`} p={[0, 1.36, sz * (half - 0.26)]} s={[POWER_TOWER.w - 0.52, 0.1, 0.1]} c={FENCE} shadow={false} />)}
      {detail && [-1, 1].map((sx) => <B key={`side${sx}`} p={[sx * (half - 0.26), 1.36, 0]} s={[0.1, 0.1, POWER_TOWER.d - 0.52]} c={FENCE} shadow={false} />)}
      {steel.map((b, i) => <B key={i} {...b} />)}
      <Beacon />
      {/* the lattice is mostly air: a box the size of the tower takes the pointer, unseen */}
      <mesh position={[0, POWER_TOWER.h / 2, 0]} scale={[POWER_TOWER.w, POWER_TOWER.h + 1, POWER_TOWER.d]} material={HIT}>
        <boxGeometry />
      </mesh>
      <Shade on={hover} />
    </group>
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
