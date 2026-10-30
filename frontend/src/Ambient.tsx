// Background life: cloud shadows sweeping over the town, low clouds drifting past, and now and then a plane
// passing high overhead.

import { useFrame } from '@react-three/fiber'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { Plane } from './Airport'
import { Fade } from './Fade'
import { CELL, hash, type Town } from './layout'
import { NO_OUTLINE_LAYER } from './PixelPass'
import { fadingShadow } from './shadowFade'
import { toon } from './toon'

/** Which way the wind blows the clouds (x, z). */
const WIND = new THREE.Vector2(0.8, -0.6).normalize()

// ---------------------------------------------------------------- clouds

/** Writes neither colour nor depth: the mesh still casts a shadow, but is never seen. */
const hidden = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false })

/** Half the side of the sun's shadow box for a town of this size; shadows exist only inside it. */
export const shadowHalf = (span: number) => span * 0.9 + 6
/** Cloud height; their shadows land this far downwind of them, along the sunlight. */
const CLOUD_Y = 26

/**
 * Big flat clouds high above: only their shadows show, sweeping across the town. A cloud turns round far
 * outside the shadow box, so its shadow always slides in and out of view instead of popping.
 */
function CloudShadows({ reach, calm }: { reach: number; calm: boolean }) {
  const ref = useRef<THREE.Group>(null)
  const clouds = useMemo(() => Array.from({ length: 8 }, (_, i) => ({
    x: (hash(i, 1) - 0.5) * reach * 2,
    z: (hash(i, 2) - 0.5) * reach * 2,
    speed: 0.9 + hash(i, 3) * 0.8,
    parts: Array.from({ length: 3 + Math.floor(hash(i, 4) * 3) }, (_, k) => ({
      p: [(hash(i, k, 5) - 0.5) * 7, 0, (hash(i, k, 6) - 0.5) * 5] as [number, number, number],
      s: [3 + hash(i, k, 7) * 4, 0.5, 2.5 + hash(i, k, 8) * 3] as [number, number, number],
    })),
  })), [reach])
  useLayoutEffect(() => ref.current?.traverse((o) => o.layers.set(NO_OUTLINE_LAYER)), [clouds])
  useFrame((_, dt) => {
    if (calm || !ref.current) return
    ref.current.children.forEach((g, i) => {
      g.position.x += WIND.x * clouds[i].speed * dt
      g.position.z += WIND.y * clouds[i].speed * dt
      // leave on the downwind side, come back on the upwind side
      if (g.position.x > reach) g.position.x -= reach * 2
      if (g.position.z < -reach) g.position.z += reach * 2
    })
  })
  return (
    <group ref={ref}>
      {clouds.map((c, i) => (
        <group key={i} position={[c.x, CLOUD_Y, c.z]}>
          {c.parts.map((part, k) => <mesh key={k} position={part.p} scale={part.s} material={hidden} castShadow><boxGeometry /></mesh>)}
        </group>
      ))}
    </group>
  )
}

/** Low clouds fade in and out over this far at each end of their lane. */
const LANE_FADE = 14

/**
 * A few puffy low clouds drifting downwind past the island, on lanes either side of it so they never pass
 * through a building. Each crosses its lane at its own speed, fading in at the upwind end and out at the
 * downwind end, then starts again.
 */
function LowClouds({ ring, calm }: { ring: number; calm: boolean }) {
  const ref = useRef<THREE.Group>(null)
  // half the lane length: well past the island whichever way it is seen
  const half = ring + 40
  const puffs = useMemo(() => Array.from({ length: 4 }, (_, i) => {
    // a wide flat base, a smaller crown on top, each puff with its own see-through materials
    const base = toon('#e6edf4').clone()
    const crown = toon('#ffffff').clone()
    for (const m of [base, crown]) m.transparent = true
    // sized in whole cells: the smallest is 3 × 2 cells and one cell high; bigger ones get a crown on top
    const parts: Array<{ p: [number, number, number]; s: [number, number, number]; m: THREE.Material }> = []
    const len = 3 + Math.floor(hash(i, 15) * 4)
    const wide = 2 + Math.floor(hash(i, 14) * 2)
    parts.push({ p: [0, 0, 0], s: [len * CELL, CELL, wide * CELL], m: base })
    // a lump off one side breaks up the box
    if (len >= 4) parts.push({ p: [(hash(i, 13) - 0.5) * (len - 2) * CELL, 0, (wide / 2 + 0.5) * CELL], s: [2 * CELL, CELL, CELL], m: base })
    if (len >= 4) parts.push({ p: [(hash(i, 16) - 0.5) * CELL, CELL, 0], s: [(len - 2) * CELL, CELL, (wide - 1) * CELL], m: crown })
    return {
      // alternate sides of the island, clear of the coast
      side: (i % 2 ? 1 : -1) * (ring + 12 + hash(i, 10) * 10),
      start: hash(i, 9) * half * 2,
      speed: 0.6 + hash(i, 12) * 0.9,
      y: CELL * (2 + Math.floor(hash(i, 11) * 2)),
      parts,
      mats: [base, crown],
      // the shadow fades with the cloud
      shade: fadingShadow(),
    }
  }), [ring, half])
  useEffect(() => () => puffs.forEach((c) => [...c.mats, c.shade.material].forEach((m) => m.dispose())), [puffs])
  useFrame(({ clock }) => {
    if (!ref.current) return
    const t = calm ? 0 : clock.elapsedTime
    ref.current.children.forEach((g, i) => {
      const c = puffs[i]
      // distance along the wind, from -half to half
      const along = ((c.start + t * c.speed) % (half * 2)) - half
      g.position.set(WIND.x * along - WIND.y * c.side, c.y, WIND.y * along + WIND.x * c.side)
      const k = THREE.MathUtils.clamp(Math.min(along + half, half - along) / LANE_FADE, 0, 1)
      for (const m of c.mats) {
        m.opacity = k
        m.depthWrite = k === 1
      }
      g.visible = k > 0
      // out of the outline pass while see-through, like everything else that fades
      g.traverse((o) => o.layers.set(k === 1 ? 0 : NO_OUTLINE_LAYER))
      c.shade.set(k)
    })
  })
  return (
    <group ref={ref}>
      {puffs.map((c, i) => (
        <group key={i}>
          {c.parts.map((part, k) => <mesh key={k} position={part.p} scale={part.s} material={part.m} customDepthMaterial={c.shade.material} castShadow receiveShadow><boxGeometry /></mesh>)}
        </group>
      ))}
    </group>
  )
}

// ---------------------------------------------------------------- planes passing over

/** Airlines' colours, body and tail, for planes passing over. */
const LIVERIES: Array<[string, string]> = [
  ['#f4f4f0', '#d22b1f'], ['#f4f4f0', '#2f8f8a'], ['#e8eef5', '#e5b33a'], ['#f4f4f0', '#8a5aa8'], ['#3b5670', '#e5b33a'], ['#f1e8da', '#c8643f'],
]

interface Pass {
  /** Seconds since the pass began. */
  t: number
  /** Which way it flies, radians about y from +x, and how far to one side of the island's middle. */
  way: number
  side: number
  y: number
  speed: number
  livery: [string, string]
}

const between = (a: number, b: number) => a + Math.random() * (b - a)

/**
 * Now and then a plane flies straight across, high above the island and its airport, from far out to sea on
 * one side to the other, in any direction; it never lands. One at a time, with a long quiet spell between.
 * None with reduced motion.
 */
function Overflights({ ring }: { ring: number }) {
  const ref = useRef<THREE.Group>(null)
  // seconds until the next pass; the first comes soon after the page opens
  const wait = useRef(between(8, 20))
  const [pass, setPass] = useState<Pass | null>(null)
  const [shown, setShown] = useState(false)
  // seen only this close to the island's middle, so it fades in and out well out to sea
  const seen = ring + 30
  const half = seen + 40
  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1)
    if (!pass) {
      wait.current -= dt
      if (wait.current <= 0) {
        setPass({ t: 0, way: between(0, Math.PI * 2), side: between(-0.4, 0.4) * ring, y: between(40, 48), speed: between(16, 22), livery: LIVERIES[Math.floor(Math.random() * LIVERIES.length)] })
      }
      return
    }
    pass.t += dt
    const along = pass.t * pass.speed - half
    if (along > half) {
      setPass(null)
      setShown(false)
      wait.current = between(25, 60)
      return
    }
    const [dx, dz] = [Math.cos(pass.way), Math.sin(pass.way)]
    ref.current?.position.set(dx * along - dz * pass.side, pass.y, dz * along + dx * pass.side)
    const on = Math.abs(along) < seen
    if (on !== shown) setShown(on)
  })
  if (!pass) return null
  return (
    // the plane's nose is along +x; turning by -way points it along (cos way, sin way)
    <group ref={ref} rotation={[0, -pass.way, 0]} position={[0, pass.y, 0]} visible>
      <Fade show={shown}><Plane body={pass.livery[0]} tail={pass.livery[1]} gear={false} /></Fade>
    </group>
  )
}

export function Ambient({ town, calm, clouds, planes }: { town: Town; calm: boolean; clouds: boolean; planes: boolean }) {
  // corners of the grid are the farthest land can reach
  const ring = Math.hypot(town.cols, town.rows) / 2 * CELL
  return (
    <>
      {/* box corners, plus the shadow's offset from its cloud, plus the cloud's own size */}
      {clouds && <CloudShadows reach={shadowHalf(town.span) * Math.SQRT2 + CLOUD_Y + 8} calm={calm} />}
      {clouds && <LowClouds ring={ring} calm={calm} />}
      {!calm && planes && <Overflights ring={ring} />}
    </>
  )
}
