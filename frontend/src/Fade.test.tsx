import { act, createRoot, extend } from '@react-three/fiber'
import * as THREE from 'three'
import { afterEach, expect, it, vi } from 'vitest'
import { Fade, FADE_SECONDS } from './Fade'

extend({ Group: THREE.Group })

// Use the real React/Three renderer and frame subscriptions; only GPU drawing is stubbed.
const roots: ReturnType<typeof createRoot>[] = []
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => { root.unmount() })
})

it.each([1 / 60, 30])('restores a building when it reappears before removal commits (frame gap %s seconds)', async (gap) => {
  const canvas = {} as HTMLCanvasElement
  const gl = {
    render: vi.fn(), setSize: vi.fn(), setPixelRatio: vi.fn(),
    domElement: canvas,
  } as unknown as THREE.WebGLRenderer
  const root = createRoot(canvas)
  roots.push(root)
  await root.configure({ gl, frameloop: 'never', dpr: 1, size: { width: 800, height: 600, top: 0, left: 0 } })

  const solid = new THREE.MeshBasicMaterial()
  const glass = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.15, depthWrite: false })
  const depth = new THREE.MeshDepthMaterial()
  const single = new THREE.Mesh(new THREE.BoxGeometry(), solid)
  const multiple = new THREE.Mesh(new THREE.BoxGeometry(), [solid, glass])
  single.castShadow = true
  single.layers.set(2)
  single.customDepthMaterial = depth
  const originals = [single.material, multiple.material]
  const view = (show: boolean) => <Fade show={show}>
    <primitive object={single} dispose={null} />
    <primitive object={multiple} dispose={null} />
  </Fade>
  let state!: ReturnType<ReturnType<typeof root.render>['getState']>
  await act(async () => { state = root.render(view(true)).getState() })
  let time = 0
  const frame = (dt: number) => state.advance(time += dt)
  await act(async () => { frame(FADE_SECONDS) })
  const group = single.parent!

  try {
    // Repeat to catch permanent opacity loss across more than one focus/unfocus cycle.
    for (let cycle = 0; cycle < 2; cycle++) {
      await act(async () => { root.render(view(false)) })
      await act(async () => { frame(FADE_SECONDS - 0.001) })
      const copy = single.material
      expect(copy).not.toBe(solid)
      expect(copy.opacity).toBeLessThan(0.01)
      const disposed = vi.fn()
      copy.addEventListener('dispose', disposed)

      // Complete the fade and request visibility in the same batch: the pending
      // setMounted(false) must not leave a transparent material on the retained mesh.
      await act(async () => {
        frame(gap)
        expect(group.visible).toBe(false)
        root.render(view(true))
      })
      expect(single.parent).toBe(group)
      await act(async () => { frame(FADE_SECONDS / 2) })
      await act(async () => { frame(FADE_SECONDS) })

      expect(group.visible).toBe(true)
      expect(single.material.opacity).toBe(1)
      expect(single.material).toBe(originals[0])
      expect(multiple.material).toBe(originals[1])
      expect(glass.opacity).toBe(0.15)
      expect(glass.depthWrite).toBe(false)
      expect(single.layers.mask).toBe(1 << 2)
      expect(single.castShadow).toBe(true)
      expect(single.customDepthMaterial).toBe(depth)
      expect(multiple.customDepthMaterial).toBeUndefined()
      expect(disposed).toHaveBeenCalledTimes(1)
    }
  } finally {
    await act(async () => { root.unmount() })
    roots.splice(roots.indexOf(root), 1)
    single.geometry.dispose()
    multiple.geometry.dispose()
    solid.dispose()
    glass.dispose()
    depth.dispose()
  }
})
