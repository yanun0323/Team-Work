import { act, createRoot, useFrame } from '@react-three/fiber'
import { renderToStaticMarkup } from 'react-dom/server'
import type * as THREE from 'three'
import { afterEach, expect, it, vi } from 'vitest'
import { FpsDebug, FrameCounter, frameStats } from './FpsDebug'

const roots: ReturnType<typeof createRoot>[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => { root.unmount() })
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

async function canvasWith(children: React.ReactNode) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const canvas = {} as HTMLCanvasElement
  const info = { autoReset: true, render: { calls: 0 }, reset: vi.fn(() => void (info.render.calls = 0)) }
  const gl = { render: vi.fn(), setSize: vi.fn(), setPixelRatio: vi.fn(), domElement: canvas, info } as unknown as THREE.WebGLRenderer
  const root = createRoot(canvas)
  roots.push(root)
  await root.configure({ gl, frameloop: 'never', dpr: 1, size: { width: 100, height: 100, top: 0, left: 0 } })
  let state!: ReturnType<ReturnType<typeof root.render>['getState']>
  await act(async () => { state = root.render(<>{children}</>).getState() })
  return { state, info }
}

it('counts the frames the canvas draws, as frames a second since the last reading', async () => {
  const { state } = await canvasWith(<FrameCounter />)
  frameStats(1000)
  for (let i = 0; i < 30; i++) state.advance(i)
  expect(frameStats(1500).fps).toBe(60)
  expect(frameStats(2000).fps, 'counting starts again after each reading').toBe(0)
  for (let i = 0; i < 12; i++) state.advance(i)
  expect(frameStats(3000).fps).toBe(12)
})

/** Stands in for PixelPass: draws `calls` times and takes `ms` of the main thread each frame. */
function Drawer({ calls, ms, clock }: { calls: number; ms: number; clock: { now: number } }) {
  useFrame(({ gl }) => {
    gl.info.render.calls += calls
    clock.now += ms
  }, 1)
  return null
}

it('adds up every draw call of a frame and the time spent on it, and averages them over the frames', async () => {
  const clock = { now: 0 }
  vi.spyOn(performance, 'now').mockImplementation(() => clock.now)
  const { state, info } = await canvasWith(<><FrameCounter /><Drawer calls={300} ms={4} clock={clock} /></>)
  expect(info.autoReset, 'three.js must not clear the counts between the passes of one frame').toBe(false)
  frameStats(0)
  for (let i = 0; i < 4; i++) state.advance(i)
  const stats = frameStats(1000)
  expect(stats.calls).toBe(300)
  expect(stats.ms).toBe(4)
  expect(frameStats(2000), 'nothing drawn since').toEqual({ fps: 0, calls: 0, ms: 0 })
})

it('shows dashes until the first reading', () => {
  const html = renderToStaticMarkup(<FpsDebug />)
  expect(html).toContain('<output class="fx-fps">– FPS</output>')
  expect(html).toContain('<output class="fx-fps">– draws</output>')
  expect(html).toContain('<output class="fx-fps">– ms</output>')
})
