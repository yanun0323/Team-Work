// The traffic lights' lamps at the junctions of the footpaths, changing in turn. Their posts and heads are drawn
// with the other street furniture (streetProps.ts `signalBoxes`); this is only the lamps, one draw for them all.

import { useFrame } from '@react-three/fiber'
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { UNIT } from './core/voxel/kit'
import type { Town } from './layout'
import { usePrefs } from './prefs'
import { signalBulbs, signalLights } from './streetProps'

/** Lit, the lamps shine the same by day and by night; unlit, each is a dark lens of its colour. */
const LIT = ['#ff3b30', '#ffb020', '#35d07f']
const DIM = ['#4a2a2c', '#4a3d24', '#22402f']

export function TrafficLights({ town }: { town: Town }) {
  const detail = usePrefs((s) => s.detail)
  const bulbs = useMemo(() => signalBulbs(town, detail), [town, detail])
  const ref = useRef<THREE.InstancedMesh>(null)
  // unlit by the sun, so a lit lamp stays bright after dark
  const material = useMemo(() => new THREE.MeshBasicMaterial({ toneMapped: false }), [])
  useEffect(() => () => material.dispose(), [material])
  // what each lamp shows now: 1 lit, 0 not, -1 not set yet
  const shown = useRef(new Int8Array(0))
  const colour = useMemo(() => new THREE.Color(), [])
  useLayoutEffect(() => {
    const mesh = ref.current
    if (!mesh) return
    const o = new THREE.Object3D()
    bulbs.forEach((b, i) => {
      o.position.set(...b.p)
      o.scale.set(...b.s)
      o.updateMatrix()
      mesh.setMatrixAt(i, o.matrix)
      mesh.setColorAt(i, colour.set(DIM[b.light]))
    })
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    mesh.computeBoundingSphere()
    shown.current = new Int8Array(bulbs.length).fill(-1)
  }, [bulbs, colour])
  useFrame(({ clock }) => {
    const mesh = ref.current
    if (!mesh) return
    let changed = false
    bulbs.forEach((b, i) => {
      const lit = signalLights(clock.elapsedTime + b.offset)[b.way] === b.light ? 1 : 0
      if (shown.current[i] === lit) return
      shown.current[i] = lit
      mesh.setColorAt(i, colour.set(lit ? LIT[b.light] : DIM[b.light]))
      changed = true
    })
    if (changed && mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  })
  if (!bulbs.length) return null
  return <instancedMesh key={bulbs.length} ref={ref} args={[UNIT, material, bulbs.length]} />
}
