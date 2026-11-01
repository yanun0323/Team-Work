import { describe, expect, it } from 'vitest'
import { ARCH_HALF, ARCH_Z, CUSTOMS_HALF, CUSTOMS_Z, DOOR_Z, DOWN_Z, floorY, HIDDEN_Y, newPassenger, outOfSight, PASSENGERS, passengerLoop, SECURITY_X, stepPassengers, UP_Z } from './AirportInterior'
import { FLOOR_TOP } from './Building'
import { BRIDGE_DX, STANDS, TERMINAL } from './layout'

const loops = Array.from({ length: 10 }, (_, i) => passengerLoop(i))
const legs = (loop: ReturnType<typeof passengerLoop>) => loop.map((s, i) => [s.at, loop[(i + 1) % loop.length].at] as const)
/** Where a leg crosses the line of glass at security, if it does. */
const crossing = ([a, b]: ReadonlyArray<readonly [number, number]>) => {
  if ((a[0] - SECURITY_X) * (b[0] - SECURITY_X) >= 0) return null
  return { z: a[1] + ((SECURITY_X - a[0]) / (b[0] - a[0])) * (b[1] - a[1]), eastward: b[0] > a[0] }
}

describe('passengerLoop', () => {
  it('stays inside the terminal', () => {
    for (const [x, z] of loops.flat().map((s) => s.at)) {
      expect(x).toBeGreaterThan(TERMINAL.x0)
      expect(x).toBeLessThan(TERMINAL.x1)
      expect(z).toBeGreaterThan(TERMINAL.z0)
      expect(z).toBeLessThan(TERMINAL.z1)
    }
  })

  it('crosses the security line once each way: out by the arch, back by customs', () => {
    for (const loop of loops) {
      const cross = legs(loop).map(crossing).filter((c) => c !== null)
      expect(cross).toHaveLength(2)
      for (const c of cross) {
        if (c.eastward) expect(Math.abs(c.z - ARCH_Z)).toBeLessThan(ARCH_HALF)
        else expect(Math.abs(c.z - CUSTOMS_Z)).toBeLessThan(CUSTOMS_HALF)
      }
    }
  })

  it('reaches both gates, and goes out of sight at the door', () => {
    for (const stand of STANDS) {
      expect(loops.some((l) => l.some((s) => Math.abs(s.at[0] - stand - BRIDGE_DX) < 0.5 && s.at[1] === DOOR_Z))).toBe(true)
    }
    for (const loop of loops) expect(loop.some((s) => s.at[1] === DOOR_Z && outOfSight(...s.at))).toBe(true)
  })

  it('comes up one escalator and goes down the other, hidden at the foot', () => {
    for (const loop of loops) {
      expect(loop.some((s) => floorY(...s.at) < HIDDEN_Y)).toBe(true)
      for (const [a, b] of legs(loop)) {
        const [ya, yb] = [floorY(...a), floorY(...b)]
        if (ya < yb) expect(a[1]).toBe(UP_Z)
        if (ya > yb) expect(a[1]).toBe(DOWN_Z)
      }
    }
  })
})

describe('floorY', () => {
  it('is the hall floor off the escalators, and sinks towards the camera along them', () => {
    expect(floorY(-6.6, UP_Z)).toBe(FLOOR_TOP)
    expect(floorY(-2, -16)).toBe(FLOOR_TOP)
    expect(floorY(-3, UP_Z)).toBeLessThan(FLOOR_TOP)
    expect(floorY(0, DOWN_Z)).toBeLessThan(floorY(-3, DOWN_Z))
    expect(floorY(1.2, UP_Z)).toBeLessThan(HIDDEN_Y)
  })
})

describe('stepPassengers', () => {
  const crowd = () => Array.from({ length: PASSENGERS }, (_, i) => newPassenger(i))
  const DT = 0.05
  // a crowded case too: everyone at one desk, as a queue would have to handle
  const sameDesk = () => Array.from({ length: PASSENGERS }, (_, i) => ({ ...newPassenger(i), stops: passengerLoop(i * 3) }))

  for (const [name, make] of [['the usual crowd', crowd], ['everyone at the same desk', sameDesk]] as const) {
    it(`keeps people who are standing apart, and everyone keeps going: ${name}`, () => {
      const people = make()
      const laps = people.map(() => 0)
      for (let t = 0; t < 12000; t++) {
        const before = people.map((p) => p.next)
        stepPassengers(people, DT)
        people.forEach((p, i) => { if (p.next === 0 && before[i] !== 0) laps[i]++ })
        if (t < 400) continue // let the opening positions sort themselves out
        // standing includes anyone held up in a queue
        const still = people.filter((p) => p.moved === 0 && !outOfSight(p.walker.x, p.walker.z))
        for (const a of still) for (const b of still) {
          if (a !== b) expect(Math.hypot(a.walker.x - b.walker.x, a.walker.z - b.walker.z)).toBeGreaterThan(0.6)
        }
      }
      for (const n of laps) expect(n).toBeGreaterThan(2)
    })
  }

  it('makes the second person at a desk wait behind the first', () => {
    const [a, b] = [newPassenger(0), newPassenger(0)]
    a.walker.x = b.walker.x = 0; a.walker.z = -17.4; b.walker.z = -15.9
    a.walker.route = []; a.wait = 100
    b.walker.route = [[0, -17.4]]; b.wait = 0
    for (let t = 0; t < 200; t++) stepPassengers([a, b], DT)
    expect(Math.hypot(a.walker.x - b.walker.x, a.walker.z - b.walker.z)).toBeGreaterThan(1)
    expect(b.walker.route).toHaveLength(1)
  })
})
