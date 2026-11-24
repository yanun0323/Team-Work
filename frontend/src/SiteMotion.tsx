// The parts of the landmarks that move (siteBoxes.ts `siteMoving`): the fountain's water, the boats in the harbour
// and the clock's hands. One draw for them all, in the street furniture's material; held still
// with reduced motion.

import { useFrame } from '@react-three/fiber'
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { UNIT } from './core/voxel/kit'
import type { Town } from './layout'
import { siteMoving } from './siteBoxes'
import { toonInstanced } from './toon'

const calm = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
const AXES = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) }

export function SiteMotion({ town }: { town: Town }) {
  const parts = useMemo(() => town.sites.flatMap((s) => siteMoving(town, s)), [town])
  const count = parts.reduce((n, p) => n + p.boxes.length, 0)
  const ref = useRef<THREE.InstancedMesh>(null)
  const material = useMemo(() => toonInstanced(), [])
  useEffect(() => () => material.dispose(), [material])
  const scratch = useMemo(() => ({
    whole: new THREE.Matrix4(), part: new THREE.Matrix4(), box: new THREE.Matrix4(),
    q: new THREE.Quaternion(), v: new THREE.Vector3(), s: new THREE.Vector3(), one: new THREE.Vector3(1, 1, 1), none: new THREE.Quaternion(),
  }), [])

  const place = (t: number) => {
    const mesh = ref.current
    if (!mesh) return
    const { whole, part, box, q, v, s, one, none } = scratch
    let i = 0
    for (const p of parts) {
      const [mx, my, mz] = p.move?.(t) ?? [0, 0, 0]
      q.setFromAxisAngle(AXES[p.axis], p.turn(t))
      whole.compose(v.set(p.at[0] + mx, p.at[1] + my, p.at[2] + mz), q, one)
      for (const b of p.boxes) {
        box.compose(v.set(...b.p), none, s.set(...b.s))
        mesh.setMatrixAt(i++, part.multiplyMatrices(whole, box))
      }
    }
    mesh.instanceMatrix.needsUpdate = true
  }

  useLayoutEffect(() => {
    const mesh = ref.current
    if (!mesh) return
    const c = new THREE.Color()
    let i = 0
    for (const p of parts) for (const b of p.boxes) mesh.setColorAt(i++, c.set(b.c))
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    place(0)
    mesh.computeBoundingSphere()
    // what moves never strays far from where it starts
    if (mesh.boundingSphere) mesh.boundingSphere.radius += 4
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parts])
  useFrame(({ clock }) => {
    if (!calm) place(clock.elapsedTime)
  })
  if (!count) return null
  return <instancedMesh key={count} ref={ref} args={[UNIT, material, count]} castShadow receiveShadow />
}
