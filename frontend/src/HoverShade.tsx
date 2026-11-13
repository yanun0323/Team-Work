// The hover shade over a building on the island (a company's, the airport, the staffing agency, the power tower): it
// can be clicked. It follows the building's own outline: a see-through grey copy of every solid mesh drawn beside it
// (under its parent), moving parts and all, plus boxes for what belongs to it but is drawn elsewhere and a layer over
// its paving. Each copy lies on what it copies, and the depth test lets only the nearest surface at each spot on
// screen through, so nowhere is shaded twice, however the parts stand in front of one another.

import { useFrame } from '@react-three/fiber'
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { mergeParts } from './Merged'
import { NO_OUTLINE_LAYER } from './PixelPass'

type V3 = [number, number, number]

/** How dark the shade gets (blended in linear light, so this reads as about a quarter darker on screen), and how fast it comes and goes, per second. */
const SHADE = 0.5
const SHADE_RATE = 4

/** The paving's top (World.tsx `Pavement`). */
export const PAVE_TOP = 0.08
/**
 * The height of the shade's layer over the paving: clear of the paving's top, not on it. The paving is many boxes, the
 * layer one plane cut into other triangles, so their depths at the same spot differ in the last bits; lying on it,
 * the layer lost to the paving in bands that moved with the zoom, which no polygon offset made up for. Too little
 * to see as a step at the foot of anything standing there.
 */
export const SHADE_FLOOR = PAVE_TOP + 0.02

/**
 * The meshes drawn under `root`, for the shade to copy: shown all the way down (so not those `Merged` has hidden in
 * favour of its merged ones), seen by the camera (`layers`; so not the people `FigureBatch` draws in their stead),
 * solid (a see-through one, glass or a fading copy, lets what is behind it through, which gets its own copy), with a
 * material that is drawn (so not the pointer's boxes), and nothing under `skip`. A mesh with a material per face (a
 * building's walls) counts when every one of them does; its one-material copy covers all its faces.
 */
export function shadeTargets(root: THREE.Object3D, skip: THREE.Object3D, layers?: THREE.Layers): THREE.Mesh[] {
  const out: THREE.Mesh[] = []
  const walk = (o: THREE.Object3D) => {
    if (o === skip || !o.visible) return
    const m = o as THREE.Mesh
    if (m.isMesh && [m.material].flat().every((x) => x.visible && !x.transparent) && (!layers || layers.test(m.layers))) out.push(m)
    for (const c of o.children) walk(c)
  }
  walk(root)
  return out
}

/** A rectangle on the ground about the building's middle: centre and size. */
export interface Floor { x: number; z: number; w: number; d: number }

const NONE: Array<[V3, V3]> = []
const UNIT_BOX = new THREE.BoxGeometry()
const TURN = new THREE.Quaternion()

/**
 * Shades everything drawn under its parent while `on`. `boxes` ([centre, size], about the parent) are for what is drawn
 * elsewhere, exactly as drawn (a company's street furniture); `floor`, its paving, which is drawn elsewhere too.
 */
export function HoverShade({ on, floor, boxes = NONE }: { on: boolean; floor?: Floor; boxes?: Array<[V3, V3]> }) {
  // a nudge towards the camera, so a copy is never lost to the surface it lies on; a fixed one, as one by slope (the
  // factor) is large on the big pixels here and would lift the paving's layer through a path on it
  const mat = useMemo(() => new THREE.MeshBasicMaterial({
    color: '#1c1f2e', transparent: true, opacity: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: 0, polygonOffsetUnits: -4,
  }), [])
  const holder = useRef<THREE.Group>(null)
  const copies = useMemo(() => new Map<THREE.Mesh, THREE.Mesh>(), [])
  const back = useMemo(() => new THREE.Matrix4(), [])
  // the boxes as one geometry, drawn at once
  const extra = useMemo(() => boxes.length ? mergeParts(boxes.map(([p, s]) => ({
    geometry: UNIT_BOX, matrix: new THREE.Matrix4().compose(new THREE.Vector3(...p), TURN, new THREE.Vector3(...s)),
  }))) : null, [boxes])
  useEffect(() => () => mat.dispose(), [mat])
  useEffect(() => () => extra?.dispose(), [extra])
  useLayoutEffect(() => holder.current?.traverse((o) => o.layers.set(NO_OUTLINE_LAYER)), [floor, extra])
  useFrame(({ camera }, dt) => {
    const to = on ? SHADE : 0
    mat.opacity += Math.sign(to - mat.opacity) * Math.min(Math.abs(to - mat.opacity), SHADE_RATE * dt)
    const g = holder.current
    const r = g?.parent
    if (!g || !r) return
    g.visible = mat.opacity > 0.001
    if (!g.visible) return
    // what is drawn changes as `Merged` rebuilds (less detail) and parts move: copy it as it is now
    const sources = new Set(shadeTargets(r, g, camera.layers))
    for (const [src, copy] of copies) if (!sources.has(src)) {
      g.remove(copy)
      copies.delete(src)
    }
    r.updateWorldMatrix(true, false)
    back.copy(r.matrixWorld).invert()
    for (const src of sources) {
      let copy = copies.get(src)
      if (!copy) {
        copy = new THREE.Mesh(src.geometry, mat)
        copy.matrixAutoUpdate = false
        copy.raycast = () => null
        copy.renderOrder = 2
        copy.layers.set(NO_OUTLINE_LAYER)
        copies.set(src, copy)
        g.add(copy)
      }
      copy.geometry = src.geometry
      src.updateWorldMatrix(true, false)
      copy.matrix.multiplyMatrices(back, src.matrixWorld)
    }
  })
  return (
    <group ref={holder} visible={false}>
      {floor && (
        <mesh position={[floor.x, SHADE_FLOOR, floor.z]} rotation={[-Math.PI / 2, 0, 0]} material={mat} raycast={() => null} renderOrder={2}>
          <planeGeometry args={[floor.w, floor.d]} />
        </mesh>
      )}
      {extra && <mesh geometry={extra} material={mat} raycast={() => null} renderOrder={2} />}
    </group>
  )
}
