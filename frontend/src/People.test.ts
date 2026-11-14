import * as THREE from 'three'
import { afterEach, expect, it, vi } from 'vitest'
import type { Look } from './core/domain/types'
import { BOTTOMS, FACIALS, HAIR_CUTS, SHOES, SWIMWEAR, TOPS, type Style } from './figureStyle'
import { nookPlaces } from './Building'
import { CELL } from './layout'
import { officePlan } from './office'
import { stuckCheck } from './stuckCheck'
import { FAR_PARTS, FAR_ZOOM, farAway, farParts, headBoxesForTest, HIP, NEAR_ZOOM, newRig, placeFar, LEG, LEG_SWING, OFFICE_GAP_FOR_TEST, officeForTest, standingBodyForTest, strideOf, waist, pickFollowTarget, shoe, type FollowTarget } from './People'

afterEach(() => vi.restoreAllMocks())

const EXTRAS: Look['extra'][] = [
  'none', 'glasses', 'cap', 'headset', 'sunglasses', 'beanie', 'bow', 'strawhat', 'beret', 'bandana', 'headband', 'hairclip', 'flower',
]
const LOOK: Look = { skin: '#f1c7a5', hair: '#5a3a24', shirt: '#3f7fd0', pants: '#34405a', extra: 'none' }
const EPS = 1e-6
type Box = [number[], number[], string]

/**
 * Two boxes whose faces turned the same way lie in one plane and overlap: the renderer cannot tell which is in front,
 * and the overlap flickers between the two colours.
 */
function fighting(worn: Box[], rest: Box[]) {
  const out: string[] = []
  for (const [pa, sa, ca] of worn) for (const [pb, sb, cb] of rest) {
    if (ca === cb) continue
    for (let axis = 0; axis < 3; axis++) for (const side of [-1, 1]) {
      if (Math.abs(pa[axis] + (side * sa[axis]) / 2 - (pb[axis] + (side * sb[axis]) / 2)) > EPS) continue
      // the two faces overlap with some area on the other two axes
      const overlap = [0, 1, 2].filter((k) => k !== axis).every((k) =>
        Math.min(pa[k] + sa[k] / 2, pb[k] + sb[k] / 2) - Math.max(pa[k] - sa[k] / 2, pb[k] - sb[k] / 2) > EPS)
      if (overlap) out.push(`${ca} at ${pa} and ${cb} at ${pb}, along ${'xyz'[axis]}${side > 0 ? '+' : '-'}`)
    }
  }
  return out
}

it('wears every hat, pair of glasses and headset clear of the hair and face, never in the same plane', () => {
  const bad: string[] = []
  for (const hair of HAIR_CUTS) for (const facial of FACIALS) for (const extra of EXTRAS.filter((x) => x !== 'none')) {
    const st = { hair, top: 'tee' as const, bottom: 'pants' as const, facial, accent: '#ffcf5a', shoes: 'leather' as const, shoeColor: '#2a2a30' }
    const bare = new Set(headBoxesForTest(LOOK, st).map((b) => JSON.stringify(b)))
    const boxes = headBoxesForTest({ ...LOOK, extra }, st)
    // what the extra adds, against the rest of the head
    const worn = boxes.filter((b) => !bare.has(JSON.stringify(b)))
    const rest = boxes.filter((b) => bare.has(JSON.stringify(b)))
    for (const f of fighting(worn, rest)) bad.push(`${hair} + ${facial} + ${extra}: ${f}`)
  }
  expect(bad).toEqual([])
})

const stroller = (index: number): FollowTarget => ({ kind: 'stroller', index })
const worker = (id: string, teamId = 't1'): FollowTarget => ({ kind: 'crew', id, teamId })
/** Dice that come up with these numbers in turn. */
const dice = (...rolls: number[]) => () => rolls.shift() ?? 0

it('picks a stroller or an employee, about half and half, never the last one followed', () => {
  const crew = [{ id: 'a', teamId: 't1' }, { id: 'b', teamId: 't2' }]
  // the first roll picks the group, the second who in it
  expect(pickFollowTarget(5, crew, null, 'all', dice(0.2, 0.5))).toEqual(stroller(2))
  expect(pickFollowTarget(5, crew, null, 'all', dice(0.7, 0.6))).toEqual(worker('b', 't2'))
  // the last one is left out of its group
  expect(pickFollowTarget(5, crew, worker('a'), 'all', dice(0.7, 0))).toEqual(worker('b', 't2'))
  expect(pickFollowTarget(2, [], stroller(0), 'all', dice(0, 0))).toEqual(stroller(1))
  // a group of only the last one is passed over for the other
  expect(pickFollowTarget(5, [crew[0]], worker('a'), 'all', dice(0.9, 0))).toEqual(stroller(0))
  expect(pickFollowTarget(1, crew, stroller(0), 'all', dice(0.1, 0))).toEqual(worker('a'))
})

it('follows whoever there is, even the last one when nobody else is about, and nobody when nobody is', () => {
  expect(pickFollowTarget(0, [{ id: 'a', teamId: 't1' }], null, 'all', dice(0.9, 0.9))).toEqual(worker('a'))
  expect(pickFollowTarget(3, [], null, 'all', dice(0.9, 0.5))).toEqual(stroller(1))
  expect(pickFollowTarget(1, [], stroller(0), 'all', dice(0.5, 0.5))).toEqual(stroller(0))
  expect(pickFollowTarget(0, [], null)).toBeNull()
})

/** Points over the surface of a box, `n` steps along each edge. */
function surface([c, size]: [number[], number[]], n = 12) {
  const out: number[][] = []
  for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) for (let k = 0; k <= n; k++) {
    if (i > 0 && i < n && j > 0 && j < n && k > 0 && k < n) continue
    out.push([c[0] + size[0] * (i / n - 0.5), c[1] + size[1] * (j / n - 0.5), c[2] + size[2] * (k / n - 0.5)])
  }
  return out
}

it('keeps the legs inside a skirt, a dress or a coat\'s tails at every point of a stride', () => {
  const bad: string[] = []
  for (const bottom of [...BOTTOMS, ...SWIMWEAR]) for (const top of TOPS) {
    const st: Style = { hair: 'short', top, bottom, facial: 'none', accent: '#ffcf5a', shoes: 'leather', shoeColor: '#2a2a30' }
    // under a long skirt only the feet are drawn
    if (bottom === 'longskirt') continue
    const covers = [...waist(LOOK, st), ...standingBodyForTest(LOOK, st)]
    // what hangs lowest over the legs: below it they show, above it they must stay inside
    const low = Math.min(...covers.map(([c, sz]) => c[1] - sz[1] / 2))
    const within = (p: number[]) => covers.some(([c, sz]) => [0, 1, 2].every((a) => Math.abs(p[a] - c[a]) <= sz[a] / 2 + EPS))
    const most = LEG_SWING * strideOf(st)
    for (let step = -4; step <= 4; step++) {
      const a = (most * step) / 4
      for (const side of [-1, 1]) for (const [x, y, z] of surface(LEG)) {
        // turned about the hip, as the walk turns the leg's group
        const p = [side * HIP[0] + x, HIP[1] + y * Math.cos(a) - z * Math.sin(a), HIP[2] + y * Math.sin(a) + z * Math.cos(a)]
        if (p[1] >= low && !within(p)) { bad.push(`${top} + ${bottom} at ${a.toFixed(2)}`); break }
      }
    }
  }
  expect([...new Set(bad)]).toEqual([])
})

it('never leaves people in a crowded office on top of each other, nor anyone going nowhere', () => {
  for (const seed of [5, 7, 11, 23, 71]) {
    let random = seed
    const rng = vi.spyOn(Math, 'random').mockImplementation(() => ((random = (Math.imul(random, 1664525) + 1013904223) >>> 0) / 2 ** 32))
    const plan = officePlan(16, 10 * CELL, CELL, seed)
    const nook = nookPlaces(plan)
    const crew = Array.from({ length: 16 }, (_, i) => ({ id: `p${i}`, look: LOOK, busy: false }))
    const gap = OFFICE_GAP_FOR_TEST
    const check = stuckCheck(gap * 0.5, gap)
    let t = 0
    let up = 0
    officeForTest(plan, crew, 900, (people) => {
      t += 0.1
      // now and then work comes in for some of them, and they go back to their desks around the others
      crew.forEach((c, i) => (c.busy = Math.floor(t / 60 + i) % 5 === 0))
      up += people.filter((p) => p.mode === 'walking' || p.mode === 'standing').length
      check.step(people.map((p) => ({ x: p.x, z: p.z, walking: p.mode === 'walking', solid: true })), 0.1)
    }, { sofa: nook.sofa, coffee: [nook.coffee] })
    // plenty of them up and about
    expect(up / (t / 0.1)).toBeGreaterThan(5)
    rng.mockRestore()
    expect(check.minimum).toBeGreaterThanOrEqual(gap * 0.8 - 1e-6)
    expect(check.overlap).toBe(0)
    // held up, they go round, wait or give up within a few seconds
    expect(check.frozen).toBeLessThan(10)
  }
})


it('returns every busy employee to their own desk without passing through colleagues or seated people', () => {
  let seed = 71
  vi.spyOn(Math, 'random').mockImplementation(() => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32))
  const plan = officePlan(16, 10 * CELL, CELL, 7)
  const nook = nookPlaces(plan)
  const crew = Array.from({ length: 16 }, (_, i) => ({ id: `p${i}`, look: LOOK, busy: false }))
  const check = stuckCheck(OFFICE_GAP_FOR_TEST * 0.8, OFFICE_GAP_FOR_TEST)
  let t = 0, away = 0
  let final: Array<{ x: number; z: number; mode: string }> = []
  officeForTest(plan, crew, 300, (people) => {
    t += 0.1
    if (t > 120) crew.forEach((c) => (c.busy = true))
    else away = Math.max(away, people.filter((p) => p.mode !== 'seated').length)
    check.step(people.map((p) => ({ x: p.x, z: p.z, walking: p.mode === 'walking', solid: true })), 0.1)
    final = people
  }, { sofa: nook.sofa, coffee: [nook.coffee] })
  expect(away).toBeGreaterThan(5)
  expect(check.minimum).toBeGreaterThanOrEqual(OFFICE_GAP_FOR_TEST * 0.8 - 1e-6)
  expect(final.every((p) => p.mode === 'seated')).toBe(true)
  expect(final.map((p) => [p.x, p.z])).toEqual(plan.seats)
})


it('follows only map people by default, without falling back to employees', () => {
  const crew = [{ id: 'a', teamId: 't1' }]
  expect(pickFollowTarget(1, crew, null)).toEqual(stroller(0))
  expect(pickFollowTarget(1, crew, stroller(0))).toEqual(stroller(0))
  expect(pickFollowTarget(2, crew, stroller(0), 'map')).toEqual(stroller(1))
  expect(pickFollowTarget(0, crew, null)).toBeNull()
  expect(pickFollowTarget(0, crew, null, 'all')).toEqual(worker('a'))
})

const STYLE: Style = { hair: HAIR_CUTS.find((h) => h !== 'bald')!, top: 'tee', bottom: 'pants', facial: FACIALS[0], accent: '#c0453a', shoes: 'leather', shoeColor: '#2a2a30' }

it('draws people far away below one zoom and in full again only past a higher one', () => {
  expect(farAway(FAR_ZOOM - 0.1, false)).toBe(true)
  expect(farAway(FAR_ZOOM + 0.1, false)).toBe(false)
  // between the two it stays as it was
  const between = (FAR_ZOOM + NEAR_ZOOM) / 2
  expect(farAway(between, true)).toBe(true)
  expect(farAway(between, false)).toBe(false)
  expect(farAway(NEAR_ZOOM + 0.1, true)).toBe(false)
})

it('draws a far figure in its clothes\' colours, its head bare when bald and a hat in the hat\'s', () => {
  const parts = farParts(LOOK, STYLE)
  expect(parts).toHaveLength(FAR_PARTS)
  expect(parts.map((p) => p.c)).toEqual([LOOK.pants, LOOK.pants, LOOK.shirt, LOOK.skin, LOOK.hair])
  const swim = farParts(LOOK, { ...STYLE, bottom: SWIMWEAR.find((b) => b === 'trunks')! })
  expect(swim[0].c).toBe(LOOK.skin)
  const bald = farParts(LOOK, { ...STYLE, hair: 'bald' })
  expect([bald[4].stand, bald[4].sit]).toEqual([null, null])
  const straw = farParts({ ...LOOK, extra: 'strawhat' }, { ...STYLE, hair: 'bald' })
  expect(straw[4].c).toBe('#e3c27a')
  expect(straw[4].stand).not.toBeNull()
  // the lap only shows seated
  expect(parts[1].stand).toBeNull()
  expect(parts[1].sit).not.toBeNull()
})

/** A rig as `Figure` builds it, at `x` along the parent, seated or standing. */
function rigAt(parent: THREE.Object3D, x: number, seated: boolean) {
  const rig = newRig()
  rig.root = new THREE.Group()
  rig.root.position.x = x
  rig.root.scale.setScalar(2)
  rig.detail = new THREE.Group()
  rig.seated = new THREE.Group()
  rig.standing = new THREE.Group()
  rig.seated.visible = seated
  rig.standing.visible = !seated
  rig.detail.add(rig.seated, rig.standing)
  rig.root.add(rig.detail)
  parent.add(rig.root)
  return rig
}

it('far away, hides each figure\'s detail and puts its boxes where it is, seated or standing', () => {
  const scene = new THREE.Group()
  scene.position.y = 5
  const crowd = new THREE.Group()
  scene.add(crowd)
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), 3 * FAR_PARTS)
  scene.add(mesh)
  const rigs = [rigAt(crowd, 10, false), rigAt(crowd, 20, true), rigAt(crowd, 30, false)]
  // gone indoors: its Fade has hidden it
  rigs[2].root!.parent!.remove(rigs[2].root!)
  const hidden = new THREE.Group()
  hidden.visible = false
  hidden.add(rigs[2].root!)
  crowd.add(hidden)
  const parts = rigs.map(() => farParts(LOOK, STYLE))
  scene.updateMatrixWorld(true)

  placeFar(mesh, rigs, parts, true)
  expect(mesh.visible).toBe(true)
  expect(rigs.every((r) => !r.detail!.visible)).toBe(true)
  const m = new THREE.Matrix4()
  const centre = (slot: number) => new THREE.Vector3().setFromMatrixPosition((mesh.getMatrixAt(slot, m), m))
  const size = (slot: number) => new THREE.Vector3().setFromMatrixScale((mesh.getMatrixAt(slot, m), m))
  // the head, standing and seated, twice as big as in the figure's units; in the mesh's parent's space
  const [standHead, sitHead] = [parts[0][3].stand!, parts[0][3].sit!]
  expect(centre(3).toArray()).toEqual([10, standHead[0][1] * 2, standHead[0][2] * 2].map((v) => expect.closeTo(v)))
  expect(size(3).x).toBeCloseTo(standHead[1][0] * 2)
  expect(centre(FAR_PARTS + 3).toArray()).toEqual([20, sitHead[0][1] * 2, sitHead[0][2] * 2].map((v) => expect.closeTo(v)))
  // the lap only seated; nothing of the one indoors
  expect(size(1).length()).toBe(0)
  expect(size(FAR_PARTS + 1).length()).toBeGreaterThan(0)
  for (let k = 0; k < FAR_PARTS; k++) expect(size(2 * FAR_PARTS + k).length()).toBe(0)

  placeFar(mesh, rigs, parts, false)
  expect(mesh.visible).toBe(false)
  expect(rigs.every((r) => r.detail!.visible)).toBe(true)
})

it('draws each kind of shoe round the foot, a boot round the leg above it, standing and seated', () => {
  const base: Style = { hair: 'short', top: 'tee', bottom: 'pants', facial: 'none', accent: '#ffcf5a', shoes: 'leather', shoeColor: '#123456' }
  // [min, max] of a box along one axis
  const span = ([p, s]: [number[], number[]], k: number) => [p[k] - s[k] / 2, p[k] + s[k] / 2]
  const inside = (inner: [number, number], outer: [number, number]) => outer[0] < inner[0] && inner[1] < outer[1]
  for (const [foot, shin] of [[[0.16, 0.07, 0.23], [LEG[1][0], LEG[1][2]]], [[0.14, 0.07, 0.2], [0.12, 0.12]]] as const) {
    for (const shoes of SHOES) {
      const boxes = shoe(LOOK, { ...base, shoes }, [...foot], [...shin])
      // the foot itself, in the shoe's colour, or bare: on a flip-flop's sole of that colour, or on nothing
      const bare = shoes === 'flipflops' || shoes === 'barefoot'
      expect(boxes[0]).toEqual([[0, 0, 0], [...foot], bare ? LOOK.skin : '#123456'])
      expect(boxes.some(([, , c]) => c === '#123456')).toBe(shoes !== 'barefoot')
      if (shoes === 'leather' || shoes === 'barefoot') expect(boxes).toHaveLength(1)
      // a sole under the foot, wider all round, its bottom below the foot's
      if (shoes === 'sneakers' || shoes === 'flipflops') {
        const sole = boxes[1]
        expect(sole[1][0]).toBeGreaterThan(foot[0])
        expect(sole[1][2]).toBeGreaterThan(foot[2])
        expect(span([sole[0], sole[1]], 1)[0]).toBeLessThan(-foot[1] / 2)
      }
      // a shaft round the leg, standing on the foot: the leg is centred 0.03 behind the toes' middle
      if (shoes === 'boots') {
        const [p, s] = boxes[1]
        expect(inside([-shin[0] / 2, shin[0] / 2], span([p, s], 0) as [number, number])).toBe(true)
        expect(inside([0.03 - shin[1] / 2, 0.03 + shin[1] / 2], span([p, s], 2) as [number, number])).toBe(true)
        expect(span([p, s], 1)[0]).toBeLessThanOrEqual(foot[1] / 2 + 0.001)
      }
    }
  }
})
