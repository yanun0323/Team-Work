import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { PAVE_TOP, SHADE_FLOOR, shadeTargets } from './HoverShade'
import { mergeStatic } from './Merged'

const box = () => new THREE.BoxGeometry()

describe('the hover shade', () => {
  it("copies only what is drawn: the merged meshes, not those they stand for, the pointer's boxes or its own copies", () => {
    const root = new THREE.Group()
    const merged = new THREE.Group()
    merged.add(new THREE.Mesh(box(), new THREE.MeshBasicMaterial()), new THREE.Mesh(box(), new THREE.MeshBasicMaterial()))
    const built = mergeStatic(merged)
    merged.add(...built)
    const flag = new THREE.Mesh(box(), new THREE.MeshBasicMaterial())
    const hit = new THREE.Mesh(box(), new THREE.MeshBasicMaterial({ visible: false }))
    const shade = new THREE.Group()
    shade.add(new THREE.Mesh(box(), new THREE.MeshBasicMaterial()))
    root.add(merged, flag, hit, shade)
    expect(shadeTargets(root, shade)).toEqual([...built, flag])
  })

  it('leaves out see-through meshes, as what shows through them gets its own copy, and what the camera does not see', () => {
    const root = new THREE.Group()
    const wall = new THREE.Mesh(box(), new THREE.MeshBasicMaterial())
    const glass = new THREE.Mesh(box(), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.6, depthWrite: false }))
    // a person drawn by FigureBatch instead, off the camera's layers
    const batched = new THREE.Mesh(box(), new THREE.MeshBasicMaterial())
    batched.layers.set(2)
    const skip = new THREE.Group()
    root.add(wall, glass, batched, skip)
    expect(shadeTargets(root, skip, new THREE.Layers())).toEqual([wall])
  })

  it('copies a mesh with a material per face, as a building\'s walls are, unless one of them is see-through', () => {
    const root = new THREE.Group()
    const walls = new THREE.Mesh(box(), [new THREE.MeshBasicMaterial(), new THREE.MeshBasicMaterial()])
    const fading = new THREE.Mesh(box(), [new THREE.MeshBasicMaterial(), new THREE.MeshBasicMaterial({ transparent: true })])
    const skip = new THREE.Group()
    root.add(walls, fading, skip)
    expect(shadeTargets(root, skip)).toEqual([walls])
  })

  it('lays its layer over the paving clear of the paving, not on it, where it lost to it in bands', () => {
    // well past what a depth buffer tells apart from 1 to 600, and too little to see
    expect(SHADE_FLOOR - PAVE_TOP).toBeGreaterThanOrEqual(0.01)
    expect(SHADE_FLOOR - PAVE_TOP).toBeLessThanOrEqual(0.05)
  })
})
