// Shaders built before they are needed, and kept. Opening a building fades its outside out and its inside in, through
// see-through copies of their materials (Fade.tsx) and a see-through batch of the people (FigureBatch.tsx); those need
// shader programs of their own, which three.js built the moment they were first drawn, mid-click. Once the fade was
// over the copies were freed, and with them the programs, so every opening built them again (see `keepPrograms`).

import { useFrame, useThree } from '@react-three/fiber'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { UNIT } from './core/voxel/kit'
import { seeThrough } from './Fade'
import { NO_OUTLINE_LAYER } from './PixelPass'
import { fadingShadow } from './shadowFade'
import { toon, toonInstanced, toonMap } from './toon'

/**
 * A speck of each surface an opening draws, as it draws it: too small to see and there for a few frames, which builds their
 * programs (kept by PixelPass's `keepPrograms`) while the island is loading rather than on the first click.
 */
function specks() {
  const group = new THREE.Group()
  const texture = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.needsUpdate = true
  // what is made here, to free afterwards
  const own: THREE.Material[] = []
  const mine = <M extends THREE.Material>(m: M) => (own.push(m), m)
  const dither = mine(fadingShadow().material)
  const glowing = mine(toonMap('#ffffff', texture))
  glowing.emissiveMap = texture
  const add = (mesh: THREE.Mesh, { receive = true, outline = false } = {}) => {
    mesh.scale.setScalar(1e-4)
    mesh.position.y = -20
    mesh.frustumCulled = false
    mesh.castShadow = true
    mesh.receiveShadow = receive
    if (!outline) mesh.layers.set(NO_OUTLINE_LAYER)
    group.add(mesh)
  }
  // as it stands, casting an ordinary shadow, and see-through, casting the fade's dithered one
  const faded = (m: THREE.Material, opts?: { receive?: boolean }) => {
    add(new THREE.Mesh(UNIT, m), { ...opts, outline: true })
    const mesh = new THREE.Mesh(UNIT, mine(seeThrough(m, true)))
    mesh.customDepthMaterial = dither
    add(mesh, opts)
  }
  // the outside's and the office's surfaces
  faded(toon('#ffffff'))
  faded(toon('#ffffff'), { receive: false })
  faded(mine(toonMap('#ffffff', texture)))
  faded(glowing)
  faded(mine(new THREE.MeshBasicMaterial()), { receive: false })
  // the people, solid and fading (FigureBatch)
  for (const fading of [false, true]) {
    const material = mine(toonInstanced())
    material.transparent = fading
    const mesh = new THREE.InstancedMesh(UNIT, material, 1)
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(3), 3)
    if (fading) mesh.customDepthMaterial = dither
    add(mesh, { outline: !fading })
  }
  let gone = false
  return {
    group,
    dispose() {
      if (gone) return
      gone = true
      group.removeFromParent()
      for (const o of group.children) if ((o as THREE.InstancedMesh).isInstancedMesh) (o as THREE.InstancedMesh).dispose()
      for (const m of own) m.dispose()
      texture.dispose()
    },
  }
}

/**
 * Frames the specks are drawn for. The shadow map's programs depend on the lights, and three.js draws the shadow map
 * before it sets them up, so on the very first frame it sees none; nor is the shadow map drawn every frame (SHADOW_FPS).
 */
const WARM_FRAMES = 4

/** Builds the fades' shaders over the first few frames; once in the scene. */
export function ShaderWarmup() {
  const scene = useThree((s) => s.scene)
  const parts = useMemo(specks, [])
  const frames = useRef(0)
  useEffect(() => {
    scene.add(parts.group)
    return () => parts.dispose()
  }, [scene, parts])
  useFrame(() => {
    if (++frames.current === WARM_FRAMES + 1) parts.dispose()
  })
  return null
}
