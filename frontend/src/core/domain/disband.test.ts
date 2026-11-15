// Closing a company in the simulator, as the backend's DeleteTeam: its own employees picked to keep move to the
// staffing agency as someone new with their own memory; the rest go with it.
import { describe, expect, it } from 'vitest'
import { seedWorld } from '../data/seed'
import { teamReplicas } from '../model'
import * as sim from './sim'
import { STAFFING_ID, type Replica, type World } from './types'

const world = (): World => structuredClone(seedWorld('zh'))

/** A company with three of its own (Bo with settings of his own), a helper from the agency, and a flow they all work on. */
function closing() {
  const w = world()
  const [team, other] = Object.values(w.teams).sort((a, b) => a.createdAt - b.createdAt)
  const shared = Object.values(w.blueprints).find((b) => !b.owner)!
  const own = teamReplicas(w, team.id)
  while (own.length < 3) own.push(sim.hire(w, team.id, shared.id, `Extra${own.length}`, undefined, { model: 'fake', effort: 'default' }))
  const [bo, kai, ivy] = own
  bo.memory = [{ id: 'mem-bo', text: '先寫結論', source: 'user', at: 0 }]
  w.blueprints['bp-bo'] = { ...structuredClone(shared), id: 'bp-bo', owner: bo.id, name: bo.name }
  bo.blueprintId = 'bp-bo'
  const hal = sim.hire(w, STAFFING_ID, shared.id, 'Hal', undefined, { model: 'fake', effort: 'default' })
  hal.memory = [{ id: 'mem-hal', text: '用表格對照', source: 'work', at: 0 }]
  team.memory = [{ id: 'mem-team', text: '用 pnpm', source: 'work', at: 0, by: bo.id }]
  const flow = Object.values(w.workflows)[0]
  flow.nodes[0].replicaIds = [bo.id, kai.id, hal.id]
  const outsider = teamReplicas(w, other.id)[0]
  return { w, team, bo, kai, ivy, hal, flow, outsider }
}

const newcomers = (w: World, before: Replica[]) => teamReplicas(w, STAFFING_ID).filter((r) => !before.some((b) => b.id === r.id))

describe('closing a company with some of its own kept', () => {
  it('moves those picked to the agency as someone new, keeping their own memory and settings', () => {
    const { w, team, bo, kai, ivy, hal, flow } = closing()
    const agency = teamReplicas(w, STAFFING_ID)
    const halBefore = structuredClone(hal)
    const boBefore = structuredClone(bo)
    sim.deleteTeam(w, team.id, [bo.id])
    expect(w.teams[team.id]).toBeUndefined()
    expect(w.replicas[bo.id] ?? w.replicas[kai.id] ?? w.replicas[ivy.id]).toBeUndefined()
    const [moved] = newcomers(w, agency)
    expect(newcomers(w, agency)).toHaveLength(1)
    expect(moved.id).not.toBe(bo.id)
    expect(moved).toMatchObject({ teamId: STAFFING_ID, name: boBefore.name, look: boBefore.look, model: boBefore.model, effort: boBefore.effort, memory: boBefore.memory })
    // settings of his own come along as a copy that is the newcomer's; the old one goes
    expect(moved.blueprintId).not.toBe('bp-bo')
    expect(w.blueprints[moved.blueprintId]).toMatchObject({ owner: moved.id, prompt: w.blueprints[moved.blueprintId].prompt })
    expect(w.blueprints['bp-bo']).toBeUndefined()
    // the helper from the agency is untouched; a shared flow loses who left and does not pick up the newcomer
    expect(w.replicas[hal.id]).toEqual(halBefore)
    expect(flow.nodes[0].replicaIds).toEqual([hal.id])
    expect(Object.values(w.chats).some((c) => c.teamId === team.id)).toBe(false)
    expect(Object.values(w.tasks).some((t) => t.teamId === team.id)).toBe(false)
  })

  it('moves everyone picked, and with nobody picked lets all its own go', () => {
    const all = closing()
    const agency = teamReplicas(all.w, STAFFING_ID)
    sim.deleteTeam(all.w, all.team.id, [all.bo.id, all.kai.id, all.ivy.id])
    expect(newcomers(all.w, agency).map((r) => r.name).sort()).toEqual([all.bo.name, all.kai.name, all.ivy.name].sort())

    const none = closing()
    const before = teamReplicas(none.w, STAFFING_ID)
    sim.deleteTeam(none.w, none.team.id)
    expect(teamReplicas(none.w, STAFFING_ID)).toEqual(before)
    expect(Object.values(none.w.replicas).some((r) => r.teamId === none.team.id)).toBe(false)
    expect(none.w.teams[none.team.id]).toBeUndefined()
  })

  it('refuses a pick that is no one, not its own, or twice, changing nothing', () => {
    const { w, team, bo, hal, outsider } = closing()
    const before = JSON.stringify(w)
    for (const keep of [['nope'], [''], [outsider.id], [hal.id], [bo.id, bo.id], [bo.id, 'nope']]) {
      expect(() => sim.deleteTeam(w, team.id, keep), keep.join()).toThrow(expect.objectContaining({ code: 'invalid_request' }))
      expect(JSON.stringify(w)).toBe(before)
    }
    expect(() => sim.deleteTeam(w, 'no-such-team')).toThrow(expect.objectContaining({ code: 'not_found' }))
    expect(JSON.stringify(w)).toBe(before)
  })
})
