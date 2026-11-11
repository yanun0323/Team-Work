// Dev builds only: how many frames a second the town is really drawing, in the debug strip.

import { useFrame } from '@react-three/fiber'
import { useEffect, useState } from 'react'

let frames = 0
let since = performance.now()

/** Inside the canvas: counts the frames drawn. The canvas runs on demand, so these are only the real ones. */
export function FrameCounter() {
  useFrame(() => void frames++)
  return null
}

/** Frames a second drawn since the last call, and starts counting again. */
export function frameRate(now = performance.now()): number {
  const fps = now > since ? Math.round((frames * 1000) / (now - since)) : 0
  frames = 0
  since = now
  return fps
}

const EVERY = 500

export function FpsDebug() {
  const [fps, setFps] = useState<number | null>(null)
  useEffect(() => {
    frameRate()
    const id = setInterval(() => setFps(frameRate()), EVERY)
    return () => clearInterval(id)
  }, [])
  return (
    <div className="fx-daylight-debug fx-tag">
      <output className="fx-fps">{fps ?? '–'} FPS</output>
    </div>
  )
}
