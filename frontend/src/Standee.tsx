// The employee as they will look in the office, for the hire and edit sheets: the same figure twice,
// walking and seated at work (on thin air, with no chair or desk), seen from the map's 45° angle
// and drawn small and coarse so it reads as pixel art like the map.

import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { useLayoutEffect, useMemo } from 'react'
import * as THREE from 'three'
import type { Look } from './core/domain/types'
import { Figure, LEG_SWING, newRig } from './People'

const calm = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

type Pose = 'walk' | 'sit'
const POSES: Pose[] = ['walk', 'sit']
const ZOOM = 72
/** Steps a second, and how far legs and arms swing, as in the office. */
const STEPS = 7
// a three-quarter view: turned 45° from the camera, towards the viewer's left
const FACING = Math.PI

function Posed({ look, seed, pose, at }: { look: Look; seed: number; pose: Pose; at: number }) {
  const rig = useMemo(newRig, [])
  // each figure centred in its own half of the strip, however wide it is
  const gap = useThree((s) => s.size.width) / POSES.length / ZOOM
  useLayoutEffect(() => {
    if (!rig.root || !rig.seated || !rig.standing) return
    rig.seated.visible = pose === 'sit'
    rig.standing.visible = pose !== 'sit'
    rig.root.rotation.y = FACING
    // the screen's left-right axis is (1, 0, -1) for a camera on (1, y, 1)
    rig.root.position.set(at * gap * Math.SQRT1_2, 0, -at * gap * Math.SQRT1_2)
    swing(rig, pose === 'walk' ? 0.8 : 0)
  }, [rig, look, seed, pose, at, gap])
  useFrame(({ clock }) => {
    if (pose === 'walk' && !calm) swing(rig, Math.sin(clock.elapsedTime * STEPS))
  })
  return <Figure look={look} rig={rig} seed={seed} />
}

function swing(rig: ReturnType<typeof newRig>, s: number) {
  rig.legs.forEach((l, i) => l && (l.rotation.x = s * LEG_SWING * rig.stride * (i ? -1 : 1)))
  rig.arms.forEach((a, i) => a && (a.rotation.x = s * 0.45 * (i ? 1 : -1)))
  if (rig.root) rig.root.position.y = Math.abs(s) * 0.03
}

export function Standee({ look, seed }: { look: Look; seed: number }) {
  return (
    <div className="fx-standee" aria-hidden="true">
      <Canvas orthographic dpr={0.5} gl={{ antialias: false, alpha: true }}
        camera={{ position: [2, 1.6, 2], zoom: ZOOM, near: 0.1, far: 20 }}
        onCreated={({ gl, camera }) => {
          gl.toneMapping = THREE.NoToneMapping
          camera.lookAt(0, 0.55, 0)
        }}>
        <hemisphereLight args={['#fff4e0', '#7fb6d6', 1.5]} />
        <directionalLight position={[3, 5, 2]} intensity={1.6} />
        {POSES.map((p, i) => <Posed key={p} look={look} seed={seed} pose={p} at={i - (POSES.length - 1) / 2} />)}
      </Canvas>
    </div>
  )
}
