// Dev builds only: how many frames a second the town is really drawing, and what each costs, in the debug strip.

import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useState } from 'react'

let frames = 0
let since = performance.now()
let calls = 0
let busy = 0
let started = 0

/** Before every other frame callback, so the time counted covers them all. */
const FIRST = -1000
/** After PixelPass (1), which does the drawing. */
const LAST = 1000

/**
 * Inside the canvas: counts the frames drawn, the draw calls each makes (shadow, colour, normal and the final pass
 * together) and the main thread's time from the first frame callback to the end of the drawing. The canvas runs on
 * demand, so these are only the real frames.
 */
export function FrameCounter() {
  const gl = useThree((s) => s.gl)
  // three.js clears its counts on every render call by default; PixelPass makes several a frame
  useEffect(() => {
    gl.info.autoReset = false
    gl.info.reset()
    return () => void (gl.info.autoReset = true)
  }, [gl])
  useFrame(() => void (started = performance.now()), FIRST)
  useFrame(() => {
    frames++
    busy += performance.now() - started
    calls += gl.info.render.calls
    gl.info.reset()
  }, LAST)
  return null
}

export interface FrameStats {
  /** Frames a second. */
  fps: number
  /** Draw calls a frame, on average. */
  calls: number
  /** Main-thread milliseconds a frame spends updating and drawing the town, on average. */
  ms: number
}

/** What the frames drawn since the last call cost, and starts counting again. */
export function frameStats(now = performance.now()): FrameStats {
  const fps = now > since ? Math.round((frames * 1000) / (now - since)) : 0
  const stats = { fps, calls: frames ? Math.round(calls / frames) : 0, ms: frames ? busy / frames : 0 }
  frames = calls = busy = 0
  since = now
  return stats
}

const EVERY = 500

export function FpsDebug() {
  const [stats, setStats] = useState<FrameStats | null>(null)
  useEffect(() => {
    frameStats()
    const id = setInterval(() => setStats(frameStats()), EVERY)
    return () => clearInterval(id)
  }, [])
  return (
    <div className="fx-daylight-debug fx-tag">
      <output className="fx-fps">{stats?.fps ?? '–'} FPS</output>
      <output className="fx-fps">{stats?.calls ?? '–'} draws</output>
      <output className="fx-fps">{stats ? stats.ms.toFixed(1) : '–'} ms</output>
    </div>
  )
}
