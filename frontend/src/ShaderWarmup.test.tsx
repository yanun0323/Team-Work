import { act, createRoot } from '@react-three/fiber'
import * as THREE from 'three'
import { afterEach, expect, it, vi } from 'vitest'
import { ShaderWarmup } from './ShaderWarmup'

const roots: ReturnType<typeof createRoot>[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => { root.unmount() })
  vi.unstubAllGlobals()
})

it('draws a speck of each faded surface for the first few frames, then takes them away and frees them', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const canvas = {} as HTMLCanvasElement
  const gl = { render: vi.fn(), setSize: vi.fn(), setPixelRatio: vi.fn(), domElement: canvas } as unknown as THREE.WebGLRenderer
  const root = createRoot(canvas)
  roots.push(root)
  await root.configure({ gl, frameloop: 'never', dpr: 1, size: { width: 100, height: 100, top: 0, left: 0 } })
  let state!: ReturnType<ReturnType<typeof root.render>['getState']>
  await act(async () => { state = root.render(<ShaderWarmup />).getState() })
  const group = state.scene.children.find((o) => o.children.length > 0)!
  const meshes = group.children as THREE.Mesh[]
  // see-through and solid, people and all, each casting a shadow, unseen and never culled
  expect(meshes.some((m) => (m.material as THREE.Material).transparent)).toBe(true)
  expect(meshes.some((m) => (m as THREE.InstancedMesh).isInstancedMesh && (m.material as THREE.Material).transparent)).toBe(true)
  for (const m of meshes) expect([m.castShadow, m.frustumCulled, m.scale.x < 0.001]).toEqual([true, false, true])
  const freed = vi.fn()
  const seeThrough = meshes.find((m) => (m.material as THREE.Material).transparent)!.material as THREE.Material
  seeThrough.addEventListener('dispose', freed)

  for (let i = 1; i <= 4; i++) {
    await act(async () => { state.advance(i) })
    expect(group.parent, `frame ${i}`).toBe(state.scene)
  }
  await act(async () => { state.advance(5) })
  expect(group.parent).toBeNull()
  expect(freed).toHaveBeenCalledTimes(1)
})
