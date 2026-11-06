import { describe, expect, it } from 'vitest'
import { beginAvoidance, coordinateTraffic, walkingRoute, canStand, detour, openSpot, separate, spotTaken, STUCK, UNHINDERED, walkAround, type Avoider } from './avoid'
import { isFree, type Grid, type P } from './walk'

/** A grid from rows of text: '.' free, '#' blocked. Cell centres are at whole numbers. */
function grid(rows: string[]): Grid {
  const free = new Uint8Array(rows.length * rows[0].length)
  rows.forEach((r, z) => [...r].forEach((c, x) => (free[z * r.length + x] = c === '.' ? 1 : 0)))
  return { cols: rows[0].length, rows: rows.length, free, x0: 0, z0: 0, step: 1 }
}

const open = grid(Array.from({ length: 9 }, () => '.'.repeat(16)))
const GAP = 0.9
const SPEED = 1.5
const body = (x: number, z: number, route: P[] = []): Avoider => ({ x, z, route, heading: 0, ...UNHINDERED })
const all = () => true
const apart = (a: Avoider, b: Avoider) => Math.hypot(a.x - b.x, a.z - b.z)

/** Everyone walks for `seconds`, then is eased apart, step by step; the least distance seen between any two including every body. */
function run(people: Avoider[], g: Grid, seconds: number, past: (p: Avoider) => Avoider | null = () => null) {
  let least = Infinity
  for (let t = 0; t < seconds; t += 0.05) {
    beginAvoidance(people)
    for (const p of people) walkAround(people, p, g, SPEED * 0.05, 0.05, GAP, all, past(p))
    separate(people, g, GAP, 0.05, all)
    for (let i = 0; i < people.length; i++) for (let j = i + 1; j < people.length; j++) {
      least = Math.min(least, apart(people[i], people[j]))
    }
  }
  return least
}

describe('openSpot', () => {
  it('passes over spots someone stands on, is stopped at part way, or is on their way to', () => {
    const me = body(0, 0)
    // standing; on their way to (5, 5); stopped at (8, 2) for a moment on their way elsewhere
    const people = [me, body(3, 3), body(8, 0, [[5, 5]]), body(8, 2, [[14, 2]])]
    expect(spotTaken(people, me, [3.2, 3], GAP, all)).toBe(true)
    expect(spotTaken(people, me, [5, 5.3], GAP, all)).toBe(true)
    expect(spotTaken(people, me, [8, 2.2], GAP, all)).toBe(true)
    // one's own place is no one else's
    expect(spotTaken(people, me, [0, 0], GAP, all)).toBe(false)
    // nor is anyone's that `counts` leaves out
    expect(spotTaken(people, me, [3, 3], GAP, (q) => q !== people[1])).toBe(false)
    const picks: P[] = [[3, 3], [5, 5], [10, 6]]
    expect(openSpot(() => picks.shift() as P, people, me, GAP, all)).toEqual([10, 6])
  })

  it('finds nothing when everywhere tried is taken, rather than doubling up', () => {
    const me = body(0, 0)
    expect(openSpot(() => [3, 3], [me, body(3, 3)], me, GAP, all, 3)).toBeNull()
  })
})

describe('walkAround', () => {
  it('has two meeting head on step to their right and pass, keeping their distance', () => {
    const a = body(1, 4, [[14, 4]])
    const b = body(14, 4, [[1, 4]])
    const least = run([a, b], open, 14)
    expect(least).toBeGreaterThan(GAP * 0.75)
    expect([a.x, a.z, b.x, b.z]).toEqual([14, 4, 1, 4])
    expect(a.blocked || b.blocked).toBe(false)
  })

  it('goes round someone standing in the way', () => {
    const walker = body(1, 4, [[14, 4]])
    const stander = body(7, 4)
    const least = run([walker, stander], open, 14)
    expect(least).toBeGreaterThan(GAP * 0.75)
    expect([walker.x, walker.z]).toEqual([14, 4])
    expect(walker.blocked).toBe(false)
  })

  it('keeps behind someone going the same way', () => {
    const lead = body(3, 4, [[14, 4]])
    const behind = body(1.5, 4, [[14, 4]])
    // the one in front walks slower: the one behind waits rather than walking into them
    let least = Infinity
    for (let t = 0; t < 2; t += 0.05) {
      walkAround([lead, behind], lead, open, SPEED * 0.5 * 0.05, 0.05, GAP, all)
      walkAround([lead, behind], behind, open, SPEED * 0.05, 0.05, GAP, all)
      least = Math.min(least, apart(lead, behind))
    }
    expect(least).toBeGreaterThan(GAP * 0.9)
    expect(behind.x).toBeLessThan(lead.x)
  })

  it('walks straight up to whoever they are going to', () => {
    const me = body(1, 4, [[5, 4]])
    const friend = body(5.8, 4)
    run([me, friend], open, 5, (p) => (p === me ? friend : null))
    expect(me.z).toBeCloseTo(4)
  })

  it('cancels an impossible one-wide crossing without entering either wall or body', () => {
    const lane = { ...grid(['#############', '.............', '#############']), step: 0.5 }
    const a = body(0, 0.5, [[6, 0.5]])
    const b = body(6, 0.5, [[0, 0.5]])
    expect(run([a, b], lane, 20)).toBeGreaterThanOrEqual(GAP * 0.8 - 1e-6)
    expect(a.blocked || b.blocked).toBe(true)
    for (const p of [a, b]) expect(isFree(lane, Math.round(p.x / 0.5), Math.round(p.z / 0.5))).toBe(true)
  })

  it('held up in a narrow way, goes round by another way when there is one, rather than through', () => {
    const ways = grid([
      '.........',
      '.#######.',
      '.........',
    ])
    const me = body(0, 2, [[8, 2]])
    const there = body(4, 2)
    // along the bottom way: someone standing in it
    let least = Infinity
    for (let t = 0; t < 20 && !(me.x === 8 && me.z === 2); t += 0.05) {
      walkAround([me, there], me, ways, SPEED * 0.05, 0.05, GAP, all)
      separate([me, there], ways, GAP, 0.05, (p) => p === me)
      expect(me.yielding).toBeNull()
      least = Math.min(least, apart(me, there))
    }
    expect([me.x, me.z]).toEqual([8, 2])
    expect(least).toBeGreaterThan(GAP * 0.75)
  })

  it('finds no way round through a cell shared with the one in the way', () => {
    const big = { ...grid(['.....', '.....', '.....']), step: 2 }
    const me = body(4, 2, [[8, 2]])
    expect(detour(big, me, body(4.8, 2), GAP)).toEqual([])
  })

  it('gives up on a spot someone stands on and can\'t be moved off, however much room there is to sidestep', () => {
    // out in the open, someone standing (pinned, say against a planter) right where we are going
    const me = body(1, 4, [[8, 4]])
    const there = body(8, 4)
    let t = 0
    let least = Infinity
    for (; t < 10 && !me.blocked; t += 0.05) {
      walkAround([me, there], me, open, SPEED * 0.05, 0.05, GAP, all)
      separate([me, there], open, GAP, 0.05, (p) => p === me)
      least = Math.min(least, apart(me, there))
    }
    expect(me.blocked).toBe(true)
    expect(t).toBeLessThan(STUCK + 6)
    expect(least).toBeGreaterThan(GAP * 0.75)
    // the occupied spot stays solid throughout
    expect(me.yielding).toBeNull()
  })

  it('counts no getting any nearer as held up, even while stepping aside the whole time', () => {
    const me = body(1, 4, [[14, 4]])
    // two standing side by side across the way, and nobody can push them: stepping aside never gets past
    const wall = [body(4, 3.5), body(4, 4.5)]
    const people = [me, ...wall]
    let resolved = false
    for (let t = 0; t < 6; t += 0.05) {
      walkAround(people, me, open, SPEED * 0.05, 0.05, GAP, all)
      separate(people, open, GAP, 0.05, (p) => p === me)
      resolved ||= me.blocked || me.yielding !== null || me.rerouted || me.x > 4.5
    }
    expect(resolved).toBe(true)
  })

  it('reports an occupied destination after waiting, without ever walking into it', () => {
    const lane = { ...grid(['#####', '.....', '#####']), step: 0.5 }
    const me = body(0, 0.5, [[2, 0.5]])
    const wall = body(2, 0.5)
    let elapsed = 0
    while (!me.blocked && elapsed < 10) {
      walkAround([me, wall], me, lane, SPEED * 0.05, 0.05, GAP, all)
      expect(apart(me, wall)).toBeGreaterThanOrEqual(GAP * 0.8 - 1e-6)
      elapsed += 0.05
    }
    expect(elapsed).toBeGreaterThan(STUCK)
    expect(me.blocked).toBe(true)
  })

})

describe('separate', () => {
  it('eases apart two standing on each other, across the screen when exactly on top', () => {
    const a = body(5, 5)
    const b = body(5, 5)
    for (let t = 0; t < 2; t += 0.05) separate([a, b], open, GAP, 0.05, all)
    expect(apart(a, b)).toBeGreaterThan(GAP * 0.95)
    // along x - z, as the map is seen
    expect(Math.abs(b.x - a.x)).toBeCloseTo(Math.abs(b.z - a.z), 3)
  })

  it('leaves alone those it is told to, and moves nobody onto blocked ground', () => {
    const g = grid(['.#', '..'])
    const sitting = body(0, 0)
    const against = body(0.1, 0)
    const out = body(0, 1)
    const people = [sitting, against, out]
    for (let t = 0; t < 2; t += 0.05) separate(people, g, GAP, 0.05, (p) => p !== sitting)
    expect([sitting.x, sitting.z]).toEqual([0, 0])
    for (const p of [against, out]) expect(canStand(g, [0, 0], [p.x, p.z])).toBe(true)
  })

  it('leaves one of two on top of each other, with nowhere to be eased to, to move off: the one on the way somewhere', () => {
    // a spot too small for two (a doorway, behind a desk)
    const pocket = { ...grid(['###', '#.#', '###']), step: 0.3 }
    const standing = body(0.3, 0.3)
    const walking = body(0.3, 0.3, [[0.3, 0.6]])
    for (let t = 0; t < 2; t += 0.05) separate([standing, walking], pocket, GAP, 0.05, all)
    expect(walking.blocked).toBe(true)
    expect(standing.blocked).toBe(false)
    // nobody pushed out of the spot
    for (const p of [standing, walking]) expect(canStand(pocket, [0.3, 0.3], [p.x, p.z])).toBe(true)
    // with both standing, one of them
    const a = body(0.3, 0.3)
    const b = body(0.3, 0.3)
    for (let t = 0; t < 2; t += 0.05) separate([a, b], pocket, GAP, 0.05, all)
    expect(a.blocked !== b.blocked).toBe(true)
  })

  it('tells how far each was moved, for their steps', () => {
    const a = body(5, 5)
    const b = body(5.3, 5)
    const moved = new Map<Avoider, number>()
    separate([a, b], open, GAP, 0.05, all, (p, d) => moved.set(p, (moved.get(p) ?? 0) + d))
    expect(moved.get(a)).toBeGreaterThan(0)
    expect(moved.get(b)).toBeCloseTo(moved.get(a) as number)
  })
})


describe('body collision regression', () => {
  it('never lets a timeout turn a narrow passage into a walk through another body', () => {
    const lane = { ...grid(['#############', '.............', '#############']), step: 0.5 }
    const a = body(0, 0.5, [[6, 0.5]])
    const b = body(6, 0.5, [[0, 0.5]])
    let least = Infinity
    for (let t = 0; t < 20; t += 0.05) {
      for (const p of [a, b]) {
        walkAround([a, b], p, lane, SPEED * 0.05, 0.05, GAP, all)
        least = Math.min(least, apart(a, b))
      }
      separate([a, b], lane, GAP, 0.05, all)
      least = Math.min(least, apart(a, b))
    }
    expect(least).toBeGreaterThanOrEqual(GAP * 0.8 - 1e-6)
  })

  it('does not sidestep into a third person or cross a body during a long step', () => {
    const me = body(1, 4, [[14, 4]])
    const ahead = body(3, 4)
    const side = body(1, 4.8)
    const people = [me, ahead, side]
    walkAround(people, me, open, 6, 1, GAP, all)
    // This entire movement, not just its endpoint, must stay outside both bodies.
    const segmentDistance = (q: Avoider) => {
      const dx = me.x - 1, dz = me.z - 4
      const t = Math.max(0, Math.min(1, ((q.x - 1) * dx + (q.z - 4) * dz) / (dx * dx + dz * dz || 1)))
      return Math.hypot(1 + dx * t - q.x, 4 + dz * t - q.z)
    }
    expect(Math.min(segmentDistance(ahead), segmentDistance(side))).toBeGreaterThanOrEqual(GAP * 0.8 - 1e-6)
  })
})


it('backs into a pullout with fixed priority, lets the other through, then resumes', () => {
  const lane = { ...grid([
    '#############',
    '#############',
    '.............',
    '########...##',
    '########...##',
    '#############',
  ]), step: 0.5 }
  const a = body(0.5, 1, [[5.5, 1]])
  const b = body(5.5, 1, [[0.5, 1]])
  let yielded = false
  let least = Infinity
  for (let t = 0; t < 30; t += 0.05) {
    beginAvoidance([a, b])
    for (const p of [a, b]) {
      walkAround([a, b], p, lane, SPEED * 0.05, 0.05, GAP, all)
      least = Math.min(least, apart(a, b))
    }
    if (b.yielding) {
      yielded = true
      expect(b.yielding.to).toBe(a)
      expect(a.yielding).toBeNull()
    }
    separate([a, b], lane, GAP, 0.05, all)
  }
  expect(yielded).toBe(true)
  expect(least).toBeGreaterThanOrEqual(GAP * 0.8 - 1e-6)
  expect([a.x, a.z, b.x, b.z]).toEqual([5.5, 1, 0.5, 1])
})

it('three people crossing reach their destinations without crossing any swept body', () => {
  const people = [body(1, 4, [[14, 4]]), body(14, 4, [[1, 4]]), body(7, 1, [[7, 8]])]
  expect(run(people, open, 20)).toBeGreaterThanOrEqual(GAP * 0.8 - 1e-6)
  expect(people.map((p) => [p.x, p.z])).toEqual([[14, 4], [1, 4], [7, 8]])
})


describe('cooperative traffic', () => {
  const hall = { ...grid([
    '...#######...',
    '...#######...',
    '.............',
    '...#######...',
    '...#######...',
  ]), step: 0.5 }

  it('asks an idle person to step aside before contact, without moving a seated person', () => {
    const walker = body(1, 4, [[14, 4]])
    const idle = body(3, 4)
    const seated = body(8, 4)
    const people = [walker, idle, seated]
    let asked = false
    coordinateTraffic(people, open, GAP, all, (p) => p === idle, (p) => { asked = p === idle })
    expect(asked).toBe(true)
    expect(idle.yielding?.to).toBe(walker)
    expect(seated.route).toEqual([])
    expect(run(people, open, 16)).toBeGreaterThanOrEqual(GAP * 0.8 - 1e-6)
    expect([walker.x, walker.z]).toEqual([14, 4])
    expect(Math.hypot(idle.x - 3, idle.z - 4)).toBeGreaterThan(GAP)
  })

  it('holds opposite traffic outside a narrow hall, with room left at the exit', () => {
    const a = body(0, 1, [[6, 1]])
    const b = body(6, 1, [[0, 1]])
    const people = [a, b]
    let waited = false
    for (let t = 0; t < 24; t += 0.05) {
      beginAvoidance(people)
      coordinateTraffic(people, hall, GAP, all, () => false, () => {})
      for (const p of people) walkAround(people, p, hall, SPEED * 0.05, 0.05, GAP, all)
      const inside = (p: Avoider) => p.x > 1.25 && p.x < 4.75
      expect(inside(a) && inside(b)).toBe(false)
      waited ||= inside(a) && !inside(b)
      expect(apart(a, b)).toBeGreaterThanOrEqual(GAP * 0.8 - 1e-6)
      separate(people, hall, GAP, 0.05, all)
    }
    expect(waited).toBe(true)
    expect([a.x, a.z, b.x, b.z]).toEqual([6, 1, 0, 1])
  })
})

describe('individual walking routes', () => {
  it('chooses repeatable but different walks through open space, preserving endpoints', () => {
    const me = body(1, 4)
    const routes = Array.from({ length: 6 }, (_, i) => walkingRoute(open, [1, 4], [14, 4], [me], me, GAP, all, i, true))
    expect(new Set(routes.map((r) => JSON.stringify(r))).size).toBeGreaterThan(1)
    expect(walkingRoute(open, [1, 4], [14, 4], [me], me, GAP, all, 2, true)).toEqual(routes[2])
    for (const r of routes) {
      expect(r[0]).toEqual([1, 4])
      expect(r.at(-1)).toEqual([14, 4])
    }
    expect(walkingRoute(open, [1, 4], [14, 4], [me], me, GAP, all, 2, false)).toEqual([[1, 4], [14, 4]])
  })

  it('chooses the less crowded side of a wall rather than smoothing back into the crowd', () => {
    const g = grid(['.........', '.........', '...###...', '...###...', '...###...', '.........', '.........'])
    const me = body(1, 3)
    const crowd = [me, body(3, 1), body(4, 1), body(5, 1)]
    const path = walkingRoute(g, [1, 3], [7, 3], crowd, me, GAP, all, 1, false)
    expect(path.some((p) => p[1] >= 5)).toBe(true)
    expect(path.some((p) => p[1] <= 1)).toBe(false)
    expect(path.at(-1)).toEqual([7, 3])
  })
})


it('keeps its chosen passing side when the other person shifts slightly across the centre line', () => {
  const a = body(1, 4, [[14, 4]]), b = body(2.3, 4.01)
  walkAround([a, b], a, open, 0.075, 0.05, GAP, all)
  const side = Math.sign(a.z - 4)
  b.z = a.z - 0.01
  const before = a.z
  walkAround([a, b], a, open, 0.075, 0.05, GAP, all)
  expect(Math.sign(a.z - before)).toBe(side)
})

it('does not add personal bends through walls or change a disconnected destination into a reachable one', () => {
  const lane = grid(['#########', '.........', '#########'])
  const me = body(0, 1)
  for (let seed = 0; seed < 12; seed++) {
    const path = walkingRoute(lane, [0, 1], [8, 1], [me], me, GAP, all, seed, true)
    let from: P = [0, 1]
    for (const to of path) {
      for (let k = 0; k <= 40; k++) {
        const x = from[0] + (to[0] - from[0]) * k / 40
        const z = from[1] + (to[1] - from[1]) * k / 40
        expect(isFree(lane, Math.round(x), Math.round(z))).toBe(true)
      }
      from = to
    }
  }
  expect(walkingRoute(grid(['..#..', '..#..']), [0, 0], [4, 0], [me], me, GAP, all, 1, true)).toEqual([])
})


it('gives someone already in the narrow passage priority even when listed later', () => {
  const g = { ...grid(['...#######...', '...#######...', '.............', '...#######...', '...#######...']), step: 0.5 }
  const waiting = body(0, 1, [[0, 1], [6, 1]])
  const inside = body(3, 1, [[0, 1]])
  coordinateTraffic([waiting, inside], g, GAP, all, () => false, () => {})
  expect(waiting.yielding?.to).toBe(inside)
  expect(inside.yielding).toBeNull()
})
