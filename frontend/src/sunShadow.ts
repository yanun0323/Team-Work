// Fits the sun's shadow box to what the camera sees. No React.

import * as THREE from 'three'

/** Side of the sun's shadow map, in texels. */
export const SHADOW_MAP = 2048

/** World units added round the view, for the pixel pass's shift and anything a hair off screen. */
const MARGIN = 2

/**
 * The sun's normal bias: about one and a half shadow-map texels, so a surface doesn't shadow itself (shadow acne),
 * and no more, or thin casters such as bench slats lose their shadows.
 */
export const sunNormalBias = (half: number) => Math.max(0.02, ((half * 2) / SHADOW_MAP) * 1.5)

/**
 * How far, in world units, a surface may stand behind the nearest caster in the map and still count as lit. Far less
 * than a wall is thick (0.2): more, and the low morning sun shines through the corner of two walls and along the
 * foot of a wall. Faces turned from the sun are shaded outright (toon.ts), so they need none.
 */
export const SUN_DEPTH_BIAS = 0.05

/**
 * The sun's depth bias for a shadow camera reaching from `near` to `far`. three.js counts it in the map's depth, 0 to 1
 * over that reach, so a fixed number grows with the town (its reach does); this keeps it SUN_DEPTH_BIAS in the world.
 */
export const sunDepthBias = (near: number, far: number) => -SUN_DEPTH_BIAS / (far - near)

export interface SunShadow {
  /** Where the light looks, on the plane through the origin across the sunlight. */
  center: THREE.Vector3
  /** Half the side of the shadow box. */
  half: number
}

/**
 * The smallest square shadow box, seen from the sun, that holds every point the camera sees, so its texels are as fine
 * as they can be: a box over the whole town makes them coarser than the screen's pixels once zoomed in, which breaks
 * up thin shadows and jags their edges. A shadow lies along the sunlight from what casts it, so covering what is seen
 * covers whatever casts onto it too.
 *
 * `seen` are points bounding what the camera sees; `townHalf` is the box over the whole town, never exceeded. The size
 * goes in steps and the centre moves by whole texels, so panning and zooming don't make shadow edges crawl.
 */
export function fitSunShadow(seen: THREE.Vector3[], toSun: THREE.Vector3, townHalf: number): SunShadow {
  const basis = new THREE.Matrix4().lookAt(toSun, new THREE.Vector3(), THREE.Object3D.DEFAULT_UP)
  const x = new THREE.Vector3().setFromMatrixColumn(basis, 0)
  const y = new THREE.Vector3().setFromMatrixColumn(basis, 1)
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity
  for (const p of seen) {
    const u = p.dot(x), v = p.dot(y)
    minU = Math.min(minU, u); maxU = Math.max(maxU, u)
    minV = Math.min(minV, v); maxV = Math.max(maxV, v)
  }
  const need = Math.max(maxU - minU, maxV - minV) / 2 + MARGIN
  // a quarter octave a step
  const stepped = 2 ** (Math.ceil(Math.log2(need) * 4) / 4)
  if (!(stepped < townHalf)) return { center: new THREE.Vector3(), half: townHalf }
  const texel = (stepped * 2) / SHADOW_MAP
  const u = Math.round((minU + maxU) / 2 / texel) * texel
  const v = Math.round((minV + maxV) / 2 / texel) * texel
  return { center: x.multiplyScalar(u).addScaledVector(y, v), half: stepped }
}

const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const

/** Where the camera's view meets the ground and the height `top` above it. */
export function seenPoints(camera: THREE.Camera, top: number): THREE.Vector3[] {
  const forward = camera.getWorldDirection(new THREE.Vector3())
  const out: THREE.Vector3[] = []
  for (const [sx, sy] of corners) {
    const from = new THREE.Vector3(sx, sy, -1).unproject(camera)
    for (const h of [-1, top]) {
      // the camera looks down, so every corner ray reaches both heights
      const t = (h - from.y) / forward.y
      out.push(from.clone().addScaledVector(forward, t))
    }
  }
  return out
}
