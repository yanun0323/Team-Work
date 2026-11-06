import { describe, expect, it } from 'vitest'
import { billAt, litShares, LOUNGE_SEAT_D, loungeSeats, moneyTosses, NOOK_SEAT_FRONT, nookPlaces, shoutBursts } from './Building'
import { NOOK_D, officePlan } from './office'
import { SHIN_REACH } from './People'
import { SCREEN_RIGHT } from './camera'
import { CELL, RING_CELLS } from './layout'
import { seedWorld } from './core/data/seed'
import { busyReplicas, createAirportChat, createChat, subsOf } from './core/domain/sim'
import { teamBusy, teamReplicas, teamTasks, teamWork } from './core/model'

describe('litShares', () => {
  it('leaves an idle company dark and lights more windows as more people work', () => {
    expect(litShares(0)).toEqual({ windows: 0, lobby: 0 })
    let last = litShares(0)
    for (let n = 1; n <= 10; n++) {
      const now = litShares(n)
      expect(now.windows).toBeGreaterThan(0)
      expect(now.windows).toBeGreaterThanOrEqual(last.windows)
      expect(now.lobby).toBeGreaterThanOrEqual(last.lobby)
      expect(now.windows).toBeLessThanOrEqual(1)
      expect(now.lobby).toBeLessThanOrEqual(1)
      last = now
    }
  })
})

describe('teamBusy', () => {
  it('counts employees on tasks and those writing a chat reply, once each', () => {
    const w = seedWorld()
    const teamId = Object.keys(w.teams)[0]
    const crew = teamReplicas(w, teamId)
    const working = crew.filter((r) => busyReplicas(w).has(r.id)).length
    expect(teamBusy(w, teamId)).toBe(working)
    const idle = crew.find((r) => !busyReplicas(w).has(r.id))!
    const chat = createChat(w, { teamId, replicaId: idle.id, text: 'hi' })
    expect(w.chats[chat.id].replyAt).toBeDefined()
    expect(teamBusy(w, teamId)).toBe(working + 1)
    delete w.chats[chat.id].replyAt
    expect(teamBusy(w, teamId)).toBe(working)
  })
})

describe('teamWork', () => {
  it('counts chats being replied to and tasks with a step running, each task once', () => {
    const w = seedWorld()
    w.chats = {}
    const teamId = Object.keys(w.teams)[0]
    for (const s of Object.values(w.subTasks)) if (s.status === 'progressing') s.status = 'todo'
    for (const t of Object.values(w.tasks)) if (t.stage === 'merging') t.stage = 'done'
    expect(teamWork(w, teamId)).toEqual({ chats: 0, tasks: 0 })
    const task = teamTasks(w, teamId).find((t) => subsOf(w, t.id).length > 0)!
    const subs = subsOf(w, task.id)
    for (const s of subs) s.status = 'progressing'
    expect(teamWork(w, teamId).tasks).toBe(1)
    subs.forEach((s) => (s.cancelled = true))
    expect(teamWork(w, teamId).tasks).toBe(0)
    const chat = createChat(w, { teamId, replicaId: teamReplicas(w, teamId)[0].id, text: 'hi' })
    expect(teamWork(w, teamId)).toEqual({ chats: 1, tasks: 0 })
    delete w.chats[chat.id].replyAt
    expect(teamWork(w, teamId).chats).toBe(0)
  })

  it('counts the airport chats being replied to under the empty company id', () => {
    const w = seedWorld()
    w.chats = {}
    createAirportChat(w, { model: 'm', effort: 'default', text: 'hi' })
    expect(teamWork(w, '').chats).toBe(1)
    expect(teamWork(w, Object.keys(w.teams)[0]).chats).toBe(0)
  })
})

describe('shoutBursts', () => {
  it('puts one fan on each side of the screen, never mirroring each other', () => {
    for (let seed = 0; seed < 20; seed++) {
      const [a, b] = shoutBursts(8, 8, 12, seed)
      expect(a.side).toBe(-b.side)
      expect(a.rays.length).not.toBe(b.rays.length)
      expect(a.at[1]).not.toBe(b.at[1])
      expect(a.beat).not.toBe(b.beat)
    }
  })

  it('stays behind a neighbouring building in front, so it never covers another company', () => {
    // plots may touch, leaving two paved rings between buildings; the neighbour in front of the right corner
    // stands along +x, the one in front of the left corner along +z, and anything nearer the camera than their
    // facing wall covers what is behind it there
    const ring = 2 * RING_CELLS * CELL
    for (const size of [8, 20]) {
      for (let seed = 0; seed < 20; seed++) {
        for (const b of shoutBursts(size, size, 12, seed)) {
          // stroke tips: gap off the corner, the longest stroke, half its rim
          const strokes = 2.2 + Math.max(...b.rays.map((r) => r.len)) + 0.25
          const toss = moneyTosses(size, size, 12, seed).find((t) => t.side === b.side)!
          // bill edges over a toss's life, half a bill wide past each centre
          const bills = Math.max(...toss.bills.flatMap((bill) =>
            Array.from({ length: 17 }, (_, k) => Math.abs(billAt(bill, b.side, k * 0.1)[0]) + 1.55)))
          const reach = Math.max(strokes, bills)
          if (b.side > 0) expect(b.at[0] + reach * SCREEN_RIGHT.x).toBeLessThan(size / 2 + ring)
          else expect(b.at[2] - reach * SCREEN_RIGHT.z).toBeLessThan(size / 2 + ring)
        }
      }
    }
  })
})

describe('moneyTosses', () => {
  it('tosses one side, then the other, each bill out its own side and falling in the end', () => {
    for (let seed = 0; seed < 20; seed++) {
      const [a, b] = moneyTosses(8, 8, 12, seed)
      expect(a.side).toBe(-b.side)
      expect(a.start).toBe(0)
      expect(b.start).toBeGreaterThan(0)
      for (const t of [a, b]) {
        for (const bill of t.bills) {
          const [x, y] = billAt(bill, t.side, 1.5)
          expect(Math.sign(x)).toBe(t.side)
          expect(y).toBeLessThan(billAt(bill, t.side, 0.3)[1])
        }
      }
    }
  })
})

describe('sofa seats', () => {
  // where the backs of a seated person's shins hang, from the wall behind them, along the way they face
  const shins = (at: number) => at + SHIN_REACH

  it('sits people far enough forward on the nook sofa that their legs hang clear of the seat', () => {
    for (const mirror of [false, true]) {
      const plan = { ...officePlan(6, 10 * CELL, CELL), mirror }
      const wall = plan.nook.z - NOOK_D / 2
      for (const s of nookPlaces(plan).sofa) expect(shins(s.at[1] - wall)).toBeGreaterThan(NOOK_SEAT_FRONT)
    }
  })

  it('does the same on both arms of the lounge sofa, mirrored or not', () => {
    const a = { x: 0, z: 0, w: 3.4, d: 3 }
    for (const mirror of [false, true]) {
      const m = mirror ? -1 : 1
      const seats = loungeSeats(a, mirror)
      // the side seats face across the room, the back seats face the front
      for (const s of seats.slice(0, 2)) expect(shins(m * (s.at[0] - a.x) + a.w / 2)).toBeGreaterThan(LOUNGE_SEAT_D)
      for (const s of seats.slice(2)) expect(shins(s.at[1] - a.z + a.d / 2)).toBeGreaterThan(LOUNGE_SEAT_D)
    }
  })
})
