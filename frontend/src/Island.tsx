// The island body traced from the land cells: a checkered grass top with a lip, two soil bands,
// and a sandy beach running into the sea. Also bakes the sea's distance-to-shore texture.

import { useMemo } from 'react'
import * as THREE from 'three'
import { area, contours, landField, type Field, type Loop } from './land'
import { CELL, type Town } from './layout'
import { toon, toonChecker } from './toon'

export const SEA_LEVEL = -0.62
/** The beach reaches this far past the grass edge, in world units. */
export const BEACH = 1.1
const BEACH_TOP = -0.5
const LIP = 0.22
const BOTTOM = -2

/** Distance from the waterline, packed into a texture: value = (d + SEA_D0) / SEA_DSPAN. */
export const SEA_D0 = 2
export const SEA_DSPAN = 16

export interface SeaMap {
  texture: THREE.DataTexture
  /** World position of texel (0, 0)'s centre. */
  origin: THREE.Vector2
  /** Texels. */
  n: THREE.Vector2
}

export function useLand(town: Town) {
  // only the ground decides the land; buildings growing on their plots leave it as it is
  const ground = `${town.cols}x${town.rows}:${town.ground.join()}`
  return useMemo(() => {
    void ground
    const field = landField(town)
    const grass = biggest(contours(field, field.land, 0.5, true))
    const beach = biggest(contours(field, field.sdf, BEACH, false))
    return { field, grass, beach, sea: seaMap(field) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ground])
}

function biggest(loops: Loop[]) {
  return loops.reduce<Loop | null>((m, l) => (!m || Math.abs(area(l)) > Math.abs(area(m)) ? l : m), null) ?? []
}

function seaMap(field: Field): SeaMap {
  const data = new Uint8Array(field.nx * field.nz)
  for (let k = 0; k < data.length; k++) {
    data[k] = Math.round(THREE.MathUtils.clamp((field.sdf[k] - BEACH + SEA_D0) / SEA_DSPAN, 0, 1) * 255)
  }
  const texture = new THREE.DataTexture(data, field.nx, field.nz, THREE.RedFormat)
  texture.magFilter = texture.minFilter = THREE.LinearFilter
  texture.needsUpdate = true
  return { texture, origin: new THREE.Vector2(field.x0, field.z0), n: new THREE.Vector2(field.nx, field.nz) }
}

/** A loop raised from `bottom` to `top`; shape y is world -z, so after the turn it lies on the ground. */
function useSlab(loop: Loop, bottom: number, top: number) {
  return useMemo(() => {
    if (loop.length < 3) return null
    const shape = new THREE.Shape(loop.map(([x, z]) => new THREE.Vector2(x, -z)))
    const g = new THREE.ExtrudeGeometry(shape, { depth: top - bottom, bevelEnabled: false, curveSegments: 1 })
    g.rotateX(-Math.PI / 2)
    g.translate(0, bottom, 0)
    return g
  }, [loop, bottom, top])
}

export function Island({ town, land }: { town: Town; land: ReturnType<typeof useLand> }) {
  const lip = useSlab(land.grass, -LIP, 0)
  const soil = useSlab(land.grass, -0.7, -LIP)
  const deep = useSlab(land.grass, BOTTOM, -0.7)
  const beach = useSlab(land.beach, BOTTOM, BEACH_TOP)
  // extruded geometry: group 0 is the caps, group 1 the sides
  const grassTop = useMemo(() => toonChecker('#8fd16a', '#84c862', [town.cols / 2, town.rows / 2], CELL), [town.cols, town.rows])
  return (
    <group>
      {lip && <mesh geometry={lip} material={[grassTop, toon('#6aa84f')]} receiveShadow />}
      {soil && <mesh geometry={soil} material={toon('#b9824f')} receiveShadow />}
      {deep && <mesh geometry={deep} material={toon('#94643c')} receiveShadow />}
      {beach && <mesh geometry={beach} material={[toon('#f0dca6'), toon('#d9c088')]} receiveShadow />}
    </group>
  )
}
