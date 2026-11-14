// Shared island/office movement. Comfort spacing is soft; body spacing is never disabled.
// Every move (including yielding and separation) is swept against all visible bodies before applying it.
// Pure data, no three.js. Callers handle `blocked` by waiting or cancelling, never by teleporting.

import { hash } from './layout'
import { clearWalk, walkCost, cellPos, freeCells, headingOf, isFree, route, routesFrom, type Grid, type P, type Walker } from './walk'

export interface Avoider extends Walker {
  /** Seconds without getting any nearer the next point on the way. */
  stuck: number
  /** The point on the way being made for, and the nearest got to it so far. */
  aim: P | null
  best: number
  /** Progress watchdog across route changes and yielding. */
  progress: P | null
  idle: number
  /** Already tried another route on this walk. */
  rerouted: boolean
  /** Fixed priority for an encounter: retreat, wait for this person, then resume. */
  yielding: { to: Avoider; resume: P[]; time: number; limit: number } | null
  /** Keep the same passing side for this encounter instead of dancing left and right. */
  passing: { other: Avoider; side: number } | null
  /** Can't get where they are going, or stand where they are, for others: for the caller to sort out, and clear. */
  blocked: boolean
}

/** Nothing in the way yet, for a new `Avoider`. */
export const UNHINDERED = { stuck: 0, aim: null, best: 0, progress: null, idle: 0, rerouted: false, yielding: null, passing: null, blocked: false } as const

/** Bound the cost of an incidental detour; otherwise wait or cancel. */
const DETOUR = 3

/** Getting no nearer for this long, someone is held up. */
export const STUCK = 1.2
const YIELD_WAIT = 5
const NO_PROGRESS = 7
/** Body diameter / comfort distance. Office: 0.64 / 0.8; island: both scaled by 1.5.
 * Covers the 0.6-wide arms and 0.13 depth in Figure, independent of facing; not extended gestures/accessories. */
export const BODY_SHARE = 0.8
/** Getting nearer by less than this share of the gap doesn't count. */
const PROGRESS = 0.4
/** Two this much closer than the gap are on top of each other. */
const ON_TOP = 0.6
/** How far ahead someone looks for others in the way, in seconds of walking. */
const LOOK = 0.6
/** How quickly two too close are eased apart, per second. */
const EASE = 6
/** How fast someone steps aside, as a share of their walking speed. */
const SIDESTEP = 0.8

const cellOf = (g: Grid, x: number, z: number): P => [Math.round((x - g.x0) / g.step), Math.round((z - g.z0) / g.step)]

/** Whether someone at `from` can be moved to `to`: onto free ground, or within the cell they are in (a doorway, the beach, a seat's approach). */
export function canStand(g: Grid, from: P, to: P) {
  const [cx, cz] = cellOf(g, ...to)
  if (isFree(g, cx, cz)) return true
  const [fx, fz] = cellOf(g, ...from)
  return cx === fx && cz === fz
}

/**
 * Whether someone else (of those `counts` takes in) is within `gap` of `at`: standing there (or stopped there for a
 * moment, part way), or on their way there.
 */
export function spotTaken<T extends Walker>(people: readonly T[], self: T, at: P, gap: number, counts: (q: T) => boolean) {
  const near = (x: number, z: number) => Math.hypot(x - at[0], z - at[1]) < gap
  return people.some((q) => {
    if (q === self || !counts(q)) return false
    const end = q.route.at(-1)
    return near(q.x, q.z) || (!!end && near(...end))
  })
}

/** A spot from `pick` that nobody else has, trying a few; null when every one tried is taken. */
export function openSpot<T extends Walker>(pick: () => P, people: readonly T[], self: T, gap: number, counts: (q: T) => boolean, tries = 6): P | null {
  for (let k = 0; k < tries; k++) {
    const at = pick()
    if (!spotTaken(people, self, at, gap, counts)) return at
  }
  return null
}

/** Keeps count of how long `me` has got no nearer their next point, and returns it. */
function held(me: Avoider, gap: number, dt: number) {
  const aim = me.route[0]
  const d = Math.hypot(aim[0] - me.x, aim[1] - me.z)
  if (me.aim !== aim) {
    // a new point to make for: start counting again
    me.aim = aim
    me.best = d
    me.stuck = 0
  } else if (d < me.best - gap * PROGRESS) {
    me.best = d
    me.stuck = 0
  } else me.stuck += dt
  return me.stuck
}

/** Which way someone is walking, as a unit vector; [0, 0] standing. */
function wayOf(q: Walker): P {
  const to = q.route.find((p) => Math.hypot(p[0] - q.x, p[1] - q.z) > 1e-6)
  if (!to) return [0, 0]
  const d = Math.hypot(to[0] - q.x, to[1] - q.z)
  return [(to[0] - q.x) / d, (to[1] - q.z) / d]
}

const starts = new WeakMap<Walker, P>()
/** Call once before the simulation step, including stationary bodies. Later movers cannot cross an earlier
 * body's swept path. ponytail: pairwise checks suit tens of people; use a spatial index only if profiling warrants it. */
export function beginAvoidance(people: readonly Walker[]) {
  for (const p of people) starts.set(p, [p.x, p.z])
}

/** Fraction of a straight move possible before touching any body. Existing overlaps may only move apart. */
function safeFraction<T extends Walker>(people: readonly T[], me: T, dx: number, dz: number, diameter: number, solid: (q: T) => boolean, origin: P = [me.x, me.z]) {
  const length2 = dx * dx + dz * dz
  if (length2 < 1e-16) return 1
  let fraction = 1
  for (const q of people) {
    if (q === me || !solid(q)) continue
    const start = starts.get(q) ?? [q.x, q.z]
    // Moving disk against a capsule: circles at both ends, and the strip between them.
    const ex = q.x - start[0], ez = q.z - start[1]
    const length = Math.hypot(ex, ez)
    const points: P[] = [[q.x, q.z], start]
    for (const [x, z] of points) {
      const rx = origin[0] - x, rz = origin[1] - z
      const dot = rx * dx + rz * dz
      if (dot >= 0) continue
      const c = rx * rx + rz * rz - diameter * diameter
      if (c <= 0) return 0
      const discriminant = dot * dot - length2 * c
      if (discriminant < 0) continue
      fraction = Math.min(fraction, Math.max(0, (-dot - Math.sqrt(discriminant)) / length2 - 1e-7))
    }
    if (length > 1e-8) {
      const ux = ex / length, uz = ez / length
      const rx = origin[0] - start[0], rz = origin[1] - start[1]
      const across = rx * -uz + rz * ux, velocity = dx * -uz + dz * ux
      if (across * velocity < 0) {
        const t = (Math.sign(across) * diameter - across) / velocity
        const along = (rx + dx * t) * ux + (rz + dz * t) * uz
        if (t >= 0 && along >= 0 && along <= length) fraction = Math.min(fraction, Math.max(0, t - 1e-7))
      }
    }
  }
  return fraction
}

/** Ad hoc steps may not cut through furniture; explicit routes include seat/door/beach approaches. */
function floorClear(g: Grid, from: P, to: P) {
  const n = Math.max(1, Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) / (g.step * 0.2)))
  for (let i = 1; i <= n; i++) {
    if (!canStand(g, from, [from[0] + (to[0] - from[0]) * i / n, from[1] + (to[1] - from[1]) * i / n])) return false
  }
  return true
}

/** Move along one segment per step, so interpolating the rendered position also stays outside bodies.
 * `past` skips comfort steering only; even a conversation partner remains a solid body. */
export function walkAround<T extends Avoider>(people: readonly T[], me: T, g: Grid, dist: number, dt: number, gap: number, solid: (q: T) => boolean, past: T | null = null): number {
  if (dt <= 0 || dist <= 0) return 0
  if (!me.progress || Math.hypot(me.x - me.progress[0], me.z - me.progress[1]) > gap) {
    me.progress = [me.x, me.z]
    me.idle = 0
  } else if ((me.idle += dt) > NO_PROGRESS) {
    me.yielding = null
    me.blocked = true
    return 0
  }
  while (me.route.length && Math.hypot(me.route[0][0] - me.x, me.route[0][1] - me.z) < 1e-6) me.route.shift()
  if (me.yielding) {
    const encounter = me.yielding
    encounter.time += dt
    const other = encounter.to
    const [ox, oz] = wayOf(other)
    const gone = !people.includes(other as T) || !solid(other as T) ||
      (!other.route.length && Math.hypot(other.x - me.x, other.z - me.z) >= gap) ||
      (Math.hypot(other.x - me.x, other.z - me.z) > gap * 1.2 && (me.x - other.x) * ox + (me.z - other.z) * oz <= 0)
    if (gone) {
      // Rejoin through the floor, not by a straight line through the wall beside the pullout.
      me.route = encounter.resume.length ? [...route(g, [me.x, me.z], encounter.resume[0]), ...encounter.resume] : []
      me.yielding = null
      me.aim = null
    } else if (encounter.time > encounter.limit) {
      me.yielding = null
      me.blocked = true
      return 0
    } else if (!me.route.length) return 0
  }
  if (!me.route.length || me.blocked) return 0
  if (!me.yielding && held(me, gap, dt) > STUCK) giveWay(people, me, g, gap, solid, past)
  if (me.blocked) return 0
  const [dx, dz] = wayOf(me)
  const [sx, sz] = [-dz, dx]
  const target = me.route[0]
  if (!target) return 0
  const distance = Math.hypot(target[0] - me.x, target[1] - me.z)
  let mx = dx * Math.min(dist, distance), mz = dz * Math.min(dist, distance)
  const look = gap + (dist / dt) * LOOK
  let near: T | null = null, along = Infinity, side = 0
  for (const q of people) {
    if (q === me || q === past || !solid(q)) continue
    const rx = q.x - me.x, rz = q.z - me.z
    const ahead = rx * dx + rz * dz, across = rx * sx + rz * sz
    if (ahead <= 0 || ahead > look || Math.abs(across) >= gap || ahead >= along) continue
    // Someone beyond this waypoint is not a reason to sidestep away from a reachable waypoint forever.
    if (ahead - Math.sqrt(Math.max(0, gap * gap - across * across)) > distance) continue
    near = q; along = ahead; side = across
  }
  if (near && !me.yielding) {
    const [qx, qz] = wayOf(near)
    if (qx * dx + qz * dz <= 0.5) {
      if (me.passing?.other !== near) me.passing = { other: near, side: side > 0 ? -1 : 1 }
      const sign = me.passing.side
      const step = Math.min(dist, distance) * SIDESTEP
      const tx = mx + sx * sign * step, tz = mz + sz * sign * step
      if (floorClear(g, [me.x, me.z], [me.x + tx, me.z + tz])) { mx = tx; mz = tz }
    } else {
      me.passing = null
      const slow = Math.min(1, Math.max(0, (along - gap) / gap))
      mx *= slow; mz *= slow
    }
  } else me.passing = null
  const fraction = safeFraction(people, me, mx, mz, gap * BODY_SHARE, solid)
  me.x += mx * fraction
  me.z += mz * fraction
  if (fraction > 0) me.heading = headingOf(mx, mz)
  if (Math.hypot(target[0] - me.x, target[1] - me.z) < 1e-6) me.route.shift()
  return Math.hypot(mx, mz) * fraction
}

/** Try a nearby pullout outside the winner's route, reached without crossing any occupied body. */
function retreat<T extends Avoider>(people: readonly T[], loser: T, winner: T, g: Grid, gap: number, solid: (q: T) => boolean) {
  const diameter = gap * BODY_SHARE
  const legs: P[] = [[winner.x, winner.z], ...winner.route]
  const candidates = freeCells(g).map(([x, z]) => cellPos(g, x, z)).filter((p) => {
    const d = Math.hypot(p[0] - loser.x, p[1] - loser.z)
    return d > gap && d < gap * 6 && !spotTaken(people, loser, p, gap, solid) &&
      legs.slice(1).every((b, i) => fromLeg(legs[i], b, p) >= gap)
  }).sort((a, b) => Math.hypot(a[0] - loser.x, a[1] - loser.z) - Math.hypot(b[0] - loser.x, b[1] - loser.z))
  const from = routesFrom(g, [loser.x, loser.z])
  for (const at of candidates.slice(0, 24)) {
    const way = from(at)
    if (!way.length) continue
    // The nearest cell centre can be closer to the blocker than our current position.
    // Join the next route point directly when the floor is clear, rather than stepping back into them.
    while (way.length > 1 && floorClear(g, [loser.x, loser.z], way[1]) &&
      people.every((q) => q === loser || !solid(q) || fromLeg([loser.x, loser.z], way[1], [q.x, q.z]) >= diameter)) way.shift()
    const steps: P[] = [[loser.x, loser.z], ...way]
    if (steps.slice(1).some((b, i) => people.some((q) => q !== loser && solid(q) && fromLeg(steps[i], b, [q.x, q.z]) < diameter))) continue
    loser.yielding = { to: winner, resume: loser.route, time: 0, limit: YIELD_WAIT }
    loser.route = way
    loser.aim = null
    loser.blocked = false
    return true
  }
  return false
}

function giveWay<T extends Avoider>(people: readonly T[], me: T, g: Grid, gap: number, solid: (q: T) => boolean, past: T | null) {
  me.stuck = 0
  me.aim = null
  const end = me.route.at(-1)!
  let nearest: T | null = null, nearestD = Infinity
  for (const q of people) {
    if (q === me || q === past || !solid(q)) continue
    const d = Math.hypot(q.x - me.x, q.z - me.z)
    if (d < nearestD) { nearest = q; nearestD = d }
    if (!q.route.length && Math.hypot(q.x - end[0], q.z - end[1]) < gap * BODY_SHARE) {
      me.blocked = true
      return
    }
  }
  if (nearest?.yielding?.to === me) return // do not swap priority while the other retreats
  const way = me.rerouted || !nearest || nearestD > gap * 2 ? [] : detour(g, me, nearest, gap)
  if (way.length) {
    me.route = [...way, ...me.route]
    me.rerouted = true
    return
  }
  if (nearest && nearestD < gap * 2 && nearest.route.length && !nearest.yielding) {
    // Stable list order breaks symmetry; a yielding person keeps their original route until the encounter ends.
    const loser = people.indexOf(me) > people.indexOf(nearest) ? me : nearest
    const winner = loser === me ? nearest : me
    if (retreat(people, loser, winner, g, gap, solid)) return
  }
  me.blocked = true
}

/**
 * Another way to `me`'s next point, round the cells `them` stands on: none when there isn't one, or it is a long way
 * round. A path finding on the walking grid, once each time someone is held up.
 */
export function detour(g: Grid, me: Walker, them: Walker, gap: number): P[] {
  const to = me.route[0]
  if (!to) return []
  const free = g.free.slice()
  const [mx, mz] = cellOf(g, me.x, me.z)
  const [bx, bz] = cellOf(g, them.x, them.z)
  const r = Math.max(0, Math.ceil(gap / g.step) - 1)
  for (let z = bz - r; z <= bz + r; z++) for (let x = bx - r; x <= bx + r; x++) {
    if (x < 0 || z < 0 || x >= g.cols || z >= g.rows || (x === mx && z === mz)) continue
    free[z * g.cols + x] = 0
  }
  const way = route({ ...g, free }, [me.x, me.z], to)
  if (!way.length) return []
  // the way found ends at the free cell nearest the point, which may be short of it, or next to the one in the way
  const end = way[way.length - 1]
  if (Math.hypot(end[0] - to[0], end[1] - to[1]) > g.step) return []
  const legs: P[] = [[me.x, me.z], ...way]
  let long = 0
  for (let i = 1; i < legs.length; i++) {
    // a cell can be bigger than a person: a way through the cell they share with us is no way round them
    if (fromLeg(legs[i - 1], legs[i], [them.x, them.z]) < gap * BODY_SHARE) return []
    long += Math.hypot(legs[i][0] - legs[i - 1][0], legs[i][1] - legs[i - 1][1])
  }
  return long > Math.hypot(to[0] - me.x, to[1] - me.z) * DETOUR + g.step * 2 ? [] : way
}

/** How far `p` is from the straight walk from `a` to `b`. */
function fromLeg(a: P, b: P, p: P) {
  const [ux, uz] = [b[0] - a[0], b[1] - a[1]]
  const len = ux * ux + uz * uz
  const t = len ? Math.min(1, Math.max(0, ((p[0] - a[0]) * ux + (p[1] - a[1]) * uz) / len)) : 0
  return Math.hypot(a[0] + ux * t - p[0], a[1] + uz * t - p[1])
}

/**
 * Eases apart, over `dt` seconds, any two of those `solid` takes in who are closer than `gap`, each only onto ground
 * they can stand on; `moved` hears how far each was moved, for their steps. Call it once a step, after everyone has walked.
 */
export function separate<T extends Avoider>(people: readonly T[], g: Grid, gap: number, dt: number, solid: (q: T) => boolean, moved?: (q: T, d: number) => void, movable: (q: T) => boolean = solid) {
  for (const q of people) {
    if (q.route.length || q.yielding) continue
    q.passing = null
    q.stuck = 0
    q.progress = null
    q.idle = 0
    q.aim = null
    q.rerouted = false
  }
  const k = Math.min(1, dt * EASE)
  if (k <= 0) return
  const shift = (q: T, x: number, z: number) => {
    if (!movable(q)) return false
    const to: P = [q.x + x, q.z + z]
    if (!floorClear(g, [q.x, q.z], to)) return false
    const fraction = safeFraction(people, q, x, z, gap * BODY_SHARE, solid)
    const start = starts.get(q)
    if (start && safeFraction(people, q, q.x + x * fraction - start[0], q.z + z * fraction - start[1], gap * BODY_SHARE, solid, start) < 1 - 1e-8) return false
    q.x += x * fraction
    q.z += z * fraction
    moved?.(q, Math.hypot(x, z) * fraction)
    return fraction > 1e-6
  }
  for (let i = 0; i < people.length; i++) {
    const a = people[i]
    if (!solid(a)) continue
    for (let j = i + 1; j < people.length; j++) {
      const b = people[j]
      if (!solid(b)) continue
      const rx = b.x - a.x
      const rz = b.z - a.z
      const d = Math.hypot(rx, rz)
      if (d >= gap) continue
      // right on top of each other: apart across the screen (along x - z), so neither hides the other
      const [ux, uz] = d > 1e-6 ? [rx / d, rz / d] : [Math.SQRT1_2, -Math.SQRT1_2]
      const push = (gap - d) * k
      // half each; whoever can't move leaves it all to the other
      const aMoved = shift(a, (-ux * push) / 2, (-uz * push) / 2)
      const bMoved = shift(b, (ux * push) / (aMoved ? 2 : 1), (uz * push) / (aMoved ? 2 : 1))
      if (!bMoved && aMoved) shift(a, (-ux * push) / 2, (-uz * push) / 2)
      // on top of each other with nowhere to go: one of them has to move off, preferably one on the way somewhere
      if (!aMoved && !bMoved && d < gap * ON_TOP) (a.route.length && !b.route.length ? a : b).blocked = true
    }
  }
}


/** Plan once on departure. Crowd cost is soft: an occupied corridor stays reachable, but not preferred.
 * ponytail: tens of people, a small grid and one snapshot per departure; no per-frame repathing. */
export function walkingRoute<T extends Walker>(g: Grid, from: P, to: P, people: readonly T[], me: T, gap: number, solid: (q: T) => boolean, seed: number, stroll: boolean): P[] {
  const penalties = new Float64Array(g.free.length)
  const radius = gap * 2
  for (const q of people) {
    if (q === me || !solid(q)) continue
    const [cx, cz] = cellOf(g, q.x, q.z)
    const r = Math.ceil(radius / g.step)
    for (let z = Math.max(0, cz - r); z <= Math.min(g.rows - 1, cz + r); z++) {
      for (let x = Math.max(0, cx - r); x <= Math.min(g.cols - 1, cx + r); x++) {
        const at = cellPos(g, x, z)
        penalties[z * g.cols + x] += Math.max(0, 1 - Math.hypot(at[0] - q.x, at[1] - q.z) / radius) * 5
      }
    }
  }
  const path = route(g, from, to, penalties)
  if (!stroll || path.length < 2) return path
  const out: P[] = [path[0]]
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i]
    const dx = b[0] - a[0], dz = b[1] - a[1], length = Math.hypot(dx, dz)
    if (length > gap * 4) {
      // A stable, gentle bend, not fresh noise every frame. Never offset a door/seat endpoint.
      const offset = (hash(seed, i, 83) * 2 - 1) * gap
      const mid: P = [(a[0] + b[0]) / 2 - dz / length * offset, (a[1] + b[1]) / 2 + dx / length * offset]
      if (clearWalk(g, a, mid) && clearWalk(g, mid, b) &&
        walkCost(g, a, mid, penalties) + walkCost(g, mid, b, penalties) <= walkCost(g, a, b, penalties) * 1.1) out.push(mid)
    }
    out.push(b)
  }
  return out
}

/** Before moving: ask idle people to vacate the path, and send opposing traffic to a pullout
 * before a straight narrow passage. Callers cancel the idle activity, never a seat or required job. */
export function coordinateTraffic<T extends Avoider>(people: readonly T[], g: Grid, gap: number, solid: (q: T) => boolean, idle: (q: T) => boolean, asked: (q: T) => void) {
  const narrow = (at: P, dx: number, dz: number) => {
    const d = gap * BODY_SHARE
    return !floorClear(g, at, [at[0] - dz * d, at[1] + dx * d]) &&
      !floorClear(g, at, [at[0] + dz * d, at[1] - dx * d])
  }
  for (let i = 0; i < people.length; i++) {
    const a = people[i]
    if (!solid(a) || !a.route.length || a.yielding || a.blocked || idle(a)) continue
    const target = a.route.find((p) => Math.hypot(p[0] - a.x, p[1] - a.z) > 1e-6)
    if (!target) continue
    const [dx, dz] = wayOf(a)
    for (let j = 0; j < people.length; j++) {
      if (a.yielding) break
      const b = people[j]
      if (a === b || !solid(b) || b.yielding || b.blocked) continue
      const along = (b.x - a.x) * dx + (b.z - a.z) * dz
      if (along <= 0 || Math.abs((b.x - a.x) * -dz + (b.z - a.z) * dx) > gap) continue
      if (idle(b) && !b.route.length && along < gap * 3 && fromLeg([a.x, a.z], target, [b.x, b.z]) < gap * BODY_SHARE) {
        // Do not move the person we are explicitly walking up to (e.g. to chat).
        const end = a.route.at(-1)!
        if (Math.hypot(end[0] - b.x, end[1] - b.z) < gap * 1.5) continue
        if (retreat(people, b, a, g, gap, solid)) asked(b)
        continue
      }
      if (j <= i || !b.route.length || along > gap * 12) continue
      const [bx, bz] = wayOf(b)
      if (dx * bx + dz * bz > -0.95 || fromLeg([a.x, a.z], target, [b.x, b.z]) > gap) continue
      let constricted = false
      for (let d = 0; d <= along; d += g.step * 0.5) {
        if (narrow([a.x + dx * d, a.z + dz * d], dx, dz)) { constricted = true; break }
      }
      if (!constricted) continue
      // Whoever is already inside goes first; simultaneous arrivals use stable list order.
      const bInside = narrow([b.x, b.z], bx, bz), aInside = narrow([a.x, a.z], dx, dz)
      const winner = bInside && !aInside ? b : a
      const loser = winner === a ? b : a
      if (retreat(people, loser, winner, g, gap, solid) && loser.yielding) {
        loser.yielding.limit = Math.max(YIELD_WAIT, along * 2 + 3)
      }
    }
  }
}
