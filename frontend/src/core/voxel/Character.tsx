import { useFrame } from '@react-three/fiber'
import { useRef } from 'react'
import * as THREE from 'three'
import type { Look } from '../domain/types'
import { Vox } from './kit'

export type Pose = 'sit' | 'stand' | 'raise'
/** classic: office worker. visor: hoodie and glowing visor. chibi: big head, short body. */
export type Build = 'classic' | 'visor' | 'chibi'

interface Dims { leg: number; legW: number; body: [number, number, number]; arm: number; head: number }
const DIMS: Record<Build, Dims> = {
  classic: { leg: 0.46, legW: 0.2, body: [0.52, 0.52, 0.3], arm: 0.44, head: 0.44 },
  visor: { leg: 0.48, legW: 0.2, body: [0.56, 0.54, 0.34], arm: 0.46, head: 0.44 },
  chibi: { leg: 0.24, legW: 0.2, body: [0.5, 0.38, 0.32], arm: 0.32, head: 0.66 },
}

/** Height of the top of the head, for placing tags and alerts. */
export const headTop = (b: Build) => {
  const d = DIMS[b]
  return d.leg + 0.02 + d.body[1] + d.head + 0.12
}

/** Voxel person. `poseRef` and `walkRef` are read every frame so the parent animates without re-rendering. */
export function Character({ look, build = 'classic', poseRef, walkRef }: {
  look: Look
  build?: Build
  poseRef: { current: Pose }
  walkRef: { current: number }
}) {
  const legL = useRef<THREE.Group>(null)
  const legR = useRef<THREE.Group>(null)
  const armL = useRef<THREE.Group>(null)
  const armR = useRef<THREE.Group>(null)
  const body = useRef<THREE.Group>(null)
  const clock = useRef(Math.random() * 10)
  const d = DIMS[build]

  useFrame((_, dt) => {
    clock.current += dt
    const t = clock.current
    const walk = walkRef.current
    const pose = poseRef.current
    const [ll, lr, al, ar, b] = [legL.current, legR.current, armL.current, armR.current, body.current]
    if (!ll || !lr || !al || !ar || !b) return
    al.rotation.z = 0
    ar.rotation.z = 0
    b.position.y = 0
    if (walk > 0) {
      const s = Math.sin(t * 11)
      ll.rotation.x = s * 0.6
      lr.rotation.x = -s * 0.6
      al.rotation.x = -s * 0.5
      ar.rotation.x = s * 0.5
      b.position.y = Math.abs(Math.cos(t * 11)) * 0.05
    } else if (pose === 'sit') {
      ll.rotation.x = -Math.PI / 2
      lr.rotation.x = -Math.PI / 2
      al.rotation.x = -1.15 + Math.sin(t * 16) * 0.12
      ar.rotation.x = -1.15 + Math.sin(t * 16 + 1.7) * 0.12
    } else if (pose === 'raise') {
      ll.rotation.x = 0
      lr.rotation.x = 0
      al.rotation.x = 0
      ar.rotation.x = -Math.PI + 0.15
      ar.rotation.z = Math.sin(t * 6) * 0.25
      b.position.y = Math.abs(Math.sin(t * 3)) * 0.05
    } else {
      ll.rotation.x = 0
      lr.rotation.x = 0
      al.rotation.x = Math.sin(t * 1.5) * 0.05
      ar.rotation.x = -Math.sin(t * 1.5) * 0.05
      b.position.y = build === 'chibi' ? Math.abs(Math.sin(t * 2)) * 0.03 : 0
    }
  })

  const eye = '#1d1d24'
  const hip = d.leg + 0.02
  const bodyY = hip + d.body[1] / 2
  const shoulder = hip + d.body[1] - 0.06
  const headY = hip + d.body[1] + d.head / 2
  const h = d.head
  const face = h / 2 + 0.005
  const armX = d.body[0] / 2 + 0.09
  return (
    <group ref={body}>
      <group ref={legL} position={[-0.12, hip, 0]}>
        <Vox p={[0, -d.leg / 2, 0]} s={[d.legW, d.leg, 0.22]} c={look.pants} />
      </group>
      <group ref={legR} position={[0.12, hip, 0]}>
        <Vox p={[0, -d.leg / 2, 0]} s={[d.legW, d.leg, 0.22]} c={look.pants} />
      </group>
      <Vox p={[0, bodyY, 0]} s={d.body} c={look.shirt} />
      {build === 'visor' && <Vox p={[0, bodyY, d.body[2] / 2 + 0.01]} s={[0.08, d.body[1] * 0.8, 0.02]} c={look.shirt} e={look.shirt} shadow={false} />}
      {build === 'visor' && <Vox p={[0, headY - h * 0.45, -0.12]} s={[0.5, 0.18, 0.3]} c={look.shirt} />}
      <group ref={armL} position={[-armX, shoulder, 0]}>
        <Vox p={[0, -d.arm / 2 + 0.02, 0]} s={[0.16, d.arm, 0.18]} c={look.shirt} />
        <Vox p={[0, -d.arm + 0.0, 0]} s={[0.14, 0.08, 0.16]} c={look.skin} />
      </group>
      <group ref={armR} position={[armX, shoulder, 0]}>
        <Vox p={[0, -d.arm / 2 + 0.02, 0]} s={[0.16, d.arm, 0.18]} c={look.shirt} />
        <Vox p={[0, -d.arm + 0.0, 0]} s={[0.14, 0.08, 0.16]} c={look.skin} />
      </group>
      <Vox p={[0, headY, 0]} s={[h, h, h]} c={look.skin} />
      {/* hair: top and back */}
      <Vox p={[0, headY + h / 2 + 0.03, -0.02]} s={[h + 0.04, 0.12, h + 0.06]} c={look.hair} />
      <Vox p={[0, headY + h * 0.12, -h / 2]} s={[h + 0.04, h * 0.76, 0.08]} c={look.hair} />
      {build === 'chibi' && <Vox p={[-h / 2 + 0.06, headY + h * 0.3, h / 2 - 0.06]} s={[0.16, 0.14, 0.14]} c={look.hair} />}
      {build === 'visor' ? (
        <Vox p={[0, headY + h * 0.05, face]} s={[h * 0.92, h * 0.2, 0.03]} c="#7df9ff" e="#2fe0ff" shadow={false} />
      ) : (
        <>
          <Vox p={[-h * 0.23, headY + 0.02, face]} s={[0.07, build === 'chibi' ? 0.11 : 0.08, 0.02]} c={eye} shadow={false} />
          <Vox p={[h * 0.23, headY + 0.02, face]} s={[0.07, build === 'chibi' ? 0.11 : 0.08, 0.02]} c={eye} shadow={false} />
        </>
      )}
      {build === 'chibi' && (
        <>
          <Vox p={[-h * 0.33, headY - h * 0.14, face]} s={[0.1, 0.05, 0.02]} c="#f59a9a" shadow={false} />
          <Vox p={[h * 0.33, headY - h * 0.14, face]} s={[0.1, 0.05, 0.02]} c="#f59a9a" shadow={false} />
        </>
      )}
      {look.extra === 'glasses' && build !== 'visor' && <Vox p={[0, headY + 0.03, face + 0.01]} s={[h * 0.9, 0.05, 0.02]} c={eye} shadow={false} />}
      {look.extra === 'cap' && (
        <>
          <Vox p={[0, headY + h / 2 + 0.06, 0]} s={[h + 0.06, 0.12, h + 0.06]} c={look.shirt} />
          <Vox p={[0, headY + h / 2 + 0.02, h / 2 + 0.1]} s={[h * 0.9, 0.04, 0.22]} c={look.shirt} />
        </>
      )}
      {look.extra === 'headset' && (
        <>
          <Vox p={[0, headY + h / 2 + 0.1, 0]} s={[h + 0.06, 0.06, 0.08]} c="#2a2a33" />
          <Vox p={[-h / 2 - 0.03, headY, 0]} s={[0.07, 0.18, 0.16]} c="#2a2a33" />
          <Vox p={[h / 2 + 0.03, headY, 0]} s={[0.07, 0.18, 0.16]} c="#2a2a33" />
        </>
      )}
    </group>
  )
}
