import { describe, expect, it } from 'vitest'
import { layoutTown, STAFFING_SPOT } from '../layout'
import { applyPatches, emptyWorld } from './backend'
import { landmarksOf, mockGrowLandmarks, mockLandmarkRoads, PARK_STEPS, staffingSpotOf, STEPS } from './landmarks'
import { LANDMARK_KINDS, type Chat, type Task, type World } from './domain/types'

function world(done: number, teams = 2): World {
  const w = emptyWorld()
  for (let i = 0; i < teams; i++) w.teams[`team-${i}`] = { id: `team-${i}`, name: `T${i}`, createdAt: i } as World['teams'][string]
  for (let i = 0; i < done; i++) w.tasks[`task-${i}`] = { id: `task-${i}`, teamId: 'team-0', stage: 'done' } as Task
  return w
}

describe("the simulator's landmarks", () => {
  it('grow the park at each milestone, never back, clear of the companies the map places', () => {
    const w = world(PARK_STEPS[0] - 1)
    mockGrowLandmarks(w)
    expect(landmarksOf(w)).toEqual([])
    expect(mockLandmarkRoads(w)[0]).toEqual({ kind: 'park', stage: 0, value: PARK_STEPS[0] - 1, steps: [...PARK_STEPS] })

    w.tasks.more = { id: 'more', teamId: 'team-0', stage: 'done' } as Task
    const before = layoutTown(Object.values(w.teams).map((t) => ({ id: t.id, name: t.name, members: 0 }))).lots.map((l) => l.at)
    mockGrowLandmarks(w)
    const [park] = landmarksOf(w)
    expect(park).toMatchObject({ kind: 'park', stage: 1 })
    // the companies stay where they were, beside it
    const after = layoutTown(Object.values(w.teams).map((t) => ({ id: t.id, name: t.name, members: 0 })), false, landmarksOf(w))
    expect(after.lots.map((l) => l.at)).toEqual(before)

    for (let i = 0; i < PARK_STEPS[1]; i++) w.tasks[`x${i}`] = { id: `x${i}`, teamId: 'team-0', stage: 'done' } as Task
    mockGrowLandmarks(w)
    expect(w.landmarks?.park?.stage).toBe(2)
    expect(w.landmarks?.park?.at).toEqual(park.at)
    w.tasks = {}
    mockGrowLandmarks(w)
    expect(w.landmarks?.park?.stage).toBe(2)
  })

  it('grow the others by days in use, chats and companies, each on ground of its own', () => {
    const w = world(0, STEPS.dock[0] - 1)
    expect(mockLandmarkRoads(w).map((r) => r.kind)).toEqual([...LANDMARK_KINDS])
    mockGrowLandmarks(w)
    expect(landmarksOf(w)).toEqual([])
    // a chat a day for a week, the user saying a few things in each
    const day = 86400
    w.now = 10 * day
    for (let i = 0; i < STEPS.pond[0]; i++) {
      w.chats[`chat-${i}`] = { id: `chat-${i}`, messages: [0, 1, 2].map((k) => ({ at: w.now - ((i % 7) * day) - k, from: k ? 'user' : 'ada', text: '' })) } as unknown as Chat
    }
    w.teams.another = { id: 'another', name: 'More', createdAt: 0 } as World['teams'][string]
    const values = Object.fromEntries(mockLandmarkRoads(w).map((r) => [r.kind, r.value]))
    expect(values).toEqual({ park: 0, hill: STEPS.hill[0], pond: STEPS.pond[0], dock: STEPS.dock[0], clock: STEPS.hill[0] })
    mockGrowLandmarks(w)
    const grown = landmarksOf(w)
    expect(grown.map((l) => [l.kind, l.stage])).toEqual([['hill', 1], ['pond', 1], ['dock', 1]])
    expect(new Set(grown.map((l) => `${l.at}`)).size).toBe(grown.length)
    // the pier on the coast, its harbour out to open sea
    const dock = w.landmarks?.dock
    expect(typeof dock?.face).toBe('number')
    const town = layoutTown(Object.values(w.teams).map((t) => ({ id: t.id, name: t.name, members: 0, at: t.plot?.at })), false, grown, staffingSpotOf(w))
    const site = town.sites.find((s) => s.kind === 'dock')!
    expect(site.face).toBe(dock?.face)
    for (const [x, z] of site.sea) expect(town.ground[z * town.cols + x]).toBeNull()
  })

  it('come with the rest of the world from the backend', () => {
    const w = emptyWorld()
    delete w.landmarks
    applyPatches(w, { upserts: [{ kind: 'landmark', id: 'park', data: { kind: 'park', stage: 1, at: [10, -8], createdAt: 3 } }] })
    expect(landmarksOf(w)).toEqual([{ kind: 'park', stage: 1, at: [10, -8] }])
    // a kind this map does not know yet stands nowhere
    applyPatches(w, { upserts: [{ kind: 'landmark', id: 'tower', data: { kind: 'tower', stage: 1, at: [30, -8], createdAt: 4 } }] })
    expect(landmarksOf(w)).toEqual([{ kind: 'park', stage: 1, at: [10, -8] }])
    // one with no ground, or not grown, stands nowhere
    expect(landmarksOf({ landmarks: { park: { kind: 'park', stage: 0, at: [1, 1], createdAt: 0 } } })).toEqual([])
    expect(landmarksOf({})).toEqual([])
  })

  it("say where the staffing agency stands once moved, and where it always has before", () => {
    const w = emptyWorld()
    delete w.places
    expect(staffingSpotOf(w)).toEqual(STAFFING_SPOT)
    applyPatches(w, { upserts: [{ kind: 'place', id: 'staffing', data: { id: 'staffing', at: [40, 2] } }] })
    expect(staffingSpotOf(w)).toEqual([40, 2])
    expect(staffingSpotOf({ places: { staffing: { id: 'staffing', at: [1.5, 2] as never } } })).toEqual(STAFFING_SPOT)
  })
})
