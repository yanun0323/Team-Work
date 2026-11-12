import { act, createRoot, extend } from '@react-three/fiber'
import * as THREE from 'three'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LIVE, mergedAway, mergeParts, mergeStatic, Merged } from './Merged'

extend({ Group: THREE.Group, Mesh: THREE.Mesh, BoxGeometry: THREE.BoxGeometry })

const roots: ReturnType<typeof createRoot>[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => { root.unmount() })
  vi.unstubAllGlobals()
})

const red = new THREE.MeshBasicMaterial({ color: 'red' })
const blue = new THREE.MeshBasicMaterial({ color: 'blue' })

function box(material: THREE.Material | THREE.Material[], p: [number, number, number], s: [number, number, number] = [1, 1, 1]) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(), material)
  m.position.set(...p)
  m.scale.set(...s)
  return m
}

/** Where a ray from far above, straight down at (x, z), first meets `target` and what it hits. */
function hitFromAbove(target: THREE.Object3D, x: number, z: number) {
  target.updateMatrixWorld(true)
  const ray = new THREE.Raycaster(new THREE.Vector3(x, 100, z), new THREE.Vector3(0, -1, 0))
  return ray.intersectObject(target, true)[0]
}

/** Every triangle's face, worked out from its corners in order, points the way its vertex normals do. */
function facesOut(g: THREE.BufferGeometry) {
  const p = g.getAttribute('position')
  const n = g.getAttribute('normal')
  const idx = g.index!
  const [a, b, c, normal] = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]
  for (let k = 0; k < idx.count; k += 3) {
    a.fromBufferAttribute(p, idx.getX(k))
    b.fromBufferAttribute(p, idx.getX(k + 1))
    c.fromBufferAttribute(p, idx.getX(k + 2))
    const face = b.sub(a).cross(c.sub(a))
    if (face.dot(normal.fromBufferAttribute(n, idx.getX(k))) <= 0) return false
  }
  return true
}

describe('mergeParts', () => {
  it('puts each part where its matrix says, its normals turned with it', () => {
    const turned = new THREE.Matrix4().compose(new THREE.Vector3(5, 0, 0), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2), new THREE.Vector3(2, 1, 1))
    const g = mergeParts([
      { geometry: new THREE.BoxGeometry(), matrix: new THREE.Matrix4() },
      { geometry: new THREE.BoxGeometry(), matrix: turned },
    ])
    g.computeBoundingBox()
    expect(g.boundingBox!.min.toArray()).toEqual([-0.5, -1, -0.5].map((v) => expect.closeTo(v)))
    expect(g.boundingBox!.max.toArray()).toEqual([5.5, 1, 0.5].map((v) => expect.closeTo(v)))
    expect(g.getAttribute('position').count).toBe(48)
    expect(facesOut(g)).toBe(true)
  })

  it('turns a mirrored part\'s triangles round, so its outside still faces out', () => {
    const mirrored = new THREE.Matrix4().makeScale(-1, 1, 1)
    expect(facesOut(mergeParts([{ geometry: new THREE.BoxGeometry(), matrix: mirrored }]))).toBe(true)
  })
})

describe('mergeStatic', () => {
  it('draws one mesh per material and shadow, in the root\'s own space, and hides what it merged', () => {
    const root = new THREE.Group()
    root.position.set(100, 0, 0)
    const inner = new THREE.Group()
    inner.position.set(0, 2, 0)
    const a = box(red, [1, 0, 0])
    const b = box(red, [-1, 0, 0])
    const c = box(blue, [0, 0, 3])
    const shadowless = box(red, [0, 0, -3])
    a.castShadow = b.castShadow = c.castShadow = true
    inner.add(a, b, c, shadowless)
    root.add(inner)

    const merged = mergeStatic(root)
    expect(merged.map((m) => [(m.material as THREE.MeshBasicMaterial).color.getHexString(), m.castShadow, m.geometry.getAttribute('position').count]))
      .toEqual([['ff0000', true, 48], ['0000ff', true, 24], ['ff0000', false, 24]])
    for (const m of [a, b, c, shadowless]) expect(m.visible).toBe(false)
    merged[0].geometry.computeBoundingBox()
    // the inner group's lift is baked in; the root's own move is not, the merged mesh being its child
    expect(merged[0].geometry.boundingBox!.min.toArray()).toEqual([-1.5, 1.5, -0.5])
    expect(merged[0].geometry.boundingBox!.max.toArray()).toEqual([1.5, 2.5, 0.5])
  })

  it('leaves multi-material, see-through and instanced meshes as they are', () => {
    const root = new THREE.Group()
    const glass = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.5 })
    const many = box([red, blue, red, blue, red, blue], [0, 0, 0])
    const clear = box(glass, [2, 0, 0])
    const instanced = new THREE.InstancedMesh(new THREE.BoxGeometry(), red, 3)
    root.add(many, clear, instanced)
    expect(mergeStatic(root)).toEqual([])
    for (const m of [many, clear, instanced]) expect(m.visible).toBe(true)
  })

  it('keeps the pointer on the meshes it merged: the merged mesh takes none', () => {
    const root = new THREE.Group()
    const a = box(red, [3, 0, 0])
    root.add(a)
    const merged = mergeStatic(root)
    root.add(...merged)
    expect(hitFromAbove(root, 3, 0)?.object).toBe(a)
    expect(hitFromAbove(root, 0, 0)).toBeUndefined()
  })

  it('leaves out what is marked live, and everything under it, still working out its matrices', () => {
    const root = new THREE.Group()
    const still = box(red, [1, 0, 0])
    const person = new THREE.Group()
    person.userData = LIVE
    const arm = new THREE.Group()
    const hand = box(red, [3, 0, 0])
    arm.add(hand)
    person.add(arm)
    root.add(still, person)

    const merged = mergeStatic(root)
    expect(merged.map((m) => m.geometry.getAttribute('position').count)).toEqual([24])
    expect([still.visible, mergedAway(still)]).toEqual([false, true])
    expect([hand.visible, mergedAway(hand)]).toEqual([true, false])
    for (const o of [person, arm, hand]) expect(o.matrixAutoUpdate).toBe(true)
  })

  it('stops the meshes working out their matrices each frame, and catches up with what React set on a rebuild', () => {
    const root = new THREE.Group()
    const a = box(red, [3, 0, 0])
    root.add(a)
    mergeStatic(root)
    expect(a.matrixAutoUpdate).toBe(false)
    a.position.set(-4, 0, 0)
    const [again] = mergeStatic(root)
    again.geometry.computeBoundingBox()
    expect(again.geometry.boundingBox!.min.x).toBe(-4.5)
    expect(hitFromAbove(root, -4, 0)?.object).toBe(a)
  })
})

describe('Merged', () => {
  async function scene(children: React.ReactNode) {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const canvas = {} as HTMLCanvasElement
    const gl = { render: vi.fn(), setSize: vi.fn(), setPixelRatio: vi.fn(), domElement: canvas } as unknown as THREE.WebGLRenderer
    const root = createRoot(canvas)
    roots.push(root)
    await root.configure({ gl, frameloop: 'never', dpr: 1, size: { width: 100, height: 100, top: 0, left: 0 } })
    let store!: ReturnType<ReturnType<typeof root.render>['getState']>
    await act(async () => { store = root.render(<>{children}</>).getState() })
    return {
      store,
      rerender: (next: React.ReactNode) => act(async () => { root.render(<>{next}</>) }),
      /** The merged meshes drawn, by how many vertices each holds. */
      drawn: () => {
        const out: number[] = []
        store.scene.traverse((o) => { if (o.userData.merged) out.push((o as THREE.Mesh).geometry.getAttribute('position').count) })
        return out
      },
    }
  }

  const Boxes = ({ n }: { n: number }) => (
    <Merged deps={[n]}>
      {Array.from({ length: n }, (_, i) => <mesh key={i} position={[i * 2, 0, 0]} material={red}><boxGeometry /></mesh>)}
    </Merged>
  )

  it('merges its children when it mounts, and again when its deps change', async () => {
    const s = await scene(<Boxes n={2} />)
    expect(s.drawn()).toEqual([48])
    await s.rerender(<Boxes n={3} />)
    expect(s.drawn()).toEqual([72])
  })

  it('waits for a fade under it to end before merging again', async () => {
    const s = await scene(<Boxes n={2} />)
    let first!: THREE.Mesh
    s.store.scene.traverse((o) => { if (o.userData.merged) first = o as THREE.Mesh })
    // as Fade does: a see-through copy on the merged mesh
    const copy = red.clone()
    copy.userData.fullOpacity = 1
    first.material = copy
    await s.rerender(<Boxes n={3} />)
    expect(s.drawn(), 'still the old one while fading').toEqual([48])
    first.material = red
    s.store.advance(0)
    expect(s.drawn()).toEqual([72])
  })

  it('frees the merged geometry when it goes', async () => {
    const s = await scene(<Boxes n={2} />)
    let geometry!: THREE.BufferGeometry
    s.store.scene.traverse((o) => { if (o.userData.merged) geometry = (o as THREE.Mesh).geometry })
    const dispose = vi.spyOn(geometry, 'dispose')
    await s.rerender(null)
    expect(dispose).toHaveBeenCalled()
  })
})
