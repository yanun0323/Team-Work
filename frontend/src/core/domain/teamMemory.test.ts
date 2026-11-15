import { describe, expect, it } from 'vitest'
import { seedWorld } from '../data/seed'
import * as sim from './sim'
import { STAFFING_ID, type World } from './types'

const world = (): World => structuredClone(seedWorld('zh'))
const teams = (w: World) => Object.values(w.teams).sort((a, b) => a.createdAt - b.createdAt)
const shared = (w: World) => sim.hire(w, STAFFING_ID, Object.values(w.blueprints).find((b) => !b.owner)!.id, 'Hal', undefined, { model: 'fake', effort: 'default' })

describe('company memory in the simulator', () => {
  it('starts empty for a new company', () => {
    const w = world()
    const t = sim.createTeam(w, { name: 'x', folder: '~/x', targetBranch: 'main', branches: ['main'], initializedGit: true })
    expect(t.memory).toEqual([])
  })

  it("remembers into the company of the task by default, by whoever wrote it, and once", () => {
    const w = world()
    const [a, b] = teams(w)
    const hal = shared(w)
    const flow = Object.values(w.workflows)[0]
    const task = sim.createTask(w, { teamId: a.id, title: 't', description: '', workflowId: flow.id, images: [], ownerId: hal.id })
    expect(sim.remember(w, hal.id, '用 pnpm', 'work', task.id)).toBe(true)
    expect(sim.remember(w, hal.id, '用 pnpm', 'work', task.id)).toBe(false)
    expect(a.memory.filter((m) => m.text === '用 pnpm')).toEqual([expect.objectContaining({ by: hal.id, taskId: task.id, source: 'work' })])
    expect(b.memory.some((m) => m.text === '用 pnpm')).toBe(false)
    expect(w.replicas[hal.id].memory).toEqual([])
  })

  it('keeps a note of their own with mine, also once', () => {
    const w = world()
    const hal = shared(w)
    expect(sim.remember(w, hal.id, '先寫結論', 'work', undefined, true)).toBe(true)
    expect(sim.remember(w, hal.id, '先寫結論', 'work', undefined, true)).toBe(false)
    expect(w.replicas[hal.id].memory.map((m) => m.text)).toEqual(['先寫結論'])
    expect(w.replicas[hal.id].memory[0].by).toBeUndefined()
  })

  it('lets the user add, correct and remove company notes, a corrected one becoming theirs', () => {
    const w = world()
    const [a] = teams(w)
    const kai = Object.values(w.replicas).find((r) => r.teamId === a.id)!
    sim.remember(w, kai.id, '原本的', 'work')
    const theirs = a.memory.find((m) => m.text === '原本的')!
    expect(theirs.by).toBe(kai.id)
    w.now = 99
    const edited = sim.editTeamMemory(w, a.id, theirs.id, '  改過的  ')
    expect(edited).toEqual({ id: theirs.id, text: '改過的', source: 'user', at: 99 })
    const added = sim.addTeamMemory(w, a.id, '新的')
    expect(added).toMatchObject({ text: '新的', source: 'user' })
    expect(added.by).toBeUndefined()
    expect(a.memory[0].id).toBe(added.id)
    sim.deleteTeamMemory(w, a.id, theirs.id)
    expect(a.memory.some((m) => m.id === theirs.id)).toBe(false)
  })

  it('refuses a blank text, an unknown company or note, changing nothing', () => {
    const w = world()
    const [a] = teams(w)
    const before = JSON.stringify(a.memory)
    expect(() => sim.addTeamMemory(w, a.id, '   ')).toThrow()
    expect(() => sim.addTeamMemory(w, 'nope', 'x')).toThrow()
    expect(() => sim.editTeamMemory(w, a.id, 'nope', 'x')).toThrow()
    expect(() => sim.editTeamMemory(w, a.id, a.memory[0].id, ' ')).toThrow()
    expect(() => sim.deleteTeamMemory(w, a.id, 'nope')).toThrow()
    expect(JSON.stringify(a.memory)).toBe(before)
  })

  it("keeps an employee's company notes when they are let go", () => {
    const w = world()
    const [a] = teams(w)
    const [kai, heir] = Object.values(w.replicas).filter((r) => r.teamId === a.id)
    sim.remember(w, kai.id, '留下來', 'work')
    sim.fire(w, kai.id, heir.id)
    expect(a.memory.find((m) => m.text === '留下來')?.by).toBe(kai.id)
  })
})
