// The waited-on requests under `make dev-mock`, run as the store runs them: on an immer draft of the world.
import { produce } from 'immer'
import { describe, expect, it } from 'vitest'
import { seedWorld } from './data/seed'
import { STAFFING_ID, type World } from './domain/types'
import { teamReplicas } from './model'
import { deleteTeam, fireNow, moveReplica, replaceModel } from './ops'

function store() {
  let w: World = structuredClone(seedWorld('zh'))
  return { act: (fn: (w: World) => void) => { w = produce(w, fn) }, world: () => w }
}

describe('waited-on requests in the simulator', () => {
  it('settles one that hands nothing back, and copies one that hands back part of a draft', async () => {
    const s = store()
    const team = Object.values(s.world().teams)[0]
    const [bo, kai, ivy] = teamReplicas(s.world(), team.id)
    await expect(fireNow(s.act, ivy.id, kai.id)).resolves.toBeUndefined()
    const moved = await moveReplica(s.act, bo.id, STAFFING_ID, kai.id)
    expect(s.world().replicas[moved.id]).toEqual(moved)
  })

  it('moves everyone on a model, in a company or the staffing agency, and says how many', async () => {
    const s = store()
    const team = Object.values(s.world().teams)[0]
    const [bo, kai] = teamReplicas(s.world(), team.id)
    const moved = await moveReplica(s.act, kai.id, STAFFING_ID, bo.id)
    s.act((w) => { for (const id of [bo.id, moved.id]) Object.assign(w.replicas[id], { model: 'gone-model', effort: 'default' }) })
    await expect(replaceModel(s.act, 'gone-model', 'claude-sonnet-5')).resolves.toBe(2)
    expect([s.world().replicas[bo.id].model, s.world().replicas[moved.id].model]).toEqual(['claude-sonnet-5', 'claude-sonnet-5'])
    await expect(replaceModel(s.act, 'gone-model', 'claude-sonnet-5')).resolves.toBe(0)
  })

  it('closes a company keeping those picked, and refuses a bad pick with the API code, changing nothing', async () => {
    const s = store()
    const team = Object.values(s.world().teams)[0]
    const [bo] = teamReplicas(s.world(), team.id)
    const before = s.world()
    await expect(deleteTeam(s.act, team.id, [bo.id, bo.id])).rejects.toMatchObject({ code: 'invalid_request' })
    expect(s.world()).toBe(before)
    await expect(deleteTeam(s.act, team.id, [bo.id])).resolves.toBeUndefined()
    expect(s.world().teams[team.id]).toBeUndefined()
    expect(teamReplicas(s.world(), STAFFING_ID).map((r) => r.name)).toContain(bo.name)
    await expect(deleteTeam(s.act, team.id)).rejects.toMatchObject({ code: 'not_found' })
  })
})
