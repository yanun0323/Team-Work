import { describe, expect, it } from 'vitest'
import { litShares } from './Building'
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
