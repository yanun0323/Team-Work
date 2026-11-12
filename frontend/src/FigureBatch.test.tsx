import { act, createRoot, extend } from '@react-three/fiber'
import * as THREE from 'three'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { UNIT } from './core/voxel/kit'
import { seeThrough } from './Fade'
import { BATCHED_LAYER, FigureBatch, FigureBatcher } from './FigureBatch'
import { Figure, lookOf, newRig } from './People'
import { NO_OUTLINE_LAYER } from './PixelPass'
import { toon } from './toon'

extend({ Group: THREE.Group, Mesh: THREE.Mesh, BoxGeometry: THREE.BoxGeometry })

const roots: ReturnType<typeof createRoot>[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => { root.unmount() })
  vi.unstubAllGlobals()
})

/** A figure's box: a unit box in one toon colour, put at `p`. */
function box(color: string, p: [number, number, number]) {
  const m = new THREE.Mesh(UNIT, toon(color))
  m.position.set(...p)
  return m
}

/** The instanced meshes the batcher draws, with how many boxes each. */
const piles = (b: FigureBatcher) => b.group.children.map((c) => c as THREE.InstancedMesh)

describe('FigureBatcher', () => {
  it('draws every shown box once, where it stands and in its colour, and keeps the box itself out of every pass', () => {
    const scene = new THREE.Scene()
    const root = new THREE.Group()
    root.position.set(10, 0, 0)
    const red = box('#ff0000', [1, 0, 0])
    const blue = box('#0000ff', [0, 2, 0])
    blue.scale.set(0.5, 0.5, 0.5)
    root.add(red, blue)
    scene.add(root)
    const batcher = new FigureBatcher()
    scene.add(batcher.group)

    batcher.update([root])

    const [solid] = piles(batcher)
    expect(solid.count).toBe(2)
    const at = new THREE.Matrix4()
    solid.getMatrixAt(0, at)
    expect(new THREE.Vector3().setFromMatrixPosition(at).toArray()).toEqual([11, 0, 0])
    solid.getMatrixAt(1, at)
    expect(new THREE.Vector3().setFromMatrixScale(at).toArray()).toEqual([0.5, 0.5, 0.5])
    const c = new THREE.Color()
    solid.getColorAt(1, c)
    expect(c.equals(toon('#0000ff').color)).toBe(true)
    // the boxes themselves are on a layer no camera draws, the batch on the ordinary one
    for (const m of [red, blue]) expect(m.layers.mask).toBe(1 << BATCHED_LAYER)
    expect(solid.layers.mask).toBe(1)
    expect(solid.castShadow && solid.receiveShadow).toBe(true)
  })

  it('follows them as they move, and leaves out what is hidden, itself or above it', () => {
    const scene = new THREE.Scene()
    const holder = new THREE.Group()
    const root = new THREE.Group()
    const seated = new THREE.Group()
    const standing = new THREE.Group()
    seated.add(box('#ff0000', [0, 0, 0]))
    standing.add(box('#00ff00', [0, 0, 0]), box('#00ff00', [0, 1, 0]))
    seated.visible = false
    root.add(seated, standing)
    holder.add(root)
    scene.add(holder)
    const batcher = new FigureBatcher()
    scene.add(batcher.group)

    batcher.update([root])
    const [solid] = piles(batcher)
    expect(solid.count).toBe(2)

    // posed since: moved and sat down
    root.position.set(0, 0, 5)
    seated.visible = true
    standing.visible = false
    batcher.update([root])
    expect(solid.count).toBe(1)
    const at = new THREE.Matrix4()
    solid.getMatrixAt(0, at)
    expect(at.elements[14]).toBe(5)

    holder.visible = false
    batcher.update([root])
    expect(solid.count).toBe(0)
  })

  it('leaves anything but a unit toon box to draw itself', () => {
    const scene = new THREE.Scene()
    const root = new THREE.Group()
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(), toon('#ff0000'))
    const basic = new THREE.Mesh(UNIT, new THREE.MeshBasicMaterial())
    const big = new THREE.Mesh(new THREE.BoxGeometry(2, 1, 1), toon('#ff0000'))
    root.add(sphere, basic, big)
    scene.add(root)
    const batcher = new FigureBatcher()
    scene.add(batcher.group)
    batcher.update([root])
    expect(piles(batcher)[0].count).toBe(0)
    for (const m of [sphere, basic, big]) expect(m.layers.mask).toBe(1)
  })

  it('grows to hold a crowd', () => {
    const scene = new THREE.Scene()
    const root = new THREE.Group()
    for (let i = 0; i < 600; i++) root.add(box('#ff0000', [i, 0, 0]))
    scene.add(root)
    const batcher = new FigureBatcher()
    scene.add(batcher.group)
    batcher.update([root])
    const [solid] = piles(batcher)
    expect(solid.count).toBe(600)
    expect(batcher.group.children).toHaveLength(1)
    const at = new THREE.Matrix4()
    solid.getMatrixAt(599, at)
    expect(at.elements[12]).toBe(599)
  })

  it('draws boxes a Fade has see-through in a see-through batch of that Fade, gone once the fade is over', () => {
    const scene = new THREE.Scene()
    const root = new THREE.Group()
    const solidBox = box('#ff0000', [0, 0, 0])
    const fading = box('#00ff00', [1, 0, 0])
    root.add(solidBox, fading)
    scene.add(root)
    const batcher = new FigureBatcher()
    scene.add(batcher.group)
    // as Fade does mid-fade: a see-through copy, its dither for the shadow, out of the outline pass
    const own = fading.material
    const copy = seeThrough(own, true) as THREE.MeshToonMaterial
    copy.opacity = 0.4
    const dither = new THREE.MeshDepthMaterial()
    fading.material = copy
    fading.customDepthMaterial = dither
    fading.layers.set(NO_OUTLINE_LAYER)

    batcher.update([root])
    const [solid, faded] = piles(batcher)
    expect(solid.count).toBe(1)
    expect(faded.count).toBe(1)
    const m = faded.material as THREE.MeshToonMaterial
    expect([m.transparent, m.opacity, m.depthWrite]).toEqual([true, 0.4, true])
    expect(faded.layers.mask).toBe(1 << NO_OUTLINE_LAYER)
    expect(faded.customDepthMaterial).toBe(dither)
    const c = new THREE.Color()
    faded.getColorAt(0, c)
    expect(c.equals(own.color)).toBe(true)
    expect(fading.layers.mask).toBe(1 << BATCHED_LAYER)

    // the fade is over: its own material back, the see-through batch gone
    fading.material = own
    const disposed = vi.fn()
    m.addEventListener('dispose', disposed)
    batcher.update([root])
    expect(piles(batcher)).toHaveLength(1)
    expect(piles(batcher)[0].count).toBe(2)
    expect(disposed).toHaveBeenCalled()
  })
})

describe('FigureBatch', () => {
  it('draws the figures in its scene, each frame, after they are posed', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const canvas = {} as HTMLCanvasElement
    const gl = { render: vi.fn(), setSize: vi.fn(), setPixelRatio: vi.fn(), domElement: canvas } as unknown as THREE.WebGLRenderer
    const root = createRoot(canvas)
    roots.push(root)
    await root.configure({ gl, frameloop: 'never', dpr: 1, size: { width: 100, height: 100, top: 0, left: 0 } })
    const rig = newRig()
    const view = (figure: boolean) => <>{figure && <Figure look={lookOf(1)} rig={rig} seed={3} />}<FigureBatch /></>
    let state!: ReturnType<ReturnType<typeof root.render>['getState']>
    await act(async () => { state = root.render(view(true)).getState() })
    await act(async () => { state.advance(0) })
    const batch = state.scene.children.find((c) => c.children.some((m) => (m as THREE.InstancedMesh).isInstancedMesh))!
    const solid = batch.children[0] as THREE.InstancedMesh
    // the seated pose is shown; every box of it drawn, none of the figure's own
    expect(solid.count).toBeGreaterThan(10)
    let drawnAlone = 0
    rig.root!.traverseVisible((o) => { if ((o as THREE.Mesh).isMesh && o.layers.mask !== 1 << BATCHED_LAYER) drawnAlone++ })
    expect(drawnAlone).toBe(0)

    // unmounted: no longer drawn
    await act(async () => { root.render(view(false)) })
    await act(async () => { state.advance(1) })
    expect(solid.count).toBe(0)
  })
})
