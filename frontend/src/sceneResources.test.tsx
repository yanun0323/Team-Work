import { act, createRoot, extend } from '@react-three/fiber'
import * as THREE from 'three'
import { afterEach, expect, it, vi } from 'vitest'
import { Island, useLand } from './Island'
import { Ocean } from './Ocean'
import { layoutTown, type Town } from './layout'
import { PixelPass } from './PixelPass'
import { toon } from './toon'

extend({ Group: THREE.Group, Mesh: THREE.Mesh, PlaneGeometry: THREE.PlaneGeometry })
vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
const roots: ReturnType<typeof createRoot>[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => { root.unmount() })
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function setup() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const canvas = {} as HTMLCanvasElement
  const gl = {
    render: vi.fn(), setSize: vi.fn(), setPixelRatio: vi.fn(),
    setRenderTarget: vi.fn(), clear: vi.fn(), shadowMap: { autoUpdate: true, needsUpdate: false },
    domElement: canvas,
  } as unknown as THREE.WebGLRenderer
  const root = createRoot(canvas)
  roots.push(root)
  await root.configure({ gl, orthographic: true, frameloop: 'never', dpr: 1, size: { width: 800, height: 600, top: 0, left: 0 } })
  return { root, gl }
}

it('releases replaced island and ocean resources, but keeps shared materials and unchanged land', async () => {
  const { root } = await setup()
  let land!: ReturnType<typeof useLand>
  function View({ town }: { town: Town }) {
    land = useLand(town)
    return <><Island town={town} land={land} /><Ocean map={land.sea} calm /></>
  }
  const town = (n: number) => layoutTown(Array.from({ length: n }, (_, i) => ({ id: `t${i}`, name: `T${i}`, members: 3 })))
  let state!: ReturnType<ReturnType<typeof root.render>['getState']>
  await act(async () => { state = root.render(<View town={town(1)} />).getState() })
  const resources = () => {
    const owned: Array<THREE.BufferGeometry | THREE.Material | THREE.Texture> = [land.sea.texture]
    const meshes: THREE.Mesh[] = []
    state.scene.traverse((o) => { if (o instanceof THREE.Mesh) meshes.push(o) })
    // Four island slabs and the sea; only the checker and sea materials are owned here.
    owned.push(...meshes.slice(0, 4).map((m) => m.geometry))
    owned.push((meshes[0].material as THREE.Material[])[0], meshes.at(-1)!.material as THREE.Material)
    return owned.map((resource) => {
      const dispose = vi.fn()
      resource.addEventListener('dispose', dispose)
      return { resource, dispose }
    })
  }
  const shared = vi.spyOn(toon('#6aa84f'), 'dispose')
  let previous = resources()
  const unchanged = land
  await act(async () => { root.render(<View town={town(1)} />) })
  expect(land).toBe(unchanged)
  for (const r of previous) expect(r.dispose).not.toHaveBeenCalled()

  for (const n of [3, 1, 4, 2]) {
    await act(async () => { root.render(<View town={town(n)} />) })
    for (const r of previous) expect(r.dispose, `unreleased ${r.resource.type}`).toHaveBeenCalledTimes(1)
    previous = resources()
    expect(shared).not.toHaveBeenCalled()
  }
  await act(async () => { root.render(<></>) })
  for (const r of previous) expect(r.dispose, `unreleased on unmount: ${r.resource.type}`).toHaveBeenCalledTimes(1)
  expect(shared).not.toHaveBeenCalled()
})

it('releases the pixel compositor geometry together with its targets and materials', async () => {
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal('document', Object.assign(new EventTarget(), { hidden: false, hasFocus: () => true }))
  vi.stubGlobal('window', new EventTarget())
  const { root, gl } = await setup()
  const targetDispose = vi.spyOn(THREE.WebGLRenderTarget.prototype, 'dispose')
  let state!: ReturnType<ReturnType<typeof root.render>['getState']>
  await act(async () => { state = root.render(<PixelPass />).getState() })
  await act(async () => { state.advance(1) })
  const calls = vi.mocked(gl.render).mock.calls
  expect(calls).toHaveLength(3)
  const compositor = calls[2][0] as THREE.Scene
  const quad = compositor.children[0] as THREE.Mesh
  const geometry = vi.spyOn(quad.geometry, 'dispose')
  const material = vi.spyOn(quad.material as THREE.Material, 'dispose')
  targetDispose.mockClear() // setSize also disposes the old framebuffer
  await act(async () => { root.render(<></>) })
  expect(geometry).toHaveBeenCalledTimes(1)
  expect(material).toHaveBeenCalledTimes(1)
  expect(targetDispose).toHaveBeenCalledTimes(2)
})

it('follows the display refresh with focus, paces background frames without polling it, pauses hidden', async () => {
  const doc = Object.assign(new EventTarget(), { hidden: false, hasFocus: (): boolean => false })
  const win = new EventTarget()
  vi.stubGlobal('document', doc)
  vi.stubGlobal('window', win)
  const { root } = await setup()
  let state!: ReturnType<ReturnType<typeof root.render>['getState']>
  await act(async () => { state = root.render(<></>).getState() })
  const invalidate = vi.fn()
  state.set({ invalidate })
  vi.useFakeTimers()
  const raf = vi.fn((f: FrameRequestCallback) => setTimeout(() => f(performance.now()), 16))
  vi.stubGlobal('requestAnimationFrame', raf)
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
  await act(async () => { root.render(<PixelPass />) })
  invalidate.mockClear()
  await act(async () => { vi.advanceTimersByTime(1000) })
  expect(invalidate.mock.calls.length).toBeGreaterThanOrEqual(4)
  expect(invalidate.mock.calls.length).toBeLessThanOrEqual(6)
  expect(raf.mock.calls.length, 'background scheduler woke on every display refresh').toBeLessThanOrEqual(6)

  doc.hidden = true
  doc.dispatchEvent(new Event('visibilitychange'))
  invalidate.mockClear()
  await act(async () => { vi.advanceTimersByTime(1000) })
  expect(invalidate).not.toHaveBeenCalled()

  doc.hidden = false
  doc.hasFocus = () => true
  doc.dispatchEvent(new Event('visibilitychange'))
  expect(invalidate).toHaveBeenCalledTimes(1)
  invalidate.mockClear()
  await act(async () => { vi.advanceTimersByTime(1000) })
  // one frame per display refresh, 16ms apart here
  expect(invalidate.mock.calls.length).toBeGreaterThanOrEqual(61)
  expect(invalidate.mock.calls.length).toBeLessThanOrEqual(63)

  doc.hasFocus = () => false
  win.dispatchEvent(new Event('blur'))
  invalidate.mockClear()
  await act(async () => { vi.advanceTimersByTime(1000) })
  expect(invalidate.mock.calls.length).toBeGreaterThanOrEqual(4)
  expect(invalidate.mock.calls.length).toBeLessThanOrEqual(6)
  await act(async () => { root.render(<></>) })
  invalidate.mockClear()
  win.dispatchEvent(new Event('focus'))
  doc.dispatchEvent(new Event('visibilitychange'))
  await act(async () => { vi.advanceTimersByTime(1000) })
  expect(invalidate).not.toHaveBeenCalled()
})
