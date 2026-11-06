// Fades a group of meshes in when it appears (opacity 0 → 100%) and out before it goes (100% → 0).
//
// While fading, each mesh gets a see-through copy of its material, stays out of the outline pass and casts
// a shadow that fades with it (dithered, see shadowFade); once fully shown it gets its own material back, so a settled object is drawn
// exactly as before. Materials the meshes share with others are never touched.
//
// A solid surface fading in keeps writing depth, so what is in front stays in front. Without depth the
// blended copies were stacked purely in draw order, which let thin layers lying close together (floor,
// wood, rug) and the desks on them swap or vanish while fading: the office flickered. A group fading out
// writes no depth, so it never hides what is appearing in its place.

import { useFrame } from '@react-three/fiber'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import * as THREE from 'three'
import { NO_OUTLINE_LAYER } from './PixelPass'
import { fadingShadow } from './shadowFade'

/** Seconds for a full fade. */
export const FADE_SECONDS = 0.35

const calm = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

type Mat = THREE.Material | THREE.Material[]

interface Saved {
  own: Mat
  copy: Mat
  layers: number
  castShadow: boolean
  depth: THREE.Material | undefined
}

const list = (m: Mat) => (Array.isArray(m) ? m : [m])

function seeThrough(m: THREE.Material, appearing: boolean) {
  const c = m.clone()
  c.transparent = true
  // already see-through materials (the front walls) keep their own depth setting
  if (!m.transparent) {
    c.depthWrite = appearing
    c.userData.solid = true
  }
  c.userData.fullOpacity = m.opacity
  return c
}

const dispose = (m: Mat) => list(m).forEach((x) => x.dispose())

export function Fade({ show, children }: { show: boolean; children: ReactNode }) {
  // stays mounted while fading out
  const [mounted, setMounted] = useState(show)
  if (show && !mounted) setMounted(true)
  const group = useRef<THREE.Group>(null)
  // every appearance starts from nothing
  const level = useRef(0)
  const saved = useRef(new Map<THREE.Mesh, Saved>())
  const shadow = useMemo(fadingShadow, [])

  const restore = () => {
    for (const [mesh, s] of saved.current) {
      if (mesh.material === s.copy) mesh.material = s.own
      mesh.layers.mask = s.layers
      mesh.castShadow = s.castShadow
      mesh.customDepthMaterial = s.depth
      dispose(s.copy)
    }
    saved.current.clear()
  }

  // dropped mid-fade (the whole building went): free the copies
  useEffect(() => () => {
    for (const s of saved.current.values()) dispose(s.copy)
    saved.current.clear()
    shadow.material.dispose()
  }, [shadow])

  useFrame((_, dt) => {
    const g = group.current
    if (!g) return
    const goal = show ? 1 : 0
    if (level.current === goal && (show ? saved.current.size === 0 : !mounted)) return
    level.current = calm ? goal : THREE.MathUtils.clamp(level.current + (show ? 1 : -1) * (dt / FADE_SECONDS), 0, 1)
    const k = level.current
    shadow.set(k)
    if (show) g.visible = true

    if (show && k === 1) {
      restore()
      return
    }
    if (!show && k === 0) {
      // Hide at once, but restore before dropping: show may turn true before React removes the meshes.
      g.visible = false
      restore()
      setMounted(false)
      return
    }
    g.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      let s = saved.current.get(mesh)
      // first frame of the fade, or React handed the mesh a new material mid-fade
      if (!s || mesh.material !== s.copy) {
        if (s) dispose(s.copy)
        const own = mesh.material
        const copy = Array.isArray(own) ? own.map((x) => seeThrough(x, show)) : seeThrough(own, show)
        s = { own, copy, layers: s?.layers ?? mesh.layers.mask, castShadow: s?.castShadow ?? mesh.castShadow, depth: s ? s.depth : mesh.customDepthMaterial }
        saved.current.set(mesh, s)
        mesh.material = copy
        mesh.layers.set(NO_OUTLINE_LAYER)
        mesh.customDepthMaterial = shadow.material
      }
      for (const m of list(s.copy)) {
        m.opacity = (m.userData.fullOpacity as number) * k
        // turned around mid-fade: follow the new direction
        if (m.userData.solid) m.depthWrite = show
      }
    })
  })

  if (!mounted) return null
  return <group ref={group}>{children}</group>
}
