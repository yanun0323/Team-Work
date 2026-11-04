import { describe, expect, it } from 'vitest'
import { billAt, litShares, moneyTosses, shoutBursts } from './Building'
import { SCREEN_RIGHT } from './camera'
import { CELL, RING_CELLS } from './layout'
import { seedWorld } from './core/data/seed'
import { busyReplicas, createChat } from './core/domain/sim'
import { teamBusy, teamReplicas } from './core/model'

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
