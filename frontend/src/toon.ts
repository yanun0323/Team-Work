// Banded "toon" lighting for every Fusion surface, so light falls in a few flat steps like pixel art.

import * as THREE from 'three'

/**
 * Shadows, complete and without acne, in two halves:
 *
 * - A face turned away from the sun gets no sunlight at all, so it is put in full shadow outright instead
 *   of being looked up in the shadow map. Looking it up compared it with itself (casters were drawn into
 *   the map by these same faces), which speckled, and the extra bias that hid the speckles also let light
 *   in along edges and over parts of faces.
 * - Casters are drawn into the map by their sun-facing faces (`shadowSide`, set on every material here).
 *   A floor next to a wall, or one wall at its corner with another, is then behind the whole thickness of
 *   the wall in the map, not level with its inner face, so the bias no longer opens a lit seam there.
 */
{
  const from = 'directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ]'
  const chunk = THREE.ShaderChunk.lights_fragment_begin
  if (!chunk.includes(from)) console.warn('toon: shadow chunk changed, faces turned from the sun are not put in shadow')
  THREE.ShaderChunk.lights_fragment_begin = chunk.replace(
    from,
    'directLight.color *= ( directLight.visible && receiveShadow ) ? dot( geometryNormal, directLight.direction ) <= 0.0 ? 1.0 - directionalLightShadow.shadowIntensity : getShadow( directionalShadowMap[ i ]',
  )
}

/** Casters go into the shadow map by their sun-facing faces; see above. */
export function sunSide<M extends THREE.Material>(m: M): M {
  m.shadowSide = THREE.FrontSide
  return m
}

/** Three light steps: shade, half-lit, lit. */
const gradient = (() => {
  const t = new THREE.DataTexture(new Uint8Array([110, 190, 255]), 3, 1, THREE.RedFormat)
  t.minFilter = t.magFilter = THREE.NearestFilter
  t.generateMipmaps = false
  t.needsUpdate = true
  return t
})()

const cache = new Map<string, THREE.MeshToonMaterial>()

export function toon(color: string): THREE.MeshToonMaterial {
  let m = cache.get(color)
  if (!m) {
    m = sunSide(new THREE.MeshToonMaterial({ color, gradientMap: gradient }))
    cache.set(color, m)
  }
  return m
}

export function toonMap(color: string, map: THREE.Texture | null): THREE.MeshToonMaterial {
  return sunSide(new THREE.MeshToonMaterial({ color, map, gradientMap: gradient }))
}

/** White, for per-instance colours. */
export const toonInstanced = () => sunSide(new THREE.MeshToonMaterial({ color: '#ffffff', gradientMap: gradient }))

/**
 * Toon material that alternates two shades by world cell, so the grid shows on smooth land.
 * Cells are `cell` world units wide; `shift` (in cells) moves their borders onto the grid's.
 */
export function toonChecker(a: string, b: string, shift: [number, number], cell: number): THREE.MeshToonMaterial {
  const m = sunSide(new THREE.MeshToonMaterial({ color: '#ffffff', gradientMap: gradient }))
  const uniforms = { uA: { value: new THREE.Color(a) }, uB: { value: new THREE.Color(b) }, uShift: { value: new THREE.Vector2(...shift) }, uCell: { value: cell } }
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCellWorld;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvCellWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCellWorld;\nuniform vec3 uA;\nuniform vec3 uB;\nuniform vec2 uShift;\nuniform float uCell;')
      .replace(
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        `float parity = mod(floor(vCellWorld.x / uCell + uShift.x) + floor(vCellWorld.z / uCell + uShift.y), 2.0);
        vec4 diffuseColor = vec4(mix(uA, uB, parity), opacity);`,
      )
  }
  m.customProgramCacheKey = () => 'fusion-checker'
  return m
}
