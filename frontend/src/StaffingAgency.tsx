// The staffing agency (人力資源公司), drawn as a domed rotunda: a round stone plinth with steps up to it, a ring of
// columns round a cream drum, a patina-green dome with a lantern and a flag on top, and a giant name badge on a stand
// out front. Round where every company is a box, low where the power tower is tall, it reads as one of the island's
// own buildings (layout.ts `STAFFING`). Clicking it opens the agency's file, where its shared employees are kept.

import { type ThreeEvent } from '@react-three/fiber'
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { rectCenter, STAFFING, type Town } from './layout'
import { Merged } from './Merged'
import { NO_OUTLINE_LAYER } from './PixelPass'
import { toon, toonGlow } from './toon'

type V3 = [number, number, number]

const STONE = '#e3dccd'
const STONE_DARK = '#c8bfae'
const DRUM = '#f3ead6'
const DOME = '#5fa491'
const GOLD = '#e0b545'
const DOOR = '#5a4636'
const GLASS = '#7fa8c9'
const LIT = '#f2cf86'
const BADGE = '#fbfaf6'
const BADGE_BAND = '#d9544a'
const FACE = '#f1c9a5'
/** Takes clicks without being drawn. */
const HIT = new THREE.MeshBasicMaterial({ visible: false })

/** Plinth, columns, drum, attic and dome, from the ground up. */
const PLINTH = { r: 4.7, h: 0.6 }
const COLUMNS = { n: 12, r: 4.05, h: 3.6 }
const DRUM_R = 3.35
const CORNICE = { r: 4.45, h: 0.5 }
const ATTIC = { r: 3.0, h: 1.0 }
const DOME_R = 2.9

const top = PLINTH.h + COLUMNS.h
const domeBase = top + CORNICE.h + ATTIC.h

function Box({ p, s, c, r, glow }: { p: V3; s: V3; c: string; r?: V3; glow?: string }) {
  return (
    <mesh position={p} rotation={r} scale={s} material={glow ? toonGlow(c, glow) : toon(c)} castShadow receiveShadow>
      <boxGeometry />
    </mesh>
  )
}

function Drum({ p, r, h, c, segments = 24 }: { p: V3; r: number; h: number; c: string; segments?: number }) {
  return (
    <mesh position={p} material={toon(c)} castShadow receiveShadow>
      <cylinderGeometry args={[r, r, h, segments]} />
    </mesh>
  )
}

export function StaffingAgency({ town, hover, still, onHover, onSelect }: {
  town: Town
  /** Under the pointer, with nothing else open: shaded to show it can be clicked. */
  hover: boolean
  /** Editing the map: the agency can't be moved, so it takes no clicks. */
  still: boolean
  onHover: (on: boolean) => void
  onSelect: () => void
}) {
  const [ax, az] = rectCenter(town, town.airport)
  const columns = useMemo(() => Array.from({ length: COLUMNS.n }, (_, i) => {
    const a = (i / COLUMNS.n) * Math.PI * 2 + Math.PI / COLUMNS.n
    return [Math.sin(a) * COLUMNS.r, Math.cos(a) * COLUMNS.r] as const
  }), [])
  // windows round the drum, every other bay, the door bay facing the town (+z) left open
  const windows = useMemo(() => Array.from({ length: 6 }, (_, i) => (i / 6) * Math.PI * 2 + Math.PI / 6), [])
  const click = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation()
    // a press that moved was a pan, not a click
    if (e.delta <= 5 && !still) onSelect()
  }
  return (
    <group position={[ax + STAFFING.x, 0, az + STAFFING.z]} onClick={click}
      onPointerOver={(e) => { e.stopPropagation(); onHover(true); document.body.style.cursor = still ? '' : 'pointer' }}
      onPointerOut={() => { onHover(false); document.body.style.cursor = '' }}>
      <Merged deps={[columns, windows]}>
        {/* the plinth, and three steps up to the door on the town side */}
        <Drum p={[0, PLINTH.h / 2, 0]} r={PLINTH.r} h={PLINTH.h} c={STONE_DARK} segments={32} />
        {[0, 1, 2].map((i) => (
          <Box key={`step${i}`} p={[0, PLINTH.h * (i + 0.5) / 3, PLINTH.r + 0.55 - i * 0.35]} s={[3.2, PLINTH.h * (i + 1) / 3, 0.4]} c={STONE} />
        ))}
        {/* the drum and the ring of columns round it */}
        <Drum p={[0, PLINTH.h + COLUMNS.h / 2, 0]} r={DRUM_R} h={COLUMNS.h} c={DRUM} />
        {columns.map(([x, z], i) => (
          <group key={`col${i}`} position={[x, 0, z]}>
            <Box p={[0, PLINTH.h + 0.12, 0]} s={[0.7, 0.24, 0.7]} c={STONE_DARK} />
            <Drum p={[0, PLINTH.h + COLUMNS.h / 2, 0]} r={0.24} h={COLUMNS.h - 0.2} c={STONE} segments={10} />
            <Box p={[0, top - 0.12, 0]} s={[0.66, 0.24, 0.66]} c={STONE_DARK} />
          </group>
        ))}
        {/* the cornice over the columns, the attic above it with a gold band, and the dome */}
        <Drum p={[0, top + CORNICE.h / 2, 0]} r={CORNICE.r} h={CORNICE.h} c={STONE} segments={32} />
        <Drum p={[0, top + CORNICE.h + ATTIC.h / 2, 0]} r={ATTIC.r} h={ATTIC.h} c={DRUM} />
        <Drum p={[0, top + CORNICE.h + ATTIC.h - 0.08, 0]} r={ATTIC.r + 0.06} h={0.16} c={GOLD} />
        <mesh position={[0, domeBase, 0]} material={toon(DOME)} castShadow receiveShadow>
          <sphereGeometry args={[DOME_R, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2]} />
        </mesh>
        {/* the lantern on the dome, and a flagpole out of it */}
        <Drum p={[0, domeBase + DOME_R + 0.3, 0]} r={0.55} h={0.6} c={DRUM} segments={12} />
        <Drum p={[0, domeBase + DOME_R + 0.68, 0]} r={0.7} h={0.16} c={GOLD} segments={12} />
        <Box p={[0, domeBase + DOME_R + 1.6, 0]} s={[0.1, 1.8, 0.1]} c={STONE_DARK} />
        {/* the door and the windows */}
        <Box p={[0, PLINTH.h + 1.2, DRUM_R - 0.05]} s={[1.3, 2.4, 0.14]} c={DOOR} />
        <Box p={[0, PLINTH.h + 2.55, DRUM_R - 0.02]} s={[1.6, 0.18, 0.18]} c={GOLD} />
        {windows.map((a) => (
          <Box key={`win${a}`} p={[Math.sin(a) * (DRUM_R - 0.02), PLINTH.h + 2.1, Math.cos(a) * (DRUM_R - 0.02)]} s={[0.8, 1.3, 0.12]} r={[0, a, 0]} c={GLASS} glow={LIT} />
        ))}
        {/* the name badge on its stand beside the steps: a card on a lanyard, a face and lines of a name */}
        <group position={[3.4, 0, PLINTH.r + 1.1]} rotation={[0, -0.35, 0]}>
          <Box p={[-0.7, 1.0, 0]} s={[0.14, 2.0, 0.14]} c={STONE_DARK} />
          <Box p={[0.7, 1.0, 0]} s={[0.14, 2.0, 0.14]} c={STONE_DARK} />
          <Box p={[0, 2.4, 0]} s={[1.9, 2.4, 0.16]} c={BADGE} />
          <Box p={[0, 3.35, 0.02]} s={[1.9, 0.5, 0.16]} c={BADGE_BAND} />
          <Box p={[0, 3.9, 0]} s={[0.12, 0.6, 0.06]} c={BADGE_BAND} />
          <Box p={[-0.45, 2.45, 0.09]} s={[0.6, 0.7, 0.04]} c={FACE} />
          <Box p={[0.4, 2.62, 0.09]} s={[0.7, 0.14, 0.04]} c={DOOR} />
          <Box p={[0.35, 2.3, 0.09]} s={[0.6, 0.12, 0.04]} c={STONE_DARK} />
          <Box p={[0, 1.6, 0.09]} s={[1.4, 0.12, 0.04]} c={STONE_DARK} />
        </group>
      </Merged>
      <Flag y={domeBase + DOME_R + 2.2} />
      {/* the columns are mostly air: a box the size of the rotunda takes the pointer, unseen */}
      <mesh position={[0, STAFFING.h / 2, 0.5]} scale={[STAFFING.w, STAFFING.h, STAFFING.d + 1]} material={HIT}>
        <boxGeometry />
      </mesh>
      <Shade on={hover} />
    </group>
  )
}

/** The flag on the dome, waving a little unless motion is reduced. */
function Flag({ y }: { y: number }) {
  const ref = useRef<THREE.Group>(null)
  const calm = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  useFrame(({ clock }) => {
    if (!ref.current || calm) return
    ref.current.rotation.y = Math.sin(clock.elapsedTime * 1.6) * 0.18
  })
  // it swings about the pole, so the cloth hangs off to one side of it
  return (
    <group ref={ref} position={[0, y, 0]}>
      <mesh position={[0.7, 0, 0]} material={toon(BADGE_BAND)} castShadow>
        <boxGeometry args={[1.3, 0.75, 0.06]} />
      </mesh>
    </group>
  )
}

/** A see-through grey box round the rotunda while the pointer is on it, as over the power tower. */
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
    <mesh ref={mesh} position={[0, STAFFING.h / 2, 0.5]} scale={[STAFFING.w + 0.2, STAFFING.h + 0.4, STAFFING.d + 1.2]}
      material={mat} raycast={() => null} renderOrder={2}>
      <boxGeometry />
    </mesh>
  )
}
