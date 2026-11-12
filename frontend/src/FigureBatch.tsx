// Everyone drawn in one go. A figure is some thirty boxes, and three.js spends a frame mostly on what it does for each
// object it draws, three times over (shadow, colour, normals), so a crowd of them cost thousands of draw calls. The
// figures keep their own meshes, moved and posed as before, but on a layer no camera draws; each frame the boxes shown
// go, where they are now, into one instanced mesh that draws them all at once.
//
// While a Fade has a figure see-through, its boxes go into a see-through instanced mesh of that Fade's instead, drawn as
// Fade draws its copies: at their opacity, out of the outline pass, casting their shadow through its dither.

import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { UNIT } from './core/voxel/kit'
import { isFadeCopy } from './Fade'
import { NO_OUTLINE_LAYER } from './PixelPass'
import { toonInstanced } from './toon'

/** Where a batched figure's own meshes go: no camera draws this layer, nor the sun's shadow from it. */
export const BATCHED_LAYER = 2

/**
 * After everything that poses people or fades them (priority 0), before PixelPass draws the frame (1).
 */
const PRIORITY = 0.5

/** The figures in each scene, by their root. */
const figures = new WeakMap<THREE.Object3D, Set<THREE.Object3D>>()

/**
 * Puts the figure under `root` into `scene`'s batch, if the scene has a `FigureBatch`; without one it is drawn as it
 * is. Returns the undo.
 */
export function batchFigure(scene: THREE.Object3D, root: THREE.Object3D) {
  let set = figures.get(scene)
  if (!set) figures.set(scene, (set = new Set()))
  set.add(root)
  return () => void set.delete(root)
}

const noRaycast = () => {}

/** A figure's box: a unit box in one toon colour. Anything else under a figure is left to draw itself. */
function batchable(o: THREE.Object3D): o is THREE.Mesh<THREE.BoxGeometry, THREE.MeshToonMaterial> {
  const mesh = o as THREE.Mesh
  if (!mesh.isMesh || (mesh as THREE.InstancedMesh).isInstancedMesh) return false
  const m = mesh.material as THREE.MeshToonMaterial
  if (Array.isArray(m) || !m.isMeshToonMaterial) return false
  const g = mesh.geometry as THREE.BoxGeometry
  return g === UNIT || (g.type === 'BoxGeometry' && g.parameters.width === 1 && g.parameters.height === 1 && g.parameters.depth === 1
    && g.parameters.widthSegments === 1 && g.parameters.heightSegments === 1 && g.parameters.depthSegments === 1)
}

/** One instanced mesh and the boxes it draws this frame; grown, never shrunk, as more are shown. */
class Pile {
  mesh: THREE.InstancedMesh
  readonly boxes: THREE.Mesh[] = []

  constructor(readonly material: THREE.MeshToonMaterial, private readonly setup: (m: THREE.InstancedMesh) => void, capacity = 256) {
    this.mesh = this.make(capacity)
  }

  private make(capacity: number) {
    const mesh = new THREE.InstancedMesh(UNIT, this.material, capacity)
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage)
    // the boxes are wherever the people are; working out bounds for every frame costs more than drawing a few unseen
    mesh.frustumCulled = false
    mesh.raycast = noRaycast
    mesh.castShadow = true
    mesh.receiveShadow = true
    mesh.matrixAutoUpdate = false
    mesh.count = 0
    this.setup(mesh)
    return mesh
  }

  /** Writes the boxes gathered into the instanced mesh, in `group`'s space, which is the scene's. */
  fill(group: THREE.Group) {
    const n = this.boxes.length
    if (n > this.mesh.instanceMatrix.count) {
      group.remove(this.mesh)
      this.mesh.dispose()
      this.mesh = this.make(2 ** Math.ceil(Math.log2(n)))
    }
    if (!this.mesh.parent) group.add(this.mesh)
    const matrices = this.mesh.instanceMatrix
    const colors = this.mesh.instanceColor!
    this.boxes.forEach((box, i) => {
      box.matrixWorld.toArray(matrices.array, i * 16)
      ;(box.material as THREE.MeshToonMaterial).color.toArray(colors.array, i * 3)
    })
    this.mesh.count = n
    for (const [a, size] of [[matrices, 16], [colors, 3]] as const) {
      a.clearUpdateRanges()
      a.addUpdateRange(0, n * size)
      a.needsUpdate = true
    }
  }

  dispose() {
    this.mesh.removeFromParent()
    this.mesh.dispose()
  }
}

/** Gathers the figures' boxes into instanced meshes under `group`, which must sit untransformed in the scene. */
export class FigureBatcher {
  readonly group = new THREE.Group()
  private readonly solid = new Pile(toonInstanced(), () => {})
  /** Figures a Fade has see-through, by that Fade's shadow dither (one each): its opacity is theirs. */
  private readonly fading = new Map<THREE.Material | undefined, Pile>()

  constructor() {
    this.group.matrixAutoUpdate = false
  }

  /** Brings the instanced meshes up to the figures under `roots` as they stand now. */
  update(roots: Iterable<THREE.Object3D>) {
    this.solid.boxes.length = 0
    for (const pile of this.fading.values()) pile.boxes.length = 0
    for (const root of roots) {
      if (!shown(root)) continue
      // what was posed this frame; the render works the same matrices out again, which costs little next to drawing
      root.updateWorldMatrix(true, true)
      this.gather(root)
    }
    this.solid.fill(this.group)
    for (const [key, pile] of this.fading) {
      if (pile.boxes.length) pile.fill(this.group)
      else {
        pile.dispose()
        pile.material.dispose()
        this.fading.delete(key)
      }
    }
  }

  private gather(o: THREE.Object3D) {
    if (!o.visible) return
    if (batchable(o)) {
      this.pileOf(o).boxes.push(o)
      o.layers.set(BATCHED_LAYER)
    }
    for (const c of o.children) this.gather(c)
  }

  private pileOf(box: THREE.Mesh<THREE.BoxGeometry, THREE.MeshToonMaterial>) {
    const own = box.material
    if (!isFadeCopy(own)) return this.solid
    const dither = box.customDepthMaterial
    let pile = this.fading.get(dither)
    if (!pile) {
      const material = toonInstanced()
      material.transparent = true
      pile = new Pile(material, (m) => {
        m.layers.set(NO_OUTLINE_LAYER)
        m.customDepthMaterial = dither
      }, 64)
      this.fading.set(dither, pile)
    }
    pile.material.opacity = own.opacity
    pile.material.depthWrite = own.depthWrite
    return pile
  }

  dispose() {
    this.solid.dispose()
    this.solid.material.dispose()
    for (const pile of this.fading.values()) {
      pile.dispose()
      pile.material.dispose()
    }
    this.fading.clear()
  }
}

/** Whether `o` and everything above it is shown. */
function shown(o: THREE.Object3D | null) {
  for (; o; o = o.parent) if (!o.visible) return false
  return true
}

/** Draws the scene's figures (`batchFigure`) in a few instanced meshes; once in the scene, not under anything moved. */
export function FigureBatch() {
  const scene = useThree((s) => s.scene)
  const batcher = useMemo(() => new FigureBatcher(), [])
  useEffect(() => () => batcher.dispose(), [batcher])
  useFrame(() => batcher.update(figures.get(scene) ?? []), PRIORITY)
  return <primitive object={batcher.group} />
}
