import { describe, expect, it } from 'vitest'
import { seedWorld } from './core/data/seed'
import { teamReplicas } from './core/model'
import { copyDraft, unstaffed } from './draft'

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

  it('moves to the default flow when the task\'s flow is gone, keeping the content', () => {
    const { w, t } = fixture()
    const gone = t.workflowId
    delete w.workflows[gone]
    w.teams[t.teamId].defaultWorkflowId = Object.keys(w.workflows)[0]
    const d = copyDraft(w, t.teamId, t)
    expect(d.workflowId).toBe(w.teams[t.teamId].defaultWorkflowId)
    expect(d.title).toBe(t.title)
    expect(d.ownerId).toBe(teamReplicas(w, t.teamId).some((r) => r.id === t.ownerId) ? t.ownerId : null)
  })
})
