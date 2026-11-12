// Draws a subtree of meshes that never move against each other as a few meshes, one per material. three.js spends
// most of a frame on what it does for every object it draws (matrices, uniforms, binding its buffers), not on the
// pixels, so the number of objects is what sets the frame rate: a building, a plane or the airfield takes a handful
// of draw calls this way instead of hundreds.

import { useFrame } from '@react-three/fiber'
import { useEffect, useLayoutEffect, useRef, type DependencyList, type ReactNode } from 'react'
import * as THREE from 'three'
import { isFadeCopy } from './Fade'

/** A geometry placed by a matrix, for `mergeParts`. */
export interface Part {
  geometry: THREE.BufferGeometry
  matrix: THREE.Matrix4
}

const ATTRIBUTES = ['position', 'normal', 'uv'] as const

/** Whether `mergeParts` can take this geometry: plain position, normal and uv, as three's primitives have. */
function mergeable(g: THREE.BufferGeometry) {
  const names = Object.keys(g.attributes)
  if (names.length !== ATTRIBUTES.length || Object.keys(g.morphAttributes).length) return false
  return ATTRIBUTES.every((n, i) => {
    const a = g.getAttribute(n) as THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined
    return a && !(a as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute && a.itemSize === (i === 2 ? 2 : 3)
  })
}

/**
 * One geometry holding every part where its matrix puts it. Normals turn with the parts, and a mirrored part has its
 * triangles turned round, so its outside still faces out.
 */
export function mergeParts(parts: Part[]): THREE.BufferGeometry {
  let vertices = 0
  let indices = 0
  for (const { geometry: g } of parts) {
    vertices += g.getAttribute('position').count
    indices += g.index ? g.index.count : g.getAttribute('position').count
  }
  const position = new Float32Array(vertices * 3)
  const normal = new Float32Array(vertices * 3)
  const uv = new Float32Array(vertices * 2)
  const index = vertices > 65535 ? new Uint32Array(indices) : new Uint16Array(indices)
  const v = new THREE.Vector3()
  const turn = new THREE.Matrix3()
  let at = 0
  let i = 0
  for (const { geometry: g, matrix } of parts) {
    const p = g.getAttribute('position')
    const n = g.getAttribute('normal')
    const t = g.getAttribute('uv')
    turn.getNormalMatrix(matrix)
    for (let k = 0; k < p.count; k++) {
      v.fromBufferAttribute(p, k).applyMatrix4(matrix).toArray(position, (at + k) * 3)
      if (n) v.fromBufferAttribute(n, k).applyMatrix3(turn).normalize().toArray(normal, (at + k) * 3)
      if (t) {
        uv[(at + k) * 2] = t.getX(k)
        uv[(at + k) * 2 + 1] = t.getY(k)
      }
    }
    const mirrored = matrix.determinant() < 0
    const count = g.index ? g.index.count : p.count
    for (let k = 0; k < count; k += 3) {
      const a = g.index ? g.index.getX(k) : k
      const b = g.index ? g.index.getX(k + 1) : k + 1
      const c = g.index ? g.index.getX(k + 2) : k + 2
      index[i++] = at + a
      index[i++] = at + (mirrored ? c : b)
      index[i++] = at + (mirrored ? b : c)
    }
    at += p.count
  }
  const out = new THREE.BufferGeometry()
  out.setAttribute('position', new THREE.BufferAttribute(position, 3))
  out.setAttribute('normal', new THREE.BufferAttribute(normal, 3))
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  out.setIndex(new THREE.BufferAttribute(index, 1))
  return out
}

/** Takes no pointer: the meshes it was merged from do. */
const noRaycast = () => {}

/** `userData` for something that moves inside a `Merged`: it and everything under it are left as they are. */
export const LIVE = Object.freeze({ live: true })

/** Whether `o` is marked `LIVE`. */
const isLive = (o: THREE.Object3D) => o.userData.live === true

/** Its children move, or show and hide, inside a `Merged`: left out of the merge. */
export function Live({ children }: { children: ReactNode }) {
  return <group userData={LIVE}>{children}</group>
}

/** Whether a `Merged` draws `mesh` as part of a merged one, `mesh` itself hidden. */
export const mergedAway = (mesh: THREE.Object3D) => mesh.userData.mergedAway === true

/**
 * Merges the meshes under `root` that can be: one mesh per material, shadow, layers, draw order and shadow material,
 * in `root`'s own space. Multi-material, instanced and see-through meshes are left as they are (see-through ones are
 * sorted one by one, so merging them would change their order). The meshes merged are hidden and every object under
 * `root` stops working out its matrix each frame, except what is marked `LIVE`, which is left out altogether. Returns
 * the new meshes, not yet added to `root`.
 */
export function mergeStatic(root: THREE.Object3D): THREE.Mesh[] {
  const groups = new Map<string, { mesh: THREE.Mesh; parts: Part[] }>()
  const visit = (o: THREE.Object3D) => {
    if (isLive(o)) return
    // whatever React set since the last build
    o.updateMatrix()
    o.matrixAutoUpdate = false
    take(o)
    for (const c of o.children) visit(c)
  }
  const take = (o: THREE.Object3D) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh || (mesh as THREE.InstancedMesh).isInstancedMesh || (mesh as THREE.SkinnedMesh).isSkinnedMesh) return
    const material = mesh.material
    if (Array.isArray(material) || material.transparent || !mergeable(mesh.geometry)) return
    const matrix = mesh.matrix.clone()
    for (let p = mesh.parent; p && p !== root; p = p.parent) matrix.premultiply(p.matrix)
    const key = [material.uuid, mesh.castShadow, mesh.receiveShadow, mesh.layers.mask, mesh.renderOrder, mesh.customDepthMaterial?.uuid].join('|')
    let group = groups.get(key)
    if (!group) groups.set(key, (group = { mesh, parts: [] }))
    group.parts.push({ geometry: mesh.geometry, matrix })
    mesh.visible = false
    mesh.userData.mergedAway = true
  }
  for (const c of root.children) visit(c)
  return [...groups.values()].map(({ mesh: like, parts }) => {
    const mesh = new THREE.Mesh(mergeParts(parts), like.material)
    mesh.castShadow = like.castShadow
    mesh.receiveShadow = like.receiveShadow
    mesh.layers.mask = like.layers.mask
    mesh.renderOrder = like.renderOrder
    mesh.customDepthMaterial = like.customDepthMaterial
    mesh.raycast = noRaycast
    mesh.matrixAutoUpdate = false
    mesh.userData.merged = true
    return mesh
  })
}

/** Whether a Fade has see-through copies on any mesh under `root` right now. */
function fading(root: THREE.Object3D) {
  let found = false
  root.traverse((o) => {
    const m = (o as THREE.Mesh).material
    if (!found && m && !Array.isArray(m) && isFadeCopy(m)) found = true
  })
  return found
}

/**
 * Its children are drawn merged (`mergeStatic`): the group itself, and what holds it, may still move. The meshes stay,
 * hidden, so the pointer finds them and their events bubble as before.
 *
 * Nothing under it may move, turn, scale, show or hide on its own, except under a `Live` (or `LIVE` userData); only
 * shared materials may change (a glow, a scrolling texture). It is built when it mounts and again whenever `deps` change, so list everything its children's
 * shapes depend on. A Fade round it may fade the merged meshes; a rebuild waits for the fade to end.
 */
export function Merged({ deps, children }: { deps: DependencyList; children: ReactNode }) {
  const ref = useRef<THREE.Group>(null)
  const built = useRef<THREE.Mesh[]>([])
  const due = useRef(true)

  const build = () => {
    const g = ref.current
    if (!g || fading(g)) return
    for (const m of built.current) {
      g.remove(m)
      m.geometry.dispose()
    }
    built.current = mergeStatic(g)
    for (const m of built.current) g.add(m)
    due.current = false
  }

  useLayoutEffect(() => {
    due.current = true
    build()
    // the caller lists what the children's shapes depend on
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  useFrame(() => void (due.current && build()))
  useEffect(() => () => {
    for (const m of built.current) m.geometry.dispose()
    built.current = []
  }, [])
  return <group ref={ref}>{children}</group>
}
