import { act, createRoot } from '@react-three/fiber'
import * as THREE from 'three'
import { afterEach, expect, it, vi } from 'vitest'
import { PixelPass, shadowDue } from './PixelPass'

const roots: ReturnType<typeof createRoot>[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => { root.unmount() })
  vi.unstubAllGlobals()
})

/** How many of `frames` frames, `ms` apart, draw the shadow map. */
function drawn(ms: number, frames: number) {
  let last = -Infinity
  let n = 0
  for (let i = 0; i < frames; i++) {
    // frames come a little early or late, as they do
    const now = i * ms + (i % 2 ? 0.4 : -0.4)
    if (shadowDue(now, last)) {
      last = now
      n++
    }
  }
  return n
}

it('draws the shadow map every other frame at 120 Hz', () => {
  expect(drawn(1000 / 120, 120)).toBe(60)
})

it('draws the shadow map every frame at 60 Hz and below', () => {
  expect(drawn(1000 / 60, 60)).toBe(60)
  expect(drawn(1000 / 5, 5)).toBe(5)
})

it('draws the shadow map on the first frame', () => {
  expect(shadowDue(0, -Infinity)).toBe(true)
})

it('works out the scene\'s matrices once a frame, for the colour pass, not again for the normal pass', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  // a hidden page: PixelPass asks for no frames of its own
  vi.stubGlobal('document', { hidden: true, hasFocus: () => false, addEventListener: vi.fn(), removeEventListener: vi.fn() })
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
  const canvas = {} as HTMLCanvasElement
  const drawn: Array<[THREE.Scene, boolean]> = []
  const gl = {
    render: vi.fn((scene: THREE.Scene) => void drawn.push([scene, scene.matrixWorldAutoUpdate])),
    setRenderTarget: vi.fn(), clear: vi.fn(), shadowMap: {}, setSize: vi.fn(), setPixelRatio: vi.fn(), domElement: canvas,
  } as unknown as THREE.WebGLRenderer
  const root = createRoot(canvas)
  roots.push(root)
  await root.configure({ gl, frameloop: 'never', dpr: 1, orthographic: true, size: { width: 100, height: 100, top: 0, left: 0 } })
  let state!: ReturnType<ReturnType<typeof root.render>['getState']>
  await act(async () => { state = root.render(<PixelPass />).getState() })
  state.advance(0)
  expect(drawn.filter(([s]) => s === state.scene).map(([, auto]) => auto), 'colour pass, then normal pass').toEqual([true, false])
  expect(state.scene.matrixWorldAutoUpdate, 'given back after the frame').toBe(true)
})
