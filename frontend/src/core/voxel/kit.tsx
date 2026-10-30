// Voxel primitives drawn from code. Every prop, building and character is made of boxes.

import { useFrame, type ThreeEvent } from '@react-three/fiber'
import { forwardRef, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react'
import * as THREE from 'three'

export type V3 = [number, number, number]
export type V2 = [number, number]

export const UNIT = new THREE.BoxGeometry(1, 1, 1)
const mats = new Map<string, THREE.Material>()

/** Cached materials. `e` adds an emissive glow, `o` makes it see-through. */
export function mat(color: string, e?: string, o?: number): THREE.Material {
  const key = `${color}|${e ?? ''}|${o ?? 1}`
  let m = mats.get(key)
  if (!m) {
    const l = new THREE.MeshLambertMaterial({ color })
    if (e) {
      l.emissive = new THREE.Color(e)
      l.emissiveIntensity = 1
    }
    if (o !== undefined && o < 1) {
      l.transparent = true
      l.opacity = o
      l.depthWrite = false
    }
    m = l
    mats.set(key, m)
  }
  return m
}

export interface Box { p: V3; s: V3; c: string }

export const Vox = forwardRef<THREE.Mesh, { p: V3; s: V3; c: string; e?: string; o?: number; shadow?: boolean }>(
  function Vox({ p, s, c, e, o, shadow = true }, ref) {
    return <mesh ref={ref} position={p} scale={s} geometry={UNIT} material={mat(c, e, o)} castShadow={shadow && !o} receiveShadow={!o} />
  },
)

/**
 * Many static boxes in one draw call. `glow` draws them unlit, so colours read as light sources.
 * Rebuilt only when `boxes` changes identity, so build the list in a useMemo.
 */
export function VoxBatch({ boxes, glow, shadow = true }: { boxes: Box[]; glow?: boolean; shadow?: boolean }) {
  const ref = useRef<THREE.InstancedMesh>(null)
  const material = useMemo(() => (glow ? new THREE.MeshBasicMaterial({ toneMapped: false }) : new THREE.MeshLambertMaterial()), [glow])
  useLayoutEffect(() => {
    const mesh = ref.current
    if (!mesh) return
    const o = new THREE.Object3D()
    const c = new THREE.Color()
    boxes.forEach((b, i) => {
      o.position.set(...b.p)
      o.scale.set(...b.s)
      o.updateMatrix()
      mesh.setMatrixAt(i, o.matrix)
      mesh.setColorAt(i, c.set(b.c))
    })
    mesh.count = boxes.length
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    mesh.computeBoundingSphere()
  }, [boxes])
  if (!boxes.length) return null
  return (
    <instancedMesh key={boxes.length} ref={ref} args={[UNIT, material, boxes.length]} castShadow={shadow && !glow} receiveShadow={!glow} />
  )
}

/** Deterministic noise so generated scenery looks the same on every render. */
export function hash(...n: number[]) {
  let h = 2166136261
  for (const x of n) h = Math.imul(h ^ Math.floor(x * 1000), 16777619)
  return ((h >>> 0) % 10000) / 10000
}

/** Point and heading at distance `d` along a polyline. */
export function along(points: V3[], d: number): { p: V3; dir: V3 } {
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    const seg = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
    if (d <= seg || i === points.length - 1) {
      const t = seg ? Math.min(1, Math.max(0, d / seg)) : 0
      const dir: V3 = seg ? [(b[0] - a[0]) / seg, (b[1] - a[1]) / seg, (b[2] - a[2]) / seg] : [1, 0, 0]
      return { p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t], dir }
    }
    d -= seg
  }
  return { p: points[0], dir: [1, 0, 0] }
}

export const polyLength = (points: V3[]) =>
  points.slice(1).reduce((s, b, i) => s + Math.hypot(b[0] - points[i][0], b[1] - points[i][1], b[2] - points[i][2]), 0)

/** Position at fraction t (0..1) along a polyline. */
export const at = (points: V3[], t: number) => along(points, polyLength(points) * Math.min(1, Math.max(0, t))).p

export const pointer = {
  over: (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation()
    document.body.style.cursor = 'pointer'
  },
  out: () => {
    document.body.style.cursor = ''
  },
}

export function Clickable({ onClick, children, onHover }: { onClick: () => void; children: ReactNode; onHover?: (on: boolean) => void }) {
  return (
    <group
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      onPointerOver={(e) => {
        pointer.over(e)
        onHover?.(true)
      }}
      onPointerOut={() => {
        pointer.out()
        onHover?.(false)
      }}
    >
      {children}
    </group>
  )
}

/** True when the user asked for less motion: cameras jump instead of gliding, decorations hold still. */
export const calm = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/** Floating "!" that bobs above something waiting for the user. */
export function Alert({ y, color = '#ffcf4a', glow = '#ff9f1a', onClick }: { y: number; color?: string; glow?: string; onClick?: () => void }) {
  const ref = useRef<THREE.Group>(null)
  useFrame(({ clock }) => {
    if (!ref.current || calm) return
    ref.current.position.y = y + Math.sin(clock.elapsedTime * 4) * 0.08
    ref.current.rotation.y = clock.elapsedTime * 1.5
  })
  const body = (
    <group ref={ref} position={[0, y, 0]}>
      <Vox p={[0, 0.34, 0]} s={[0.16, 0.44, 0.16]} c={color} e={glow} shadow={false} />
      <Vox p={[0, 0, 0]} s={[0.16, 0.16, 0.16]} c={color} e={glow} shadow={false} />
    </group>
  )
  return onClick ? <Clickable onClick={onClick}>{body}</Clickable> : body
}

/** A simple canvas texture of two-colour pixels, for floors. */
export function useChecker(a: string, b: string, repeat: V2, cells = 2) {
  return useMemo(() => {
    const c = document.createElement('canvas')
    c.width = c.height = cells
    const g = c.getContext('2d') as CanvasRenderingContext2D
    for (let y = 0; y < cells; y++) for (let x = 0; x < cells; x++) {
      g.fillStyle = (x + y) % 2 ? a : b
      g.fillRect(x, y, 1, 1)
    }
    const tex = new THREE.CanvasTexture(c)
    tex.magFilter = THREE.NearestFilter
    tex.minFilter = THREE.NearestFilter
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping
    tex.repeat.set(repeat[0] / cells, repeat[1] / cells)
    tex.colorSpace = THREE.SRGBColorSpace
    return tex
  }, [a, b, repeat[0], repeat[1], cells])
}
