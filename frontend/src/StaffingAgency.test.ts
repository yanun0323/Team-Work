import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { mergeStatic } from './Merged'
import { hitBoxes, PAVE_TOP, ROTUNDA, SHADE_FLOOR, shadeTargets } from './StaffingAgency'
import { BED, GROUNDS, HALF_LOT, obstacles, STEPS_HALF, type Footprint } from './staffingGrounds'

type Box = ReturnType<typeof hitBoxes>[number]
const area = ([, s]: Box) => s[0] * s[2]
const overlap = ([a, sa]: Box, [b, sb]: Box) => Math.abs(a[0] - b[0]) < (sa[0] + sb[0]) / 2 - 1e-9 && Math.abs(a[2] - b[2]) < (sa[2] + sb[2]) / 2 - 1e-9
const inside = (f: Footprint) => f.x - f.w / 2 >= ROTUNDA.x0 && f.x + f.w / 2 <= ROTUNDA.x1 && f.z - f.d / 2 >= ROTUNDA.z0 && f.z + f.d / 2 <= ROTUNDA.z1
const outside = (f: Footprint) => f.x + f.w / 2 <= ROTUNDA.x0 || f.x - f.w / 2 >= ROTUNDA.x1 || f.z + f.d / 2 <= ROTUNDA.z0 || f.z - f.d / 2 >= ROTUNDA.z1

describe('what takes the pointer at the staffing agency', () => {
  it('covers the whole paving, the rotunda and the layers round it, nothing twice', () => {
    const ground = hitBoxes(true).slice(0, 5)
    expect(ground.reduce((sum, b) => sum + area(b), 0)).toBeCloseTo((2 * HALF_LOT) ** 2)
    for (const [i, a] of ground.entries()) for (const b of ground.slice(i + 1)) expect(overlap(a, b)).toBe(false)
    for (const [p, s] of ground) {
      expect(Math.abs(p[0]) + s[0] / 2).toBeLessThanOrEqual(HALF_LOT + 1e-9)
      expect(Math.abs(p[2]) + s[2] / 2).toBeLessThanOrEqual(HALF_LOT + 1e-9)
    }
  })

  it("takes in the bed, the steps and the badge under the rotunda's box, and everything else apart", () => {
    expect(inside({ x: 0, z: 0, w: 2 * BED.r1, d: 2 * BED.r1 })).toBe(true)
    expect(inside({ x: 0, z: 0, w: 2 * STEPS_HALF, d: 2 * (BED.r0 + 0.75) })).toBe(true)
    expect(inside(GROUNDS.badge)).toBe(true)
    const things = obstacles().filter((f) => f !== GROUNDS.badge)
    for (const f of things) expect(outside(f), JSON.stringify(f)).toBe(true)
    // a box of its own over each, and none over another
    const own = hitBoxes(true).slice(5)
    expect(own).toHaveLength(things.length)
    for (const [i, a] of own.entries()) for (const b of own.slice(i + 1)) expect(overlap(a, b)).toBe(false)
  })

  it('drops the lamps with less detail, as they are not drawn', () => {
    expect(hitBoxes(true).length - hitBoxes(false).length).toBe(GROUNDS.lamps.length)
  })
})

describe("the staffing agency's hover shade", () => {
  it('copies only what is drawn: the merged meshes, not those they stand for, the pointer\'s boxes or its own copies', () => {
    const box = () => new THREE.BoxGeometry()
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

  it('lays its layer over the paving clear of the paving, not on it, where it lost to it in bands', () => {
    // well past what a depth buffer tells apart from 1 to 600, and too little to see
    expect(SHADE_FLOOR - PAVE_TOP).toBeGreaterThanOrEqual(0.01)
    expect(SHADE_FLOOR - PAVE_TOP).toBeLessThanOrEqual(0.05)
  })
})
