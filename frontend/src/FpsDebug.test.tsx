import { act, createRoot } from '@react-three/fiber'
import { renderToStaticMarkup } from 'react-dom/server'
import type * as THREE from 'three'
import { afterEach, expect, it, vi } from 'vitest'
import { FpsDebug, FrameCounter, frameRate } from './FpsDebug'

const roots: ReturnType<typeof createRoot>[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => { root.unmount() })
  vi.unstubAllGlobals()
})

it('counts the frames the canvas draws, as frames a second since the last reading', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const canvas = {} as HTMLCanvasElement
  const gl = { render: vi.fn(), setSize: vi.fn(), setPixelRatio: vi.fn(), domElement: canvas } as unknown as THREE.WebGLRenderer
  const root = createRoot(canvas)
  roots.push(root)
  await root.configure({ gl, frameloop: 'never', dpr: 1, size: { width: 100, height: 100, top: 0, left: 0 } })
  let state!: ReturnType<ReturnType<typeof root.render>['getState']>
  await act(async () => { state = root.render(<FrameCounter />).getState() })

  frameRate(1000)
  for (let i = 0; i < 30; i++) state.advance(i)
  expect(frameRate(1500)).toBe(60)
  expect(frameRate(2000), 'counting starts again after each reading').toBe(0)
  for (let i = 0; i < 12; i++) state.advance(i)
  expect(frameRate(3000)).toBe(12)
})

it('shows a dash until the first reading', () => {
  expect(renderToStaticMarkup(<FpsDebug />)).toContain('<output class="fx-fps">– FPS</output>')
})
