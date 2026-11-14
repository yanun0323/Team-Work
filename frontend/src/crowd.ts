// What the people out on the island get up to: strolling, sitting on benches, stopping to chat and walking on
// together, waving in passing, looking out to sea or paddling on the beach, looking up at
// a company's front door, and going indoors after dark. Now and then someone calls in at the staffing agency for a
// while, and when the island needs more people or fewer, newcomers come out of its door and those no longer needed
// go in and are gone. Decisions and walking only, nothing drawn; pure data, no three.js. `People.tsx` poses the
// figures from what is here.

import { coordinateTraffic, walkingRoute, beginAvoidance, openSpot, separate, spotTaken, UNHINDERED, walkAround, type Avoider } from './avoid'
import { CELL, hash, rectCenter, type Town } from './layout'
import { DOORSTEP } from './staffingGrounds'
import { cellPos, headingOf, isFree, type BenchSeat, type Grid, type P, type Stroller } from './walk'

/** What someone is up to, besides walking or sitting. */
export type Doing =
  | 'stroll'
  /** Standing and staring into space, with a thought bubble. */
  | 'daze'
  /** Talking with `partner`, face to face; `lead` walked over. */
  | 'chat'
  /** Walking somewhere with `partner`: `lead` goes first, the other follows. */
  | 'pair'
  /** Stopped to wave at someone walking past. */
  | 'wave'
  /** Looking out to sea from the grass by the shore. */
  | 'view'
  /** Down on the beach, paddling: only people in swimwear. */
  | 'sea'
  /** In front of a company's door, looking up at the building. */
  | 'door'
  /** Under a lamp after dark. */
  | 'lamp'
  /** Going indoors for the night, or indoors (`home`). */
  | 'home'

export interface Townsfolk extends Stroller, Avoider {
  /** The walk cycle, for the legs (`pose`). */
  phase: number
  doing: Doing
  /** Chatting or walking together: with whom, by index; -1 for nobody. */
  partner: number
  lead: boolean
  /** Seconds into what they are doing, for gestures. */
  t: number
  /** Stopped part way (to wave): walks on along the rest of the route afterwards, back to `then`. */
  resume: boolean
  then: Doing
  /** Seconds before waving at anyone again. */
  cool: number
  /** Indoors: not drawn. */
  home: boolean
  /** The door gone in by, or the shore spot gone to, by index; -1 for none. */
  door: number
  spot: number
  /** Distance walked in the last step, for the stride. */
  moved: number
  /** No longer needed on the island: off to the staffing agency, and gone once in (`settleCount`). */
  leaving: boolean
}

/** A stroller as `walk` knows it, with nothing going on yet. */
export const townsfolk = (s: Stroller): Townsfolk => ({
  ...s, phase: 0, doing: 'stroll', partner: -1, lead: false, t: 0, resume: false, then: 'stroll', cool: 0, home: false, door: -1, spot: -1, moved: 0, leaving: false, ...UNHINDERED,
})

/** Where people go on the island besides anywhere: doors, lamps and the shore, in world units. */
export interface Places {
  /** In front of each building's entrance (`at`, facing it), and just inside (`inside`) for going in. */
  doors: Array<{ at: P; inside: P }>
  /** The staffing agency's door among `doors`, by index; -1 when it has none. */
  agency: number
  /** Beside each lamp post, a little in under it. */
  lamps: P[]
  /** On the grass a cell back from a straight bit of coast (`at`), facing the sea, and down on the beach in front of it (`beach`). */
  shore: Array<{ at: P; heading: number; beach: P | null }>
}

/** Walking speed on the island, in world units per second: an office unit a second, scaled up. */
export const ISLAND_SPEED = 1.5
/** How far apart two people stand to talk, in world units. */
export const ISLAND_TALK_GAP = 1.2
/** The room each person keeps about them, in world units: a shoulder's width either side, so nobody walks through anyone. */
export const ISLAND_GAP = 1.2
/** How far behind the other someone walks with them, in world units. */
const PAIR_GAP = 1.1
/** Two people walking past each other this close may stop and wave, in world units. */
export const WAVE_NEAR = 2.4
/** How far someone looks for another to go and talk to, in world units. */
const CHAT_REACH = 24
/** Seconds of a wave. */
export const WAVE_SECONDS = 1.6
/** How many of the people go indoors at full night. */
export const HOME_SHARE = 0.6
/** How far past the grass edge, in world units, someone paddling stands: on the sand, short of the sea. */
const PADDLE = 0.5
/** The share of someone's choices, by day, that is calling in at the staffing agency. */
export const VISIT_SHARE = 0.04
/** How long a call at the staffing agency lasts, in seconds. */
const VISIT_SECONDS: P = [6, 15]
/** Seconds between newcomers coming out of the staffing agency, one after another. */
export const ARRIVAL_GAP = 1.5

/**
 * Where people can go on the island: a spot in front of each entrance (on the +z side, its middle two cells), a free
 * cell next to each lamp, and spots along straight bits of the coast. `sandOk`, given a world point, says whether the
 * beach is under it; without it every straight bit of coast counts as having a beach.
 */
export function islandPlaces(town: Town, g: Grid, sandOk: (x: number, z: number) => boolean = () => true): Places {
  const doors: Places['doors'] = []
  // the staffing agency's first, so its index holds as companies come and go: on its path, the first row out from the
  // rotunda with both middle cells free, and the foot of its steps for going in
  const s = town.staffing
  const [, sz] = rectCenter(town, s)
  let agency = -1
  for (let z = s.z + s.d / 2; z < s.z + s.d; z++) {
    const mid = s.x + s.w / 2
    if (!isFree(g, mid - 1, z) || !isFree(g, mid, z)) continue
    const [x0, cz] = cellPos(g, mid - 1, z)
    const [x1] = cellPos(g, mid, z)
    agency = doors.push({ at: [(x0 + x1) / 2, cz], inside: [(x0 + x1) / 2, sz + DOORSTEP] }) - 1
    break
  }
  for (const l of town.lots) {
    const b = l.building
    const mid = b.x + b.w / 2
    // the first row out from the building where both door cells are free: a cell's margin is kept round every building
    for (let k = 1; k <= 4; k++) {
      const z = b.z + b.d + k
      if (!isFree(g, mid - 1, z) || !isFree(g, mid, z)) continue
      const [x0, cz] = cellPos(g, mid - 1, z)
      const [x1] = cellPos(g, mid, z)
      const x = (x0 + x1) / 2
      // the building's front, then a step in under the awning, short of the glass doors
      const front = g.z0 + (b.z + b.d) * g.step - g.step / 2
      doors.push({ at: [x, cz], inside: [x, front - 0.4] })
      break
    }
  }
  const lamps: P[] = []
  for (const l of town.lots) for (const pr of l.props) {
    if (pr.kind !== 'lamp') continue
    const near = SIDES.map(([dx, dz]) => [pr.x + dx, pr.z + dz] as P).find(([x, z]) => isFree(g, x, z))
    if (!near) continue
    const [lx, lz] = cellPos(g, pr.x, pr.z)
    const [nx, nz] = cellPos(g, ...near)
    lamps.push([nx + (lx - nx) * 0.25, nz + (lz - nz) * 0.25])
  }
  const sea = (x: number, z: number) => x < 0 || z < 0 || x >= town.cols || z >= town.rows || town.ground[z * town.cols + x] === null
  const shore: Places['shore'] = []
  for (let z = 0; z < town.rows; z++) for (let x = 0; x < town.cols; x++) {
    if (town.ground[z * town.cols + x] !== 'shore') continue
    const out = SIDES.filter(([dx, dz]) => sea(x + dx, z + dz))
    if (out.length !== 1) continue
    const [dx, dz] = out[0]
    // a straight bit: land on both sides along the coast, and grass to stand on behind
    if (sea(x + dz, z + dx) || sea(x - dz, z - dx) || !isFree(g, x - dx, z - dz)) continue
    const [sx, sz] = cellPos(g, x, z)
    const beach: P = [sx + dx * (g.step / 2 + PADDLE), sz + dz * (g.step / 2 + PADDLE)]
    shore.push({ at: cellPos(g, x - dx, z - dz), heading: headingOf(dx, dz), beach: sandOk(...beach) ? beach : null })
  }
  return { doors, agency, lamps, shore }
}

/** Someone new to the island, just inside the staffing agency's door and coming out in `wait` seconds; null without one. */
export function newcomer(places: Places, wait: number): Townsfolk | null {
  const door = places.doors[places.agency]
  if (!door) return null
  const p = townsfolk({ x: door.inside[0], z: door.inside[1], route: [], heading: 0, mode: 'standing', wait, seat: null, toSeat: false })
  p.home = true
  p.door = places.agency
  return p
}

/**
 * The island needs `n` people: everyone past the first `n` is marked leaving, and those of them at the end of the list
 * who have gone in are let go, at once with `instantly` (nobody walking: reduced motion). Returns how many are left.
 */
export function settleCount(people: Townsfolk[], n: number, instantly = false): number {
  people.forEach((p, i) => (p.leaving = i >= n))
  let k = people.length
  while (k > n && (instantly || people[k - 1].home)) k--
  people.length = k
  return k
}

const SIDES: P[] = [[1, 0], [-1, 0], [0, 1], [0, -1]]

/** What the island is like this moment, for `stepCrowd`. */
export interface Scene {
  grid: Grid
  seats: BenchSeat[]
  /** Free cells, as [x, z] cell indices: all of them, and the paved ones. */
  cells: P[]
  paved: P[]
  places: Places
  /** Who is in swimwear, by index. */
  swim: boolean[]
  /** How dark it is: 0 by day, 1 at night. */
  night: number
  /** Whom the camera follows, by index (-1 for nobody): they stay out and about. */
  followed: number
  /** The user, by index (-1 or left out when not on the island): they stay out and about too. */
  me?: number
}

/** Whether someone stays out, night or day: the one the camera follows, and the user. */
const staysOut = (s: Scene, i: number) => i === s.followed || i === s.me

const dist = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z)

/**
 * Whether someone is out of sight: indoors, or on the last steps in through the door, so they fade as they go in;
 * `fade` is how far they walk while fading, in world units. Coming out they fade in from the door as they walk.
 */
export function indoors(p: Townsfolk, fade: number) {
  if (p.home) return true
  if (p.doing !== 'home' || p.mode !== 'walking' || p.route.length !== 1) return false
  const [x, z] = p.route[0]
  return Math.hypot(x - p.x, z - p.z) <= fade
}

/** Whether someone goes indoors at this darkness: the same people every night, more of them the darker it is. */
export const goesHome = (i: number, night: number) => hash(i, 21) < HOME_SHARE * night

/** Two seats on the same bench: side by side, facing the same way. */
const besideSeat = (a: BenchSeat, b: BenchSeat) =>
  a !== b && Math.abs(a.heading - b.heading) < 1e-3 && Math.hypot(a.at[0] - b.at[0], a.at[1] - b.at[1]) < CELL * 1.05

/** Who sits next to `i` on the same bench, by index; -1 for nobody. */
export function benchMate(people: Townsfolk[], i: number): number {
  const me = people[i]
  if (me.mode !== 'sitting' || !me.seat) return -1
  return people.findIndex((o, j) => j !== i && o.mode === 'sitting' && !!o.seat && besideSeat(o.seat, me.seat as BenchSeat))
}

/**
 * Moves everyone on the island on by `dt` seconds (keep it short: see `inSteps`). `random` is for tests.
 */
export function stepCrowd(people: Townsfolk[], s: Scene, dt: number, random: () => number = Math.random) {
  beginAvoidance(people)
  const rand = (a: number, b: number) => a + random() * (b - a)
  const pick = <T,>(xs: T[]) => xs[Math.min(xs.length - 1, Math.floor(random() * xs.length))]
  const spot = (b: BenchSeat) => `${b.at}`
  const held = new Set(people.flatMap((p) => (p.seat ? [spot(p.seat)] : [])))
  const out = (p: Townsfolk) => !p.home && p.doing !== 'home'

  /** Stops chatting or walking together; the other one carries on alone. */
  const stopAct = (i: number) => {
    const p = people[i]
    const o = people[p.partner]
    if (o && o.partner === i && (o.doing === 'chat' || o.doing === 'pair')) {
      o.partner = -1
      o.doing = 'stroll'
      o.lead = false
      if (o.mode === 'standing') o.wait = Math.min(o.wait, rand(0.3, 1.2))
    }
    p.doing = 'stroll'
    p.partner = -1
    p.lead = false
    p.resume = false
    p.spot = -1
  }
  /** Stops where they are a moment, the rest of the way kept for after. */
  const pause = (p: Townsfolk, doing: Doing, seconds: number) => {
    p.resume = p.mode === 'walking' && p.route.length > 0
    p.then = p.doing
    p.mode = 'standing'
    p.doing = doing
    p.wait = seconds
    p.t = 0
  }
  const face = (a: Townsfolk, b: Townsfolk) => {
    a.heading = headingOf(b.x - a.x, b.z - a.z)
    b.heading = headingOf(a.x - b.x, a.z - b.z)
  }
  const nearestDoor = (p: Townsfolk) => {
    let best = -1
    s.places.doors.forEach((d, k) => {
      if (best < 0 || Math.hypot(d.at[0] - p.x, d.at[1] - p.z) < Math.hypot(s.places.doors[best].at[0] - p.x, s.places.doors[best].at[1] - p.z)) best = k
    })
    return best
  }
  // Fading figures and seated people are still bodies. Only fully indoors people are absent.
  const solid = (q: Townsfolk) => !q.home
  /** Nobody else (but `besides`) is standing there, or on their way there. */
  const open = (p: Townsfolk, at: P | null, besides?: Townsfolk) =>
    !!at && !spotTaken(people, p, at, ISLAND_GAP * 1.5, (q) => q !== besides && solid(q))
  /** Somewhere on the paving (mostly) or the grass that nobody has; null when the few tried are all taken. */
  const somewhere = (p: Townsfolk) => openSpot(() => cellPos(s.grid, ...(random() < 0.7 && s.paved.length ? pick(s.paved) : pick(s.cells))), people, p, ISLAND_GAP * 1.5, solid)

  /** Picks what to do next, standing somewhere with nothing to do. */
  const next = (i: number) => {
    const p = people[i]
    // off the beach first, back up onto the grass
    const shoreSpot = s.places.shore[p.spot]
    const back: P[] = p.doing === 'sea' && shoreSpot ? [shoreSpot.at] : []
    const from: P = back.at(-1) ?? [p.x, p.z]
    const wayTo = (from: P, to: P | null, stroll = true) => to ? walkingRoute(s.grid, from, to, people, p, ISLAND_GAP, solid, i, stroll) : []
    const was = p.doing
    const partner = people[p.partner]
    // done talking: sometimes the one who came over suggests a walk, and the other comes along
    if (was === 'chat' && !p.leaving && p.lead && partner && partner.partner === i && partner.doing === 'chat' && random() < 0.45) {
      const way = wayTo(from, somewhere(p))
      if (way.length) {
        p.route = way
        p.mode = 'walking'
        p.doing = 'pair'
        partner.route = [[p.x, p.z], ...way]
        partner.mode = 'walking'
        partner.doing = 'pair'
        partner.lead = false
        return
      }
    }
    stopAct(i)
    p.mode = 'walking'
    const go = (way: P[], doing: Doing, ...then: P[]) => {
      if (!way.length) return false
      p.route = [...back, ...way, ...then]
      p.doing = doing
      return true
    }
    const agency = s.places.doors[s.places.agency]
    // no longer needed: off to the staffing agency, or the nearest door without one
    if (p.leaving) {
      const k = agency ? s.places.agency : nearestDoor(p)
      const door = s.places.doors[k]
      if (door && go(wayTo(from, door.at, false), 'home', door.at, door.inside)) {
        p.door = k
        return
      }
    }
    if (goesHome(i, s.night) && !staysOut(s, i)) {
      const k = nearestDoor(p)
      const door = s.places.doors[k]
      if (door && go(wayTo(from, door.at, false), 'home', door.at, door.inside)) {
        p.door = k
        return
      }
    }
    const r = random()
    if (r < 0.3) {
      // someone standing about, not too far, to go and talk to
      const others = people.map((_, j) => j).filter((j) => {
        const o = people[j]
        return j !== i && o.mode === 'standing' && out(o) && ['stroll', 'daze', 'view', 'door', 'lamp'].includes(o.doing) && !o.resume && dist(o, p) < CHAT_REACH
      })
      if (others.length) {
        const j = pick(others)
        const o = people[j]
        // stand beside them as seen on screen (along x - z), so neither hides the other; on our side
        const side = p.x - p.z > o.x - o.z ? 1 : -1
        const off = (ISLAND_TALK_GAP / Math.SQRT2) * side
        const to: P = [o.x + off, o.z - off]
        const exact = isFree(s.grid, Math.round((to[0] - s.grid.x0) / s.grid.step), Math.round((to[1] - s.grid.z0) / s.grid.step))
        // somewhere free beside them: not where anyone else stands
        if (open(p, to, o) && go(wayTo(from, to), 'chat', ...(exact ? [to] : []))) {
          p.partner = j
          p.lead = true
          // the other waits where they are, until this one has had its say
          o.doing = 'chat'
          o.partner = i
          o.lead = false
          o.wait = 40
          return
        }
      }
    }
    if (r < 0.45) {
      // a seat free, with nobody standing in front of it
      const free = s.seats.filter((b) => !held.has(spot(b)) && open(p, b.front))
      // a seat beside someone already sitting, about half the time when there is one
      const company = free.filter((b) => s.seats.some((o) => held.has(spot(o)) && besideSeat(o, b)))
      const seat = company.length && random() < 0.5 ? pick(company) : free.length ? pick(free) : null
      const approach = seat ? wayTo(from, seat.front) : []
      const way = seat && approach.length ? [...approach, seat.at] : []
      if (seat && go(way, 'stroll')) {
        held.add(spot(seat))
        p.seat = seat
        p.toSeat = true
        return
      }
    }
    if (r < 0.55 && s.places.shore.length) {
      const k = Math.floor(random() * s.places.shore.length)
      const sh = s.places.shore[k]
      const paddle = s.swim[i] && !!sh.beach && random() < 0.75
      if (open(p, paddle ? sh.beach as P : sh.at) && go(wayTo(from, sh.at), paddle ? 'sea' : 'view', sh.at, ...(paddle ? [sh.beach as P] : []))) {
        p.spot = k
        return
      }
    }
    if (r < 0.63 && s.places.doors.length) {
      const k = Math.floor(random() * s.places.doors.length)
      const door = s.places.doors[k]
      if (open(p, door.at) && go(wayTo(from, door.at), 'door', door.at)) {
        p.door = k
        return
      }
    }
    if (r < 0.75 && go(wayTo(from, somewhere(p)), 'daze')) return
    // by day, now and then, calling in at the staffing agency for a while
    if (r < 0.75 + VISIT_SHARE && s.night < 0.5 && agency && !staysOut(s, i) && go(wayTo(from, agency.at, false), 'home', agency.at, agency.inside)) {
      p.door = s.places.agency
      return
    }
    // after dark, mostly to where the lamps are
    if (s.night > 0.5 && s.places.lamps.length && random() < 0.6) {
      const lamp = openSpot(() => pick(s.places.lamps), people, p, ISLAND_GAP * 1.5, solid)
      if (lamp && go(wayTo(from, lamp), 'lamp', lamp)) return
    }
    if (go(wayTo(from, somewhere(p)), 'stroll')) return
    p.route = back
    p.mode = back.length ? 'walking' : 'standing'
    p.wait = rand(1, 3)
  }

  /** At the end of the way. */
  const arrive = (i: number) => {
    const p = people[i]
    p.t = 0
    p.mode = 'standing'
    if (p.toSeat && p.seat) {
      p.mode = 'sitting'
      p.heading = p.seat.heading
      p.wait = rand(8, 20)
      p.toSeat = false
      return
    }
    const o = people[p.partner]
    const withMe = !!o && o.partner === i
    switch (p.doing) {
      case 'home':
        p.home = true
        p.wait = p.door === s.places.agency ? rand(...VISIT_SECONDS) : rand(2, 8)
        return
      case 'door':
        // face the building and look up at it
        p.heading = 0
        p.wait = rand(3, 5)
        return
      case 'view':
      case 'sea':
        p.heading = s.places.shore[p.spot]?.heading ?? p.heading
        p.wait = p.doing === 'sea' ? rand(6, 12) : rand(5, 10)
        return
      case 'lamp':
      case 'daze':
        p.heading = rand(-Math.PI, Math.PI)
        p.wait = rand(5, 10)
        return
      case 'chat':
        if (withMe && o.doing === 'chat') {
          face(p, o)
          p.wait = rand(5, 9)
          o.wait = p.wait + 30
          o.t = 0
        } else {
          stopAct(i)
          p.wait = rand(1, 3)
        }
        return
      case 'pair':
        if (p.lead) {
          // wait for the other to catch up
          p.wait = 20
        } else if (withMe && o.doing === 'pair' && o.mode === 'standing') {
          // together again: talk a while, the one who led the way first
          face(p, o)
          p.doing = o.doing = 'chat'
          o.lead = true
          o.wait = rand(4, 7)
          p.wait = o.wait + 30
          o.t = 0
        } else {
          stopAct(i)
          p.wait = rand(1, 3)
        }
        return
      default:
        p.doing = 'stroll'
        p.wait = rand(1, 4)
    }
  }

  // two walking past each other may stop and wave; each looks out for it only now and then
  for (let i = 0; i < people.length; i++) {
    const a = people[i]
    if (a.yielding || a.mode !== 'walking' || a.doing !== 'stroll' || a.cool > 0 || !out(a)) continue
    for (let j = i + 1; j < people.length; j++) {
      const b = people[j]
      if (b.yielding || b.mode !== 'walking' || b.doing !== 'stroll' || b.cool > 0 || !out(b) || dist(a, b) > WAVE_NEAR) continue
      a.cool = rand(20, 40)
      b.cool = rand(20, 40)
      if (random() < 0.5) {
        pause(a, 'wave', WAVE_SECONDS)
        pause(b, 'wave', WAVE_SECONDS)
        face(a, b)
      }
      break
    }
  }

  /** An unavailable route never disables collision: cancel, then decide again after waiting. */
  const cantGetThere = (i: number) => {
    const p = people[i]
    p.yielding = null
    if (p.doing === 'home') {
      p.doing = 'stroll'
      p.route = []
      p.mode = 'standing'
      p.wait = rand(1, 3)
      return
    }
    const giveUp = () => {
      p.route = []
      p.mode = 'standing'
      p.wait = rand(0.5, 1.5)
      p.t = 0
    }
    if (p.toSeat && p.seat) {
      // someone in front of the bench: let it go
      ;[p.seat, p.toSeat] = [null, false]
      p.doing = 'stroll'
      return giveUp()
    }
    if (p.doing === 'chat') {
      stopAct(i)
      return giveUp()
    }
    // short of the beach: look out to sea from here
    if (p.doing === 'sea') p.doing = 'view'
    // anywhere else will do: stop here, and `arrive` does the rest
    p.route = []
  }

  coordinateTraffic(people, s.grid, ISLAND_GAP, solid,
    (p) => p.mode === 'standing' && !p.home && !p.resume && !['home', 'sea'].includes(p.doing),
    (p) => {
      stopAct(people.indexOf(p))
      p.mode = 'walking'
      p.cool = Math.max(p.cool, 5)
    })

  people.forEach((p, i) => {
    p.wait -= dt
    p.t += dt
    p.cool -= dt
    p.moved = 0
    if (p.home) {
      p.blocked = false
      // gone for good: `settleCount` lets them go
      if (p.leaving) return
      // back out once it is light again; the one the camera follows comes out at once
      if (staysOut(s, i)) p.wait = Math.min(p.wait, 0)
      if (p.wait > 0 || (goesHome(i, s.night) && !staysOut(s, i))) return
      const door = s.places.doors[p.door] ?? s.places.doors[0]
      // Keep the whole doorway clear; someone already approaching it enters before we emerge.
      if (door && people.some((q) => q !== p && solid(q) && (
        Math.hypot(q.x - door.inside[0], q.z - door.inside[1]) < ISLAND_GAP ||
        Math.hypot(q.x - door.at[0], q.z - door.at[1]) < ISLAND_GAP ||
        (q.doing === 'home' && q.route.at(-1) === door.inside && Math.hypot(q.x - door.at[0], q.z - door.at[1]) < ISLAND_GAP * 3)
      ))) return
      p.home = false
      p.doing = 'stroll'
      if (door) {
        ;[p.x, p.z] = door.inside
        beginAvoidance([p]) // appearing here is not a move from the previous building's door
        p.route = [door.at]
        p.mode = 'walking'
      } else {
        p.mode = 'standing'
        p.wait = rand(1, 3)
      }
      return
    }
    // no longer needed: no lingering on a bench or standing about first
    if (p.leaving && out(p) && p.mode !== 'walking') p.wait = Math.min(p.wait, 0)
    if (p.mode === 'sitting') {
      if (p.wait > 0) return
      // get up, step off the bench and carry on; not stopping half out of it to wave
      p.route = [(p.seat as BenchSeat).front]
      p.seat = null
      p.mode = 'walking'
      p.doing = 'stroll'
      p.cool = Math.max(p.cool, 3)
    } else if (p.mode === 'walking') {
      const o = people[p.partner]
      // round everyone else; not round whoever they are walking up to, or along with
      const along = (p.doing === 'chat' || p.doing === 'pair') && o && o.partner === i ? o : null
      p.moved = walkAround(people, p, s.grid, ISLAND_SPEED * dt, dt, ISLAND_GAP, solid, along)
      if (p.blocked) {
        p.blocked = false
        cantGetThere(i)
      }
      // following: stop a step behind the one who led, once they have stopped
      if (p.doing === 'pair' && !p.lead && o && o.partner === i && o.mode === 'standing' && dist(p, o) < PAIR_GAP) p.route = []
      if (p.mode === 'walking' && !p.route.length && !p.yielding) arrive(i)
    } else {
      const o = people[p.partner]
      // the one we were talking or walking with went off
      if ((p.doing === 'chat' || p.doing === 'pair') && !(o && o.partner === i && (o.doing === 'chat' || o.doing === 'pair'))) {
        stopAct(i)
        p.wait = Math.min(p.wait, rand(0.5, 1.5))
      }
      // standing on top of someone, with nowhere to be eased to: move off
      if (p.blocked) {
        p.blocked = false
        p.wait = 0
      }
      if (p.wait > 0) return
      if (p.resume && p.route.length) {
        // carry on the way they were going
        p.resume = false
        p.mode = 'walking'
        p.doing = p.then
        return
      }
      next(i)
    }
  })
  // anyone still too close is eased apart, taking a step for it
  separate(people, s.grid, ISLAND_GAP, dt, solid, (q, d) => (q.moved += d), (q) => solid(q) && q.mode !== 'sitting')
}
