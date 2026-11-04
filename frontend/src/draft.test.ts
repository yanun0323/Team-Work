import { describe, expect, it } from 'vitest'
import { seedWorld } from './core/data/seed'
import { createTask, createTeam } from './core/domain/sim'
import { flowList, teamReplicas, teamTasks } from './core/model'
import { copyDraft, customFlow, draftFlow, draftStaff, editCustom, lastFlowId, ownerOnEveryStep, unstaffed, useDraft } from './draft'

const fixture = () => {
  const w = seedWorld()
  const t = Object.values(w.tasks).find((x) => x.ownerId && w.workflows[x.workflowId] && x.workflow.nodes.length > 2)!
  t.images = [{ name: 'a.png', url: 'data:image/png;base64,AA' }]
  t.files = [{ name: 'spec.txt', url: 'data:text/plain;base64,aGk=' }]
  return { w, t }
}

describe('copyDraft', () => {
  it('brings along everything the task was written with', () => {
    const { w, t } = fixture()
    const d = copyDraft(w, t.teamId, t)
    expect(d).toMatchObject({ title: t.title, description: t.description, images: t.images, files: t.files, workflowId: t.workflowId, ownerId: t.ownerId, from: t.number })
    for (const n of t.workflow.nodes) expect(d.staff[n.id]).toEqual(n.replicaIds)
    expect(d.taskId).toBeUndefined()
    expect(d.images).not.toBe(t.images)
    expect(d.files).not.toBe(t.files)
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

describe('ownerOnEveryStep', () => {
  it('leaves the owner as the only employee on every step', () => {
    const { w, t } = fixture()
    const d = copyDraft(w, t.teamId, t)
    const applied = { ...d, ...ownerOnEveryStep(w, d) }
    for (const n of w.workflows[t.workflowId].nodes) expect(draftStaff(w, applied, n.id)).toEqual([t.ownerId])
    expect(applied.from).toBeNull()
    expect(unstaffed(w, applied)).toEqual([])
  })

  it('changes nothing without an owner', () => {
    const { w, t } = fixture()
    const d = { ...copyDraft(w, t.teamId, t), ownerId: null }
    expect(ownerOnEveryStep(w, d)).toEqual({})
  })
})

describe('a flow of the task\'s own', () => {
  it('starts as a copy of the blueprint, whose steps keep their ids, or blank', () => {
    const { w, t } = fixture()
    const bp = w.workflows[t.workflowId]
    const own = customFlow(w, bp.id)
    expect(own.id).toBe('')
    expect(own.name).not.toBe(bp.name)
    expect(own.nodes.map((n) => n.id)).toEqual(bp.nodes.map((n) => n.id))
    expect(own.nodes).not.toBe(bp.nodes)
    expect(customFlow(w, '').nodes).toHaveLength(1)
  })

  it('makes a task that names no blueprint, and a copy of that task writes the same flow again', () => {
    const { w, t } = fixture()
    const own = customFlow(w, t.workflowId)
    own.nodes = own.nodes.slice(0, 1)
    own.edges = []
    const id = own.nodes[0].id
    const made = createTask(w, { teamId: t.teamId, title: 'own', description: '', workflowId: t.workflowId, workflow: own, staff: { [id]: [t.ownerId!] } })
    expect(made.workflowId).toBe('')
    expect(made.workflow.nodes.map((n) => n.id)).toEqual([id])
    const d = copyDraft(w, t.teamId, made)
    expect(d.custom?.nodes.map((n) => n.id)).toEqual([id])
    expect(draftFlow(w, d)).toBe(d.custom)
    expect(unstaffed(w, d)).toEqual([])
  })

  it('keeps one employee on a step turned back into work', () => {
    const { w, t } = fixture()
    const own = customFlow(w, t.workflowId)
    const n = own.nodes[0]
    n.kind = 'talk'
    const two = teamReplicas(w, t.teamId).slice(0, 2).map((r) => r.id)
    useDraft.setState({ draft: { ...copyDraft(w, t.teamId, t), workflowId: t.workflowId, custom: own, staff: { [n.id]: two } } })
    editCustom((f) => ({ ...f, nodes: f.nodes.map((x) => (x.id === n.id ? { ...x, kind: 'work' } : x)) }))
    expect(useDraft.getState().draft?.staff[n.id]).toEqual(two.slice(0, 1))
    useDraft.setState({ draft: null })
  })
})
