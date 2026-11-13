// The staffing agency (移民署), drawn as a domed rotunda: a round stone plinth with steps up to it, a ring of
// columns round a cream drum, a patina-green dome with a lantern and a flag on top, and a giant name badge on a stand
// out front. Round where every company is a box, low where the power tower is tall, it reads as one of the island's
// own buildings, on its paved ground past the airport's east end (layout.ts `STAFFING_LOT`). Clicking it, or anywhere
// on its paving, opens the agency's file, where its shared employees are kept.
// Its paving is dressed (staffingGrounds.ts `GROUNDS`): a flower bed round the plinth, a path out to the town with a lamp
// each side, a shuttle stop with luggage on the airport side, a row of flags down the far side and planters in the
// corners. All of it stays low, clear of the runway's line, and people walk round it.

import { type ThreeEvent } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { CELL, rectCenter, STAFFING, type Town } from './layout'
import { HoverShade } from './HoverShade'
import { Merged, mergeParts } from './Merged'
import { usePrefs } from './prefs'
import { BED, GROUNDS, HALF_LOT, PLINTH, STEPS_HALF, type Footprint } from './staffingGrounds'
import { LANTERN } from './streetProps'
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
const IRON = '#3c4253'
const WOOD_SEAT = '#a8774e'
const SOIL = '#6b4a33'
const TROUGH = '#b9b1a3'
const SHUTTLE = '#3d7cc9'
const LEAVES = ['#4fa848', '#62b955']
const BLOOMS = ['#ff8a5c', '#ffd34a', '#f0f0f8', '#e56a9a']
/** Takes clicks without being drawn. */
const HIT = new THREE.MeshBasicMaterial({ visible: false })

/** Columns, drum, attic and dome, from the plinth up. */
const COLUMNS = { n: 12, r: 4.05, h: 3.6 }
const DRUM_R = 3.35
const CORNICE = { r: 4.45, h: 0.5 }
const ATTIC = { r: 3.0, h: 1.0 }
const DOME_R = 2.9

const top = PLINTH.h + COLUMNS.h
const domeBase = top + CORNICE.h + ATTIC.h

const FLAG_COLORS = [BADGE_BAND, GOLD, DOME, SHUTTLE]
const FLAG_TOP = 4.8

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
  const [cx, cz] = rectCenter(town, town.staffing)
  const detail = usePrefs((s) => s.detail)
  const boxes = useMemo(() => hitBoxes(detail), [detail])
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
    <group position={[cx, 0, cz]} onClick={click}
      onPointerOver={(e) => { e.stopPropagation(); onHover(true); document.body.style.cursor = still ? '' : 'pointer' }}
      onPointerOut={() => { onHover(false); document.body.style.cursor = '' }}>
      <Merged deps={[columns, windows, detail]}>
        {/* the plinth, and three steps up to the door on the town side */}
        <Drum p={[0, PLINTH.h / 2, 0]} r={PLINTH.r} h={PLINTH.h} c={STONE_DARK} segments={32} />
        {[0, 1, 2].map((i) => (
          <Box key={`step${i}`} p={[0, PLINTH.h * (i + 0.5) / 3, PLINTH.r + 0.55 - i * 0.35]} s={[2 * STEPS_HALF, PLINTH.h * (i + 1) / 3, 0.4]} c={STONE} />
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
        <Grounds detail={detail} />
      </Merged>
      <Flag at={[0, domeBase + DOME_R + 2.2, 0]} />
      {GROUNDS.flags.map((f, i) => (
        <Flag key={`flag${i}`} at={[f.x, FLAG_TOP - 0.5, f.z]} color={FLAG_COLORS[i % FLAG_COLORS.length]} phase={i * 1.3} />
      ))}
      {/* the columns are mostly air: boxes over the rotunda, its paving and what stands on it take the pointer, unseen */}
      <Hit boxes={boxes} />
      <HoverShade on={hover} floor={LOT_FLOOR} />
    </group>
  )
}

/** What stands on the paving (`GROUNDS`); less detail drops the lamps and the flowers, as on a company's plot. */
function Grounds({ detail }: { detail: boolean }) {
  const { path, lamps, shelter, sign, luggage, flags, planters } = GROUNDS
  const kerb = 0.24
  return <>
    {/* the path out to the town, a shade lighter than the paving, with darker kerbs */}
    <Box p={[path.x, 0.1, path.z]} s={[path.w - 2 * kerb, 0.06, path.d]} c={STONE} />
    {[-1, 1].map((t) => (
      <Box key={`kerb${t}`} p={[path.x + t * (path.w - kerb) / 2, 0.11, path.z]} s={[kerb, 0.1, path.d]} c={STONE_DARK} />
    ))}
    <Bed detail={detail} />
    {detail && lamps.map((l, i) => <Lamp key={`lamp${i}`} x={l.x} z={l.z} />)}
    {planters.map((p, i) => <Planter key={`planter${i}`} f={p} detail={detail} />)}
    <Shelter f={shelter} />
    <StopSign f={sign} />
    <Luggage f={luggage} />
    {/* the flagpoles; the cloths wave, so they're drawn apart */}
    {flags.map((f, i) => (
      <group key={`pole${i}`} position={[f.x, 0, f.z]}>
        <Box p={[0, 0.18, 0]} s={[0.4, 0.2, 0.4]} c={STONE_DARK} />
        <Drum p={[0, FLAG_TOP / 2, 0]} r={0.07} h={FLAG_TOP} c={STONE_DARK} segments={8} />
        <Box p={[0, FLAG_TOP + 0.1, 0]} s={[0.2, 0.2, 0.2]} c={GOLD} />
      </group>
    ))}
  </>
}

/** A low stone-edged bed of hedge tufts round the plinth, flowers among them, open in front of the steps. */
function Bed({ detail }: { detail: boolean }) {
  const { r0, r1, gap } = BED
  const span = Math.PI * 2 - 2 * gap
  const mid = (r0 + r1) / 2 + 0.05
  const tufts = useMemo(() => Array.from({ length: 30 }, (_, i) => gap + (span * (i + 0.5)) / 30), [gap, span])
  return <>
    {/* a ring of stone filled with soil; the plinth hides their inner edge, and a slab closes each end */}
    <mesh position={[0, 0.25, 0]} material={toon(STONE_DARK)} castShadow receiveShadow>
      <cylinderGeometry args={[r1, r1, 0.5, 40, 1, false, gap, span]} />
    </mesh>
    <mesh position={[0, 0.26, 0]} material={toon(SOIL)} receiveShadow>
      <cylinderGeometry args={[r1 - 0.15, r1 - 0.15, 0.52, 40, 1, false, gap, span]} />
    </mesh>
    {[gap + 0.01, -gap - 0.01].map((a) => (
      <Box key={`end${a}`} p={[Math.sin(a) * (r0 + r1) / 2, 0.25, Math.cos(a) * (r0 + r1) / 2]} s={[0.12, 0.5, r1 - r0]} r={[0, a, 0]} c={STONE_DARK} />
    ))}
    {tufts.map((a, i) => (
      <Box key={`tuft${i}`} p={[Math.sin(a) * mid, 0.72, Math.cos(a) * mid]} s={[0.86, 0.42, 0.6]} r={[0, a, 0]} c={LEAVES[i % 2]} />
    ))}
    {detail && tufts.filter((_, i) => i % 3 !== 1).map((a, i) => (
      <Box key={`bloom${i}`} p={[Math.sin(a) * mid, 0.98, Math.cos(a) * mid]} s={[0.22, 0.14, 0.22]} r={[0, a, 0]} c={BLOOMS[i % BLOOMS.length]} />
    ))}
  </>
}

/** A lamp post as on a company's plot, its lantern lit after dark. */
function Lamp({ x, z }: { x: number; z: number }) {
  const h = 1.75 * CELL
  return <>
    <Box p={[x, 0.2, z]} s={[0.5, 0.24, 0.5]} c={IRON} />
    <Box p={[x, h / 2, z]} s={[0.16, h, 0.16]} c={IRON} />
    <Box p={[x, h + 0.2, z]} s={[0.46, 0.4, 0.46]} c="#ffe7a3" glow={LANTERN} />
    <Box p={[x, h + 0.45, z]} s={[0.56, 0.1, 0.56]} c={IRON} />
  </>
}

/** A stone trough of hedge tufts along its longer side, with a few flowers. */
function Planter({ f, detail }: { f: Footprint; detail: boolean }) {
  const alongX = f.w >= f.d
  const long = alongX ? f.w : f.d
  const short = alongX ? f.d : f.w
  const n = Math.max(1, Math.round(long / 1.2))
  const step = long / n
  return <>
    <Box p={[f.x, 0.38, f.z]} s={[f.w, 0.6, f.d]} c={TROUGH} />
    <Box p={[f.x, 0.69, f.z]} s={[f.w - 0.24, 0.02, f.d - 0.24]} c={SOIL} />
    {Array.from({ length: n }, (_, k) => {
      const t = (k - (n - 1) / 2) * step
      const [x, z] = alongX ? [f.x + t, f.z] : [f.x, f.z + t]
      const s: V3 = alongX ? [step - 0.2, 0.6, short - 0.6] : [short - 0.6, 0.6, step - 0.2]
      return <group key={k}>
        <Box p={[x, 1.0, z]} s={s} c={LEAVES[k % 2]} />
        {detail && k % 2 === 0 && <Box p={[x + 0.15, 1.36, z - 0.1]} s={[0.22, 0.14, 0.22]} c={BLOOMS[(k + n) % BLOOMS.length]} />}
      </group>
    })}
  </>
}

/** A shuttle shelter open to the town: glass at the back and the airport end, a blue roof, a bench inside. */
function Shelter({ f }: { f: Footprint }) {
  const hw = 1.7, hd = 0.65
  return (
    <group position={[f.x, 0, f.z]}>
      {[-hw, hw].flatMap((x) => [-hd, hd].map((z) => <Box key={`post${x}${z}`} p={[x, 1.25, z]} s={[0.12, 2.5, 0.12]} c={IRON} />))}
      <Box p={[0, 1.3, -hd]} s={[2 * hw, 1.7, 0.06]} c={GLASS} />
      <Box p={[-hw, 1.3, 0]} s={[0.06, 1.7, 2 * hd]} c={GLASS} />
      <Box p={[0, 2.58, 0]} s={[f.w, 0.16, f.d]} c={SHUTTLE} />
      {[-1.1, 1.1].map((x) => <Box key={`foot${x}`} p={[x, 0.25, -0.3]} s={[0.12, 0.45, 0.4]} c={IRON} />)}
      <Box p={[0, 0.5, -0.3]} s={[2.6, 0.12, 0.5]} c={WOOD_SEAT} />
    </group>
  )
}

/** The shuttle stop's sign: a round blue plate with a white bar, facing the town. */
function StopSign({ f }: { f: Footprint }) {
  return (
    <group position={[f.x, 0, f.z]}>
      <Box p={[0, 0.12, 0]} s={[0.4, 0.16, 0.4]} c={IRON} />
      <Box p={[0, 1.4, 0]} s={[0.12, 2.8, 0.12]} c={IRON} />
      <mesh position={[0, 2.9, 0.08]} rotation={[Math.PI / 2, 0, 0]} material={toon(SHUTTLE)} castShadow>
        <cylinderGeometry args={[0.5, 0.5, 0.08, 16]} />
      </mesh>
      <Box p={[0, 2.9, 0.14]} s={[0.6, 0.16, 0.04]} c={BADGE} />
    </group>
  )
}

/** Two suitcases waiting by the stop: a tall red one and a smaller gold one, each with its handle. */
function Luggage({ f }: { f: Footprint }) {
  return (
    <group position={[f.x, 0, f.z]}>
      <Box p={[-0.45, 0.58, 0]} s={[0.8, 1.0, 0.4]} c={BADGE_BAND} />
      <Box p={[-0.45, 1.13, 0]} s={[0.36, 0.1, 0.1]} c={IRON} />
      <Box p={[0.45, 0.43, 0.05]} s={[0.7, 0.7, 0.36]} r={[0, -0.3, 0]} c={GOLD} />
      <Box p={[0.45, 0.83, 0.05]} s={[0.3, 0.1, 0.1]} r={[0, -0.3, 0]} c={IRON} />
    </group>
  )
}

/** A flag waving a little about its pole, unless motion is reduced. */
function Flag({ at, color = BADGE_BAND, phase = 0 }: { at: V3; color?: string; phase?: number }) {
  const ref = useRef<THREE.Group>(null)
  const calm = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  useFrame(({ clock }) => {
    if (!ref.current || calm) return
    ref.current.rotation.y = Math.sin(clock.elapsedTime * 1.6 + phase) * 0.18
  })
  // it swings about the pole, so the cloth hangs off to one side of it
  return (
    <group ref={ref} position={at}>
      <mesh position={[0.7, 0, 0]} material={toon(color)} castShadow>
        <boxGeometry args={[1.3, 0.75, 0.06]} />
      </mesh>
    </group>
  )
}

/** The rotunda with its bed, steps and badge, in world units about its middle: the tall one of `hitBoxes`. */
export const ROTUNDA = { x0: -5.85, x1: 5.85, z0: -5.85, z1: 6.3, h: STAFFING.h + 0.4 }
/** How thick the layer taking the pointer over the paving is: over the path and its kerbs too. */
const LAYER = 0.2

/** A box from its corners, as [centre, size]. */
const span = (x0: number, x1: number, z0: number, z1: number, h: number): [V3, V3] => [[(x0 + x1) / 2, h / 2, (z0 + z1) / 2], [x1 - x0, h, z1 - z0]]
/** A thing on the paving `h` tall, a hair bigger all round. */
const over = (f: Footprint, h: number) => span(f.x - f.w / 2 - 0.02, f.x + f.w / 2 + 0.02, f.z - f.d / 2 - 0.02, f.z + f.d / 2 + 0.02, h + 0.02)

/**
 * What takes the pointer, as [centre, size] boxes about the rotunda's middle, as a company's (`Building.tsx`
 * `plotBoxes`): one box over the rotunda, thin layers over the paving round it, and a box over each thing standing on
 * it; less detail has no lamps to point at.
 */
export function hitBoxes(detail: boolean): Array<[V3, V3]> {
  const { x0, x1, z0, z1, h } = ROTUNDA
  const L = HALF_LOT
  const { lamps, shelter, sign, luggage, flags, planters } = GROUNDS
  return [
    span(x0, x1, z0, z1, h),
    span(-L, L, -L, z0, LAYER), span(-L, L, z1, L, LAYER), span(-L, x0, z0, z1, LAYER), span(x1, L, z0, z1, LAYER),
    ...(detail ? lamps.map((f) => over({ ...f, w: 0.56, d: 0.56 }, 1.75 * CELL + 0.5)) : []),
    over(shelter, 2.66),
    // the round plate is wider than the post, a touch towards the town
    over({ ...sign, w: 1.0, z: sign.z + 0.06, d: 0.62 }, 3.4),
    over(luggage, 1.18),
    // the pole, and the cloth swinging off it towards +x
    ...flags.map((f) => span(f.x - 0.22, f.x + 1.42, f.z - 0.3, f.z + 0.3, FLAG_TOP + 0.22)),
    ...planters.map((f) => over(f, 1.45)),
  ]
}

/** `hitBoxes` as one mesh, never drawn: three's raycaster finds hidden meshes all the same. */
function Hit({ boxes }: { boxes: Array<[V3, V3]> }) {
  const geometry = useMemo(() => mergeParts(boxes.map(([p, s]) => ({
    geometry: UNIT_BOX, matrix: new THREE.Matrix4().compose(new THREE.Vector3(...p), new THREE.Quaternion(), new THREE.Vector3(...s)),
  }))), [boxes])
  useEffect(() => () => geometry.dispose(), [geometry])
  return <mesh geometry={geometry} material={HIT} />
}
const UNIT_BOX = new THREE.BoxGeometry()

/** The paving, for the hover shade's layer over it. */
const LOT_FLOOR = { x: 0, z: 0, w: 2 * HALF_LOT, d: 2 * HALF_LOT }
