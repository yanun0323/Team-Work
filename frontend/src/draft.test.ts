import { describe, expect, it } from 'vitest'
import { seedWorld } from './core/data/seed'
import { createTask, createTeam } from './core/domain/sim'
import { flowList, teamReplicas, teamTasks } from './core/model'
import { copyDraft, lastFlowId, unstaffed } from './draft'

const fixture = () => {
  const w = seedWorld()
  const t = Object.values(w.tasks).find((x) => x.ownerId && w.workflows[x.workflowId] && x.workflow.nodes.length > 2)!
  t.images = [{ name: 'a.png', url: 'data:image/png;base64,AA' }]
  return { w, t }
}

describe('copyDraft', () => {
  it('brings along everything the task was written with', () => {
    const { w, t } = fixture()
    const d = copyDraft(w, t.teamId, t)
    expect(d).toMatchObject({ title: t.title, description: t.description, images: t.images, workflowId: t.workflowId, ownerId: t.ownerId, from: t.number })
    for (const n of t.workflow.nodes) expect(d.staff[n.id]).toEqual(n.replicaIds)
    expect(d.taskId).toBeUndefined()
    expect(d.images).not.toBe(t.images)
  })

  it('leaves out employees who have left, so the step asks for someone', () => {
    const { w, t } = fixture()
    delete w.replicas[t.ownerId!]
    const d = copyDraft(w, t.teamId, t)
    expect(d.ownerId).toBeNull()
    expect(Object.values(d.staff).flat()).not.toContain(t.ownerId)
    expect(unstaffed(w, d).length).toBeGreaterThan(0)
  })

  it('moves to the last flow chosen when the task\'s flow is gone, keeping the content', () => {
    const { w, t } = fixture()
    const gone = t.workflowId
    delete w.workflows[gone]
    const d = copyDraft(w, t.teamId, t)
    expect(d.workflowId).toBe(lastFlowId(w, t.teamId))
    expect(w.workflows[d.workflowId]).toBeDefined()
    expect(d.title).toBe(t.title)
    expect(d.ownerId).toBe(teamReplicas(w, t.teamId).some((r) => r.id === t.ownerId) ? t.ownerId : null)
  })
})

describe('the flow a new task starts on', () => {
  it('is the one the company last chose, or the first when there is none', () => {
    const { w, t } = fixture()
    const newest = teamTasks(w, t.teamId)[0]
    expect(lastFlowId(w, t.teamId)).toBe(newest.workflowId)
    const other = flowList(w).find((f) => f.id !== newest.workflowId)!
    createTask(w, { teamId: t.teamId, title: 'x', description: '', workflowId: other.id })
    expect(lastFlowId(w, t.teamId)).toBe(other.id)
    const fresh = createTeam(w, { name: 'n', folder: '/n', targetBranch: 'main', branches: ['main'], initializedGit: false })
    expect(lastFlowId(w, fresh.id)).toBe(flowList(w)[0].id)
  })
})
