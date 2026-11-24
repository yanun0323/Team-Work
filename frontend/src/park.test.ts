import { describe, expect, it } from 'vitest'
import { PARK_CELLS, PARK_DOOR, PARK_STAGES, parkLoop, parkPlan } from './park'

const key = (x: number, z: number) => `${x},${z}`
const cells = (r: { x: number; z: number; w: number; d: number }) =>
  Array.from({ length: r.w * r.d }, (_, k) => [r.x + (k % r.w), r.z + Math.floor(k / r.w)] as const)

describe('the park at each stage', () => {
  for (let stage = 1; stage <= PARK_STAGES; stage++) {
    const plan = parkPlan(stage)
    // what stands in the way: everything but the gravel
    const taken = new Map<string, string>()
    const things = [
      ...plan.props.map((r) => [r.kind, r] as const), ...plan.beds.map((r) => ['bed', r] as const),
      ...plan.blankets.map((r) => ['blanket', r] as const), ...plan.trees.map((t) => ['tree', { ...t, w: 2, d: 2 }] as const),
      ...(plan.gazebo ? [['gazebo', plan.gazebo] as const] : []),
    ]
    const walks = new Set(plan.walks.map(([x, z]) => key(x, z)))
    const inside = (x: number, z: number) => x >= 0 && z >= 0 && x < PARK_CELLS && z < PARK_CELLS
    const open = (x: number, z: number) => inside(x, z) && !taken.has(key(x, z))

    it(`${stage}: everything stands on its own cells inside the ground, off the paths`, () => {
      for (const [what, r] of things) for (const [x, z] of cells(r)) {
        expect(inside(x, z), `${what} at ${x},${z}`).toBe(true)
        expect(taken.get(key(x, z)), `${what} on ${taken.get(key(x, z))} at ${x},${z}`).toBeUndefined()
        expect(walks.has(key(x, z)), `${what} on the path at ${x},${z}`).toBe(false)
        taken.set(key(x, z), what)
      }
      for (const [x, z] of plan.walks) expect(inside(x, z)).toBe(true)
    })

    it(`${stage}: every seat can be reached`, () => {
      for (const b of plan.props.filter((p) => p.kind === 'bench')) {
        const [fx, fz] = b.face!
        for (const [x, z] of cells(b)) expect(open(x + fx, z + fz), `bench at ${x},${z}`).toBe(true)
      }
      for (const b of plan.blankets) {
        expect(b.w).toBe(2)
        expect(open(b.x - 1, b.z) && open(b.x + 2, b.z), `blanket at ${b.x},${b.z}`).toBe(true)
      }
    })

    it(`${stage}: the paths all join the way in, which reaches the front edge`, () => {
      const [dx] = PARK_DOOR
      expect(walks.has(key(dx, PARK_CELLS - 1)) && walks.has(key(dx + 1, PARK_CELLS - 1))).toBe(true)
      const seen = new Set([key(dx, PARK_CELLS - 1)])
      const queue: Array<[number, number]> = [[dx, PARK_CELLS - 1]]
      while (queue.length) {
        const [x, z] = queue.pop()!
        for (const [nx, nz] of [[x + 1, z], [x - 1, z], [x, z + 1], [x, z - 1]] as const) {
          if (walks.has(key(nx, nz)) && !seen.has(key(nx, nz))) { seen.add(key(nx, nz)); queue.push([nx, nz]) }
        }
      }
      expect(seen.size).toBe(walks.size)
    })

    it(`${stage}: the loop walked round it runs along the gravel`, () => {
      const loop = parkLoop(stage)
      loop.forEach(([x, z], i) => {
        const [nx, nz] = loop[(i + 1) % loop.length]
        expect(x === nx || z === nz).toBe(true)
        for (let t = 0; t <= Math.max(Math.abs(nx - x), Math.abs(nz - z)); t++) {
          const cx = x + Math.sign(nx - x) * t, cz = z + Math.sign(nz - z) * t
          expect(walks.has(key(cx, cz)), `${cx},${cz}`).toBe(true)
        }
      })
    })
  }

  it('grows: each stage keeps all the last one had, and adds more', () => {
    for (let stage = 2; stage <= PARK_STAGES; stage++) {
      const before = parkPlan(stage - 1), now = parkPlan(stage)
      expect(now.props).toEqual(expect.arrayContaining(before.props))
      expect(now.trees).toEqual(expect.arrayContaining(before.trees))
      expect(now.props.length + now.trees.length + now.beds.length).toBeGreaterThan(before.props.length + before.trees.length + before.beds.length)
    }
    expect(parkPlan(PARK_STAGES + 3)).toEqual(parkPlan(PARK_STAGES))
  })
})
