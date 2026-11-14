import { describe, expect, it } from 'vitest'
import {
  ARRIVAL_GAP, benchMate, goesHome, HOME_SHARE, indoors, ISLAND_GAP, islandPlaces, ISLAND_TALK_GAP, newcomer, settleCount, stepCrowd, townsfolk, VISIT_SHARE, WAVE_SECONDS,
  type Scene, type Townsfolk,
} from './crowd'
import { layoutTown, rectCenter } from './layout'
import { DOORSTEP, GROUNDS } from './staffingGrounds'
import { stuckCheck } from './stuckCheck'
import { benchSeats, cellPos, crowdSize, freeCells, isFree, resettle, townGrid, type P } from './walk'

/** The same run every time. */
function seeded(seed = 1) {
  let s = seed
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

function island() {
  const town = layoutTown([
    { id: 'a', name: 'A', members: 4, done: 6 },
    { id: 'b', name: 'B', members: 6, done: 2 },
    { id: 'c', name: 'C', members: 2 },
  ])
  const grid = townGrid(town)
  const cells = freeCells(grid)
  const scene: Scene = {
    grid, seats: benchSeats(town, grid), cells, paved: cells.filter(([x, z]) => town.ground[z * town.cols + x] === 'pave'),
    places: islandPlaces(town, grid), swim: [], night: 0, followed: -1,
  }
  const n = crowdSize(town)
  scene.swim = Array.from({ length: n }, (_, i) => i % 2 === 0)
  const people = Array.from({ length: n }, (_, i) => {
    const [x, z] = cellPos(grid, ...scene.paved[(i * 7) % scene.paved.length])
    return townsfolk({ x, z, route: [], heading: 0, mode: 'standing', wait: 0.5 + (i % 3), seat: null, toSeat: false })
  })
  return { town, grid, scene, people }
}

const run = (people: Townsfolk[], scene: Scene, seconds: number, random: () => number, each?: () => void) => {
  for (let t = 0; t < seconds; t += 0.1) {
    stepCrowd(people, scene, 0.1, random)
    each?.()
  }
}

const cellOf = (scene: Scene, [x, z]: P) => [Math.round((x - scene.grid.x0) / scene.grid.step), Math.round((z - scene.grid.z0) / scene.grid.step)] as const

describe('islandPlaces', () => {
  it('finds a free spot in front of every entrance, and its way in', () => {
    const { town, scene } = island()
    // every company's, and the staffing agency's
    expect(scene.places.doors).toHaveLength(town.lots.length + 1)
    for (const d of scene.places.doors) {
      expect(isFree(scene.grid, ...cellOf(scene, d.at))).toBe(true)
      // straight in: the entrance is on the +z side
      expect(d.inside[0]).toBe(d.at[0])
      expect(d.inside[1]).toBeLessThan(d.at[1])
      expect(isFree(scene.grid, ...cellOf(scene, d.inside))).toBe(false)
    }
  })

  it("puts the staffing agency's door first, on its path, at the foot of its steps", () => {
    const { town, scene } = island()
    expect(scene.places.agency).toBe(0)
    const door = scene.places.doors[scene.places.agency]
    const [cx, cz] = rectCenter(town, town.staffing)
    expect(door.at[0]).toBeCloseTo(cx)
    expect(door.inside).toEqual([door.at[0], cz + DOORSTEP])
    expect(Math.abs(door.at[1] - cz - GROUNDS.path.z)).toBeLessThanOrEqual(GROUNDS.path.d / 2)
  })

  it('finds lamps to stand by, and spots on the grass facing the sea with the beach in front', () => {
    const { town, scene } = island()
    expect(scene.places.lamps.length).toBeGreaterThan(0)
    expect(scene.places.shore.length).toBeGreaterThan(0)
    for (const s of scene.places.shore) {
      expect(isFree(scene.grid, ...cellOf(scene, s.at))).toBe(true)
      const beach = s.beach as P
      // the beach lies the way they face, two cells out, past the shore cell
      const [bx, bz] = cellOf(scene, beach)
      expect(bx < 0 || bz < 0 || bx >= town.cols || bz >= town.rows || town.ground[bz * town.cols + bx] === null || town.ground[bz * town.cols + bx] === 'shore').toBe(true)
      const way = Math.atan2(-(beach[0] - s.at[0]), -(beach[1] - s.at[1]))
      expect(Math.cos(way - s.heading)).toBeCloseTo(1)
    }
  })

  it('leaves the beach out where there is no sand', () => {
    const { town, grid } = island()
    expect(islandPlaces(town, grid, () => false).shore.every((s) => s.beach === null)).toBe(true)
  })
})

describe('stepCrowd', () => {
  it('sends some indoors at night, the same ones each night, and brings them out by day', () => {
    const { scene, people } = island()
    scene.night = 1
    run(people, scene, 400, seeded(3))
    const inside = people.flatMap((p, i) => (p.home ? [i] : []))
    expect(inside.length).toBeGreaterThan(0)
    for (const i of inside) expect(goesHome(i, 1)).toBe(true)
    // about the share meant to, of those it picks
    expect(people.filter((_, i) => goesHome(i, 1)).length).toBeLessThanOrEqual(Math.ceil(people.length * HOME_SHARE) + 2)
    scene.night = 0
    run(people, scene, 60, seeded(4))
    // by day nobody is indoors at a company; some may be calling in at the staffing agency
    expect(people.some((p) => p.home && p.door !== scene.places.agency)).toBe(false)
  })

  it('has people call in at the staffing agency by day for a while, and come out again', () => {
    const { scene, people } = island()
    // always choosing a call, then anything once there
    let calling = true
    const random = seeded(5)
    const choose = () => (calling ? 0.75 + VISIT_SHARE / 2 : random())
    let went = false
    run(people, scene, 120, choose, () => {
      if (people.some((p) => p.home && p.door === scene.places.agency)) {
        went = true
        calling = false
      }
    })
    expect(went).toBe(true)
    run(people, scene, 60, seeded(6))
    // nobody calling in now, so everyone is back out
    calling = false
    expect(people.every((p) => !p.home)).toBe(true)
  })

  it('lets newcomers out of the staffing agency one after another, and walks those no longer needed in there', () => {
    const { scene, people: everyone } = island()
    const door = scene.places.doors[scene.places.agency]
    // nobody starting out in the doorway: anyone standing there keeps others in, as at any door
    const people = everyone.filter((p) => Math.hypot(p.x - door.at[0], p.z - door.at[1]) > 4)
    const n = people.length
    // two more needed: they wait inside the door, and come out in turn
    const fresh = [0, 1].map((k) => newcomer(scene.places, k * ARRIVAL_GAP)!)
    people.push(...fresh)
    expect(fresh.every((p) => p.home && p.x === door.inside[0] && p.z === door.inside[1])).toBe(true)
    // the first out before the second, and both out before long
    let order: boolean[] | null = null
    run(people, scene, 30, seeded(7), () => {
      if (!order && !fresh[0].home) order = fresh.map((p) => p.home)
    })
    expect(order).toEqual([false, true])
    expect(fresh.every((p) => !p.home)).toBe(true)
    expect(settleCount(people, n + 2)).toBe(n + 2)

    // three fewer: the last three walk in at the staffing agency and are gone; nobody else goes
    const leaving = people.slice(n - 1)
    expect(settleCount(people, n - 1)).toBe(n + 2)
    expect(leaving.every((p) => p.leaving)).toBe(true)
    let left = people.length
    for (let t = 0; t < 240 && left > n - 1; t += 0.1) {
      stepCrowd(people, scene, 0.1, seeded(9 + Math.round(t * 10)))
      left = settleCount(people, n - 1)
    }
    expect(left).toBe(n - 1)
    expect(leaving.every((p) => p.home && p.door === scene.places.agency)).toBe(true)
    expect(people.every((p) => !p.leaving)).toBe(true)
  })

  it('lets go of those no longer needed at once, with nobody walking', () => {
    const { people } = island()
    expect(settleCount(people, 2, true)).toBe(2)
    expect(people).toHaveLength(2)
  })

  it('counts someone as out of sight only on the last steps in through the door, and indoors', () => {
    const p = townsfolk({ x: 0, z: 0, route: [[0, -3], [0, -4]], heading: 0, mode: 'walking', wait: 0, seat: null, toSeat: false })
    p.doing = 'home'
    expect(indoors(p, 0.5)).toBe(false)
    p.route = [[0, -4]]
    p.z = -3
    expect(indoors(p, 0.5)).toBe(false)
    p.z = -3.6
    expect(indoors(p, 0.5)).toBe(true)
    // walking somewhere else, past a door, is no going in
    p.doing = 'stroll'
    expect(indoors(p, 0.5)).toBe(false)
    p.home = true
    expect(indoors(p, 0.5)).toBe(true)
  })

  it('never keeps indoors the one the camera follows', () => {
    const { scene, people } = island()
    const homebody = people.findIndex((_, i) => goesHome(i, 1))
    expect(homebody).toBeGreaterThanOrEqual(0)
    scene.night = 1
    run(people, scene, 400, seeded(5))
    scene.followed = homebody
    run(people, scene, 1, seeded(6))
    expect(people[homebody].home).toBe(false)
    run(people, scene, 200, seeded(7))
    expect(people[homebody].home).toBe(false)
  })

  it('keeps the user out and about, at night and when others call in at the staffing agency', () => {
    const { scene, people } = island()
    const me = people.findIndex((_, i) => goesHome(i, 1))
    scene.me = me
    scene.night = 1
    run(people, scene, 400, seeded(5), () => expect(people[me].home).toBe(false))
    scene.night = 0
    // always choosing to call in
    run(people, scene, 120, () => 0.75 + VISIT_SHARE / 2, () => expect(people[me].home).toBe(false))
  })

  it('pairs people up to talk, face to face, and only ever both ways', () => {
    const { scene, people } = island()
    let talks = 0
    let pairs = 0
    run(people, scene, 1200, seeded(3), () => {
      people.forEach((p, i) => {
        if (p.doing === 'pair' && p.lead) pairs++
        if (p.doing !== 'chat' || p.mode !== 'standing' || !p.lead) return
        const o = people[p.partner]
        if (!o || o.partner !== i || o.mode !== 'standing') return
        talks++
        expect(Math.hypot(o.x - p.x, o.z - p.z)).toBeLessThan(ISLAND_TALK_GAP * 3)
        expect(Math.cos(p.heading - Math.atan2(-(o.x - p.x), -(o.z - p.z)))).toBeGreaterThan(0.9)
      })
      for (const [i, p] of people.entries()) if (p.partner >= 0) expect(p.partner).not.toBe(i)
    })
    expect(talks).toBeGreaterThan(0)
    expect(pairs).toBeGreaterThan(0)
  })

  it('takes only people in swimwear down to the beach', () => {
    const { scene, people } = island()
    let paddled = 0
    run(people, scene, 900, seeded(9), () => people.forEach((p, i) => {
      if (p.doing !== 'sea') return
      expect(scene.swim[i]).toBe(true)
      if (p.mode === 'standing') paddled++
    }))
    expect(paddled).toBeGreaterThan(0)
  })

  it('has two walking past each other stop, wave and walk on', () => {
    const { scene } = island()
    const [ax, az] = cellPos(scene.grid, ...scene.paved[0])
    const walker = (x: number, to: number) => townsfolk({ x, z: az, route: [[to, az]], heading: 0, mode: 'walking', wait: 0, seat: null, toSeat: false })
    const people = [walker(ax, ax + 10), walker(ax + 2, ax - 10)]
    stepCrowd(people, scene, 0.1, () => 0.1)
    expect(people.map((p) => p.doing)).toEqual(['wave', 'wave'])
    expect(people.every((p) => p.mode === 'standing' && p.resume)).toBe(true)
    run(people, scene, WAVE_SECONDS + 0.2, () => 0.9)
    expect(people.every((p) => p.mode === 'walking')).toBe(true)
  })

  it('never leaves two on top of each other, nor anyone going nowhere, through days and nights, even twice as many', () => {
    for (const seed of [14, 15, 16]) {
      const { scene, people: few } = island()
      const people = [...few, ...few.map((p, i) => townsfolk({ ...p, x: p.x, z: p.z, route: [], wait: 1 + (i % 4) }))]
      resettle(people, scene.grid, scene.seats, ISLAND_GAP * 0.8)
      scene.swim = people.map((_, i) => i % 2 === 0)
      const check = stuckCheck(ISLAND_GAP * 0.5, ISLAND_GAP)
      let t = 0
      run(people, scene, 1200, seeded(seed), () => {
        t += 0.1
        // night falls and day breaks again
        scene.night = t % 400 < 200 ? 0 : 1
        check.step(people.map((p) => ({
          x: p.x, z: p.z, walking: p.mode === 'walking' && !p.home,
          solid: !p.home,
        })), 0.1)
      })
      expect(check.minimum).toBeGreaterThanOrEqual(ISLAND_GAP * 0.8 - 1e-6)
      expect(check.overlap).toBe(0)
      // held up, they go round, wait or give up within a few seconds
      expect(check.frozen).toBeLessThan(10)
    }
  })

  it('knows who sits next to whom on a bench', () => {
    const { scene } = island()
    const [a, b] = scene.seats
    const sit = (seat: typeof a) => townsfolk({ x: seat.at[0], z: seat.at[1], route: [], heading: seat.heading, mode: 'sitting', wait: 10, seat, toSeat: false })
    const people = [sit(a), sit(b), sit(scene.seats[2])]
    expect(benchMate(people, 0)).toBe(1)
    expect(benchMate(people, 1)).toBe(0)
    expect(benchMate(people, 2)).toBe(-1)
  })
})


it('queues visible bodies entering and leaving the same door, without hiding fading people from collision', () => {
  const { scene } = island()
  const door = scene.places.doors[0]
  const person = (x: number, z: number) => townsfolk({ x, z, route: [], heading: 0, mode: 'standing', wait: 0, seat: null, toSeat: false })
  const a = person(...door.inside), b = person(...door.inside)
  a.home = b.home = true
  a.door = b.door = 0
  const c = person(door.at[0], door.at[1] + 2)
  c.doing = 'home'; c.mode = 'walking'; c.route = [door.at, door.inside]
  const people = [a, b, c]
  const check = stuckCheck(ISLAND_GAP * 0.8, ISLAND_GAP)
  run(people, scene, 60, seeded(31), () => check.step(people.map((p) => ({ x: p.x, z: p.z, solid: !p.home, walking: !p.home && p.mode === 'walking' })), 0.1))
  expect(check.minimum).toBeGreaterThanOrEqual(ISLAND_GAP * 0.8 - 1e-6)
  expect(a.home || b.home).toBe(false)
})


it('keeps an indoor person inside while someone approaches the same entrance', () => {
  const { scene } = island()
  const door = scene.places.doors[0]
  const a = townsfolk({ x: door.inside[0], z: door.inside[1], route: [], heading: 0, mode: 'standing', wait: 0, seat: null, toSeat: false })
  a.home = true; a.door = 0
  const b = townsfolk({ x: door.at[0], z: door.at[1] + 1.5, route: [door.at, door.inside], heading: 0, mode: 'walking', wait: 0, seat: null, toSeat: false })
  b.doing = 'home'
  stepCrowd([a, b], scene, 0.1, seeded(31))
  expect(a.home).toBe(true)
  let entered = false, emerged = false
  const check = stuckCheck(ISLAND_GAP * 0.8, ISLAND_GAP)
  run([a, b], scene, 15, seeded(31), () => {
    entered ||= b.home
    emerged ||= !a.home
    check.step([a, b].map((p) => ({ x: p.x, z: p.z, walking: p.mode === 'walking', solid: !p.home })), 0.1)
  })
  expect(entered).toBe(true)
  expect(emerged).toBe(true)
  expect(check.minimum).toBeGreaterThanOrEqual(ISLAND_GAP * 0.8 - 1e-6)
})

it("interrupts a chat to clear a passerby's route, including its partner and walking pose", () => {
  const grid = { cols: 16, rows: 9, step: 1, x0: 0, z0: 0, free: new Uint8Array(16 * 9).fill(1) }
  const scene: Scene = { grid, seats: [], cells: freeCells(grid), paved: [], places: { doors: [], agency: -1, lamps: [], shore: [] }, swim: [], night: 0, followed: -1 }
  const person = (x: number, z: number) => townsfolk({ x, z, route: [], heading: 0, mode: 'standing', wait: 30, seat: null, toSeat: false })
  const a = person(1, 4), b = person(4, 4), c = person(4, 5.5)
  a.route = [[14, 4]]; a.mode = 'walking'; a.cool = 60
  b.doing = c.doing = 'chat'; b.partner = 2; c.partner = 1
  stepCrowd([a, b, c], scene, 0.1, seeded(7))
  expect(b.yielding?.to).toBe(a)
  expect(b.mode).toBe('walking')
  expect(b.moved).toBeGreaterThan(0)
  expect(b.partner).toBe(-1)
  expect(c.partner).toBe(-1)
  expect(b.doing).toBe('stroll')
  expect(c.doing).toBe('stroll')
})
