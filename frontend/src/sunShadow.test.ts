import * as THREE from 'three'
import { expect, it } from 'vitest'
import { shadowHalf } from './Ambient'
import { ISO_DIR } from './camera'
import { fitSunShadow, seenPoints, SHADOW_MAP, SUN_DEPTH_BIAS, sunDepthBias, sunNormalBias } from './sunShadow'
import { WALL } from './office'

const toSun = new THREE.Vector3(-0.4, 0.8, 0.45).normalize()

/** An isometric camera like the town's, looking at `at` with `zoom` screen pixels per unit. */
function view(at: THREE.Vector3, zoom: number, width = 1100, height = 800) {
  const camera = new THREE.OrthographicCamera(-width / 2, width / 2, height / 2, -height / 2, 1, 600)
  camera.zoom = zoom
  camera.position.copy(at).addScaledVector(ISO_DIR, 200)
  camera.lookAt(at)
  camera.updateProjectionMatrix()
  camera.updateMatrixWorld()
  return camera
}

/** The point in the shadow map's square, from -1 to 1 on each side, as the light at `center` sees it. */
function inBox(p: THREE.Vector3, center: THREE.Vector3, half: number) {
  const light = new THREE.OrthographicCamera(-half, half, half, -half, 1, 400)
  light.position.copy(center).addScaledVector(toSun, 100)
  light.lookAt(center)
  light.updateMatrixWorld()
  return p.clone().project(light)
}

it('keeps the sun normal bias above a shadow texel, but small enough for thin casters', () => {
  for (const half of [5, 40, 120]) expect(sunNormalBias(half)).toBeGreaterThan((half * 2) / SHADOW_MAP)
  expect(sunNormalBias(120)).toBeGreaterThan(sunNormalBias(40))
  expect(sunNormalBias(10)).toBeLessThan(0.07)
})

it('keeps the sun depth bias a fixed world distance, well inside a wall, however big the town', () => {
  // a bias of -0.0007 in map depth was 0.24 world units over a 345-unit reach, and more in a bigger town: the low
  // morning sun then lit a seam down the corner of an office's two back walls, through the 0.2 thick wall
  for (const far of [100, 345, 900]) expect(-sunDepthBias(1, far) * (far - 1)).toBeCloseTo(SUN_DEPTH_BIAS)
  expect(SUN_DEPTH_BIAS).toBeLessThan(WALL / 2)
})

it('shrinks the shadow box to the view when zoomed in, holding everything seen', () => {
  const town = shadowHalf(124)
  const camera = view(new THREE.Vector3(30, 0, -20), 40)
  const seen = seenPoints(camera, 12)
  const fit = fitSunShadow(seen, toSun, town)
  expect(fit.half).toBeLessThan(town / 4)
  for (const p of seen) {
    const q = inBox(p, fit.center, fit.half)
    expect(Math.abs(q.x)).toBeLessThanOrEqual(1)
    expect(Math.abs(q.y)).toBeLessThanOrEqual(1)
  }
})

it('covers the whole town, as before, once the view is bigger than it', () => {
  const town = shadowHalf(40)
  const fit = fitSunShadow(seenPoints(view(new THREE.Vector3(), 6), 12), toSun, town)
  expect(fit).toEqual({ center: new THREE.Vector3(), half: town })
})

it('moves the box by whole texels and sizes it in steps, so shadow edges hold still while panning', () => {
  const town = shadowHalf(124)
  const a = fitSunShadow(seenPoints(view(new THREE.Vector3(10, 0, 10), 40), 12), toSun, town)
  const b = fitSunShadow(seenPoints(view(new THREE.Vector3(10.013, 0, 10.007), 40), 12), toSun, town)
  expect(b.half).toBe(a.half)
  // the shift, seen from the sun, is a whole number of texels across and up
  const texel = (a.half * 2) / SHADOW_MAP
  const shift = inBox(b.center, a.center, a.half)
  for (const s of [shift.x, shift.y]) {
    const texels = (s * a.half) / texel
    expect(Math.abs(texels - Math.round(texels))).toBeLessThan(1e-6)
  }
})
