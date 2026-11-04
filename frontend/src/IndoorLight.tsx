// Lights left on indoors: an open office or the airport's inside stays evenly lit after dark.
//
// A room marks the box it fills with `<IndoorRoom>`; every surface inside that box (in world space) gets the
// same extra light, brightening with the dark (`light.glow`). Point lights were tried first, but under toon
// shading they drew bright rings round each lamp; a flat light over the whole box is as even as office panels.
//
// The light goes into every toon and Lambert material through the shared shader chunks, so nothing has to be
// set per material, and the faded copies (Fade.tsx) get it too. Its uniforms are added to ShaderLib before
// any program is built; ShaderLib uniforms are cloned per material, except plain objects, which stay shared,
// so `slots` below is what every material reads.

import { useFrame } from '@react-three/fiber'
import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { light } from './daylight'

/** Neutral white, as office panels and terminals have, and how strong it is at full night. */
const COLOR = new THREE.Color('#fff8ee')
const STRENGTH = 2.4
/** How many rooms can be lit at once: the terminal hall and the tower's cab. */
const SLOTS = 2

type V3 = { x: number; y: number; z: number }
const v3 = (): V3 => ({ x: 0, y: 0, z: 0 })
const slots = Array.from({ length: SLOTS }, () => ({ min: v3(), max: v3() }))
const shine = v3()

{
  const uniforms: Record<string, { value: V3 }> = { indoorLight: { value: shine } }
  slots.forEach((s, i) => {
    uniforms[`indoorMin${i}`] = { value: s.min }
    uniforms[`indoorMax${i}`] = { value: s.max }
  })
  for (const id of ['toon', 'lambert'] as const) Object.assign(THREE.ShaderLib[id].uniforms, uniforms)
  const inside = slots.map((_, i) => `indoorIn(indoorAt, indoorMin${i}, indoorMax${i})`).join(', ')
  THREE.ShaderChunk.lights_pars_begin += `
uniform vec3 indoorLight;
${slots.map((_, i) => `uniform vec3 indoorMin${i};\nuniform vec3 indoorMax${i};`).join('\n')}
float indoorIn(vec3 p, vec3 a, vec3 b) { return step(a.x, p.x) * step(p.x, b.x) * step(a.y, p.y) * step(p.y, b.y) * step(a.z, p.z) * step(p.z, b.z); }
`
  const from = 'vec3 irradiance = getAmbientLightIrradiance( ambientLightColor );'
  const chunk = THREE.ShaderChunk.lights_fragment_begin
  if (!chunk.includes(from)) console.warn('IndoorLight: light chunk changed, rooms are not lit at night')
  THREE.ShaderChunk.lights_fragment_begin = chunk.replace(from, `${from}
	{
		vec3 indoorAt = ( ( vec4( geometryPosition, 1.0 ) - viewMatrix[ 3 ] ) * viewMatrix ).xyz;
		irradiance += indoorLight * max(${inside.includes(',') ? inside : `${inside}, 0.0`});
	}`)
}

const rooms = new Set<{ at: THREE.Object3D; min: THREE.Vector3; max: THREE.Vector3 }>()

/** The box a room fills, in its parent's coordinates: lit evenly after dark while it is shown. */
export function IndoorRoom({ min, max }: { min: [number, number, number]; max: [number, number, number] }) {
  const ref = useRef<THREE.Group>(null)
  const [x0, y0, z0] = min
  const [x1, y1, z1] = max
  useEffect(() => {
    const at = ref.current
    if (!at) return
    const room = { at, min: new THREE.Vector3(x0, y0, z0), max: new THREE.Vector3(x1, y1, z1) }
    rooms.add(room)
    return () => void rooms.delete(room)
  }, [x0, y0, z0, x1, y1, z1])
  return <group ref={ref} />
}

const a = new THREE.Vector3()
const b = new THREE.Vector3()

/** Puts the shown rooms and tonight's indoor light into the shared uniforms; once in the scene. */
export function IndoorLights() {
  useFrame(() => {
    const strength = STRENGTH * light.glow
    shine.x = COLOR.r * strength
    shine.y = COLOR.g * strength
    shine.z = COLOR.b * strength
    const shown = [...rooms]
    slots.forEach((s, i) => {
      const room = shown[i]
      if (!room) {
        // an empty box: nothing is inside it
        Object.assign(s.min, { x: 1e9, y: 1e9, z: 1e9 })
        Object.assign(s.max, { x: -1e9, y: -1e9, z: -1e9 })
        return
      }
      // rooms are only ever moved, never turned
      a.copy(room.min).applyMatrix4(room.at.matrixWorld)
      b.copy(room.max).applyMatrix4(room.at.matrixWorld)
      Object.assign(s.min, { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), z: Math.min(a.z, b.z) })
      Object.assign(s.max, { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y), z: Math.max(a.z, b.z) })
    })
  })
  return null
}
