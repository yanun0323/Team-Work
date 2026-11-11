import { describe, expect, it } from 'vitest'
import { activityPage, controlOwnerTask, createTask, createTeam, flowEditable, hire, newWorkflow, notStarted, OWNER_TIME, sayToOwner, statusOf, subsOf, taskCost, tick, TaskRefusal, updateTask } from './sim'
import { mergeBlocked, resumeBlock, userQuestions } from './owner'
import type { Task, World, WorkflowNode } from './types'

function setup() {
  const w: World = {
    now: 0, seq: 0, language: 'zh', teams: {}, providers: {}, blueprints: {}, sources: {}, replicas: {}, workflows: {}, tasks: {}, subTasks: {}, chats: {},
    nextDriftAt: Infinity, rng: 7, events: [],
  }
  w.blueprints.bp = { id: 'bp', name: 'Dev', source: { kind: 'yaml', text: '' }, prompt: '', comment: '', skills: [], tools: [], look: { skin: '#fff', hair: '#000', shirt: '#00f', pants: '#333', extra: 'none' } }
  const team = createTeam(w, { name: 't', folder: '/tmp/t', targetBranch: 'main', branches: ['main'], initializedGit: false })
  const owner = hire(w, team.id, 'bp', 'Astra', undefined, { model: 'claude-opus-5' })
  const a = hire(w, team.id, 'bp', 'Kai', undefined, { model: 'gpt-5.5' })
  const b = hire(w, team.id, 'bp', 'Ivy', undefined, { model: 'gemini-3' })
  const wf = newWorkflow(w, 'f')
  const start = wf.nodes[0]
  start.replicaIds = [a.id]
  const next: WorkflowNode = { id: 'next', kind: 'work', name: 'next', prompt: 'build it', replicaIds: [b.id], handoff: 'all', join: 'all', pos: { x: 0, y: 0 } }
  wf.nodes = [start, next]
  wf.edges = [{ id: 'e', from: start.id, to: 'next', condition: '' }]
  const task = createTask(w, { teamId: team.id, title: 't', description: 'd', workflowId: wf.id, ownerId: owner.id, orchestration: 'owner', overrides: { '*': { duration: 4, ask: undefined, fail: undefined, sendBack: undefined } } })
  return { w, task, owner, a, b, start }
}

const versions = (t: Task) => ({ planVersion: t.coordination!.planVersion, controlVersion: t.coordination!.controlVersion })
const run = (w: World, seconds: number) => { for (let i = 0; i < seconds * 2; i++) tick(w, 0.5) }
const said = (w: World, id: string) => activityPage(w, id, { limit: 100 }).items

describe('a task its owner runs', () => {
  it('waits in 待辦 with nothing dispatched until the user starts it', () => {
    const { w, task } = setup()
    expect(notStarted(task)).toBe(true)
    expect(statusOf(w, task)).toBe('todo')
    run(w, 20)
    expect(subsOf(w, task.id)).toEqual([])
  })

  it('is dispatched step by step by the owner, to employees on different models, and only reported done by the owner', () => {
    const { w, task, a, b } = setup()
    controlOwnerTask(w, task.id, { requestId: 'r1', action: 'resume', ...versions(task) })
    expect(task.coordination!.startedAt).toBe(0)
    run(w, 2)
    const first = subsOf(w, task.id)
    expect(first.map((s) => s.replicaId)).toEqual([a.id])
    expect(first[0].instruction).toBeTruthy()
    // finished work waits for the owner: nothing downstream starts on its own
    run(w, 8)
    expect(first[0].ownerReview).toBe('pending')
    expect(subsOf(w, task.id)).toHaveLength(1)
    run(w, OWNER_TIME + 1)
    expect(first[0].ownerReview).toBe('accepted')
    expect(subsOf(w, task.id).map((s) => s.replicaId)).toEqual([a.id, b.id])
    run(w, 20)
    expect(task.stage).toBe('awaitMerge')
    const kinds = said(w, task.id).map((x) => x.key ?? x.kind)
    expect(kinds).toEqual(['started', 'dispatched', 'handoff', 'accepted', 'dispatched', 'handoff', 'accepted', 'completed', 'message'])
    expect(said(w, task.id).find((x) => x.kind === 'handoff')?.name).toBe('Kai')
    // the owner's own thinking counts toward the task's cost
    expect(taskCost(w, task)).toBeGreaterThan(subsOf(w, task.id).reduce((n, s) => n + s.costUsd, 0))
  })

  it('takes a message in, marks it received then applied, and the same request sent again is not posted twice', () => {
    const { w, task } = setup()
    const before = task.coordination!.controlVersion
    const { operation } = sayToOwner(w, task.id, { requestId: 'm1', text: '先做行動版' })
    expect(operation.status).toBe('received')
    expect(task.coordination!.controlVersion).toBe(before + 1)
    expect(sayToOwner(w, task.id, { requestId: 'm1', text: '先做行動版' }).operation.id).toBe(operation.id)
    expect(said(w, task.id).filter((x) => x.from === 'user')).toHaveLength(1)
    run(w, 1)
    expect(task.coordination!.operations[0].status).toBe('processing')
    run(w, OWNER_TIME + 1)
    expect(task.coordination!.operations[0].status).toBe('applied')
    expect(said(w, task.id).at(-1)?.from).toBe('agent')
    expect(() => sayToOwner(w, task.id, { requestId: 'm2', text: '  ' })).toThrow(TaskRefusal)
  })

  it('refuses an action decided on an older view, but lets a pause through', () => {
    const { w, task } = setup()
    const seen = versions(task)
    sayToOwner(w, task.id, { requestId: 'm1', text: 'hi' })
    expect(() => controlOwnerTask(w, task.id, { requestId: 'r1', action: 'resume', ...seen })).toThrow(/變化/)
    expect(controlOwnerTask(w, task.id, { requestId: 'p1', action: 'pause' }).operation.status).toBe('applied')
  })

  it('pauses: stops running steps, confirms it, dispatches nothing new, and talks while paused without resuming', () => {
    const { w, task } = setup()
    controlOwnerTask(w, task.id, { requestId: 'r1', action: 'resume', ...versions(task) })
    run(w, 4)
    const [sub] = subsOf(w, task.id)
    expect(sub.executionState).toBe('running')
    const { operation } = controlOwnerTask(w, task.id, { requestId: 'p1', action: 'pause' })
    expect(operation.status).toBe('processing')
    expect(sub.executionState).toBe('stopping')
    expect(resumeBlock(task, subsOf(w, task.id))).toBe('stopping')
    run(w, 2)
    expect(task.coordination!.operations.find((o) => o.id === operation.id)?.status).toBe('applied')
    expect(sub.executionState).toBe('stopped')
    const progress = sub.progress
    sayToOwner(w, task.id, { requestId: 'm1', text: '暫停中問一下' })
    run(w, 20)
    expect(task.paused).toBe(true)
    expect(sub.progress).toBe(progress)
    expect(subsOf(w, task.id)).toHaveLength(1)
    expect(said(w, task.id).at(-1)?.text).toMatch(/暫停中/)
  })

  it('sends a chosen step back: keeps the run, makes a redo, marks what read it, and stays paused until resumed', () => {
    const { w, task } = setup()
    controlOwnerTask(w, task.id, { requestId: 'r1', action: 'resume', ...versions(task) })
    run(w, 14)
    const [first, second] = subsOf(w, task.id)
    expect(second.upstreamIds).toEqual([first.id])
    controlOwnerTask(w, task.id, { requestId: 'b1', action: 'return', subId: first.id, reason: '漏了邊界', ...versions(task) })
    expect(task.paused).toBe(true)
    expect(first.validity).toBe('superseded')
    expect(second.validity).toBe('needsRevalidation')
    const redo = subsOf(w, task.id).find((s) => s.rework?.from === first.id)!
    expect(redo.id).not.toBe(first.id)
    expect(w.subTasks[first.id]).toBeDefined()
    // sending back the run already replaced is refused
    run(w, 2)
    expect(() => controlOwnerTask(w, task.id, { requestId: 'b2', action: 'return', subId: first.id, reason: 'x', ...versions(task) })).toThrow(TaskRefusal)
    run(w, 10)
    expect(redo.status).toBe('todo')
    controlOwnerTask(w, task.id, { requestId: 'r2', action: 'resume', ...versions(task) })
    run(w, 30)
    expect(redo.ownerReview).toBe('accepted')
    expect(task.stage).toBe('awaitMerge')
  })

  it('keeps several questions for the user, answers each by its id, and blocks merging while one is open', () => {
    const { w, task } = setup()
    const c = task.coordination!
    c.questions.push(
      { id: 'q1', activityId: 'a1', prompt: '可以加入 Theo 嗎？', options: [{ id: 'approve' }, { id: 'reject' }], kind: 'approval', audience: 'user', planVersion: 1, createdAt: 1 },
      { id: 'q2', activityId: 'a2', prompt: '預算', options: [{ id: 'addBudget' }], kind: 'budget', audience: 'user', planVersion: 1, createdAt: 2 },
      { id: 'q3', activityId: 'a3', prompt: '員工問負責人', options: [], kind: 'question', audience: 'owner', planVersion: 1, createdAt: 3 },
    )
    expect(userQuestions(task).map((q) => q.id)).toEqual(['q1', 'q2'])
    expect(statusOf(w, task)).toBe('review')
    expect(resumeBlock(task, [])).toBe('question')
    expect(mergeBlocked(task, [])).toBe(true)
    controlOwnerTask(w, task.id, { requestId: 'a1', action: 'answer', questionId: 'q2', optionId: 'addBudget', ...versions(task) })
    expect(userQuestions(task).map((q) => q.id)).toEqual(['q1'])
    // an owner-audience question cannot be answered from here
    expect(() => controlOwnerTask(w, task.id, { requestId: 'a2', action: 'answer', questionId: 'q3', optionId: 'x', ...versions(task) })).toThrow(TaskRefusal)
  })

  it('merges from the owner\'s card with the user\'s press, which writing again takes away', () => {
    const { w, task } = setup()
    controlOwnerTask(w, task.id, { requestId: 'r1', action: 'resume', ...versions(task) })
    run(w, 40)
    expect(task.stage).toBe('awaitMerge')
    const card = () => ({ id: 'qm', activityId: 'a1', prompt: '要合併這個任務嗎？', options: [{ id: 'merge', label: '合併' }, { id: 'notYet', label: '先不要' }], kind: 'merge' as const, audience: 'user' as const, planVersion: 1, createdAt: 1 })
    task.coordination!.questions.push(card())
    // the card is what merges, not something in the way of merging
    expect(mergeBlocked(task, subsOf(w, task.id))).toBe(false)
    sayToOwner(w, task.id, { requestId: 'm1', text: '等等' })
    expect(task.stage).toBe('running')
    expect(userQuestions(task)).toEqual([])
    run(w, 40)
    expect(task.stage).toBe('awaitMerge')
    task.coordination!.questions.push(card())
    controlOwnerTask(w, task.id, { requestId: 'a1', action: 'answer', questionId: 'qm', optionId: 'merge', ...versions(task) })
    expect(task.stage).toBe('merging')
    expect(said(w, task.id).at(-1)).toMatchObject({ from: 'user', text: '合併', questionId: 'qm' })
  })

  it('reads its conversation in pages, oldest first, and refuses a page of an older version', () => {
    const { w, task } = setup()
    for (let i = 0; i < 5; i++) sayToOwner(w, task.id, { requestId: `m${i}`, text: `m${i}` })
    const last = activityPage(w, task.id, { limit: 2 })
    expect(last.items.map((x) => x.seq)).toEqual([4, 5])
    expect(last.hasMore).toBe(true)
    const before = activityPage(w, task.id, { before: 4, limit: 2, version: last.version })
    expect(before.items.map((x) => x.seq)).toEqual([2, 3])
    sayToOwner(w, task.id, { requestId: 'm9', text: 'new' })
    expect(() => activityPage(w, task.id, { before: 2, version: last.version })).toThrow(TaskRefusal)
  })
})

describe('the user changing the flow of a task its owner runs', () => {
  const edit = (task: Task, change: (wf: Task['workflow']) => void = () => {}) => {
    const workflow = structuredClone(task.workflow)
    change(workflow)
    return { title: task.title, description: task.description, staff: {}, ownerId: task.ownerId, workflow }
  }
  const docs = (staff: string): WorkflowNode => ({ id: 'docs', kind: 'work', name: '文件', prompt: 'write docs', replicaIds: [staff], handoff: 'all', join: 'all', pos: { x: 2, y: 0 } })

  it('takes a new step, lists what changed, names the flow apart from the blueprint and leaves the blueprint alone', () => {
    const { w, task, a } = setup()
    const blueprint = structuredClone(w.workflows[task.workflowId])
    const name = task.workflow.name
    updateTask(w, task.id, { ...edit(task, (wf) => {
      wf.nodes.push(docs(a.id))
      wf.edges.push({ id: 'e2', from: 'next', to: 'docs', condition: '' })
      wf.nodes[1].prompt = 'build it well'
    }), planVersion: 1 })
    expect(task.workflow.nodes.map((n) => n.id)).toContain('docs')
    expect(task.coordination!.planVersion).toBe(2)
    expect(task.workflowId).toBe('')
    expect(task.workflow.name).toBe(`${name}（自訂）`)
    expect(w.workflows[blueprint.id]).toEqual(blueprint)
    const line = said(w, task.id).at(-1)!
    expect(line.key).toBe('editedByUser')
    expect(line.args).toMatchObject({ added: '文件', changed: 'next', linked: 'next → 文件', removed: '' })
    expect(line.text).toContain('新增依賴：next → 文件')
  })

  it('refuses a broken flow, a step that ran going, or an older view, and changes nothing', () => {
    const { w, task, start } = setup()
    controlOwnerTask(w, task.id, { requestId: 'r1', action: 'resume', ...versions(task) })
    run(w, 2)
    const before = structuredClone(task)
    const refused = (p: Parameters<typeof updateTask>[2], text: string) => {
      expect(() => updateTask(w, task.id, p)).toThrow(text)
      expect(task.workflow).toEqual(before.workflow)
      expect(task.coordination!.planVersion).toBe(before.coordination!.planVersion)
    }
    refused(edit(task, (wf) => wf.edges.push({ id: 'back', from: 'next', to: start.id, condition: '' })), '迴圈')
    refused(edit(task, (wf) => { wf.nodes[1].name = ' ' }), '名稱')
    refused(edit(task, (wf) => { wf.nodes[1].replicaIds = [] }), '沒有指派員工')
    refused(edit(task, (wf) => { wf.nodes[1].replicaIds = [wf.nodes[0].replicaIds[0], wf.nodes[1].replicaIds[0]] }), '只能有一位員工')
    refused(edit(task, (wf) => { wf.nodes = wf.nodes.slice(1); wf.edges = [] }), `已執行過的步驟「${start.name}」不能移除`)
    refused({ ...edit(task, (wf) => { wf.nodes[1].prompt = 'x' }), planVersion: 0 }, '任務已更新')
  })

  it('takes a task waiting to be merged back to work, without its merge card', () => {
    const { w, task, a } = setup()
    controlOwnerTask(w, task.id, { requestId: 'r1', action: 'resume', ...versions(task) })
    run(w, 40)
    expect(task.stage).toBe('awaitMerge')
    task.coordination!.questions.push({ id: 'q-merge', audience: 'user', kind: 'merge', prompt: '合併？', options: [], at: w.now } as never)
    updateTask(w, task.id, edit(task, (wf) => {
      wf.nodes.push(docs(a.id))
      wf.edges.push({ id: 'e2', from: 'next', to: 'docs', condition: '' })
    }))
    expect(task.stage).toBe('running')
    expect(task.coordination!.questions.some((q) => q.kind === 'merge')).toBe(false)
  })

  it('cannot change the flow of an ended task, nor of one run the older way', () => {
    const { w, task } = setup()
    task.stage = 'cancelled'
    expect(() => updateTask(w, task.id, edit(task))).toThrow('不能修改流程')
    expect(flowEditable(task)).toBe(false)
    const old = createTask(w, { teamId: task.teamId, title: 'old', description: '', workflowId: task.workflowId, ownerId: task.ownerId ?? undefined })
    expect(flowEditable(old)).toBe(false)
    expect(() => updateTask(w, old.id, edit(old))).toThrow('舊制任務不能修改流程')
    expect(old.workflow.nodes).toHaveLength(2)
  })

  it('keeps the blueprint when only who works a step changes', () => {
    const { w, task, a } = setup()
    updateTask(w, task.id, edit(task, (wf) => { wf.nodes[1].replicaIds = [a.id] }))
    expect(task.workflowId).not.toBe('')
    expect(said(w, task.id).at(-1)?.args).toMatchObject({ what: 'who works the steps', restaffed: 'next：Ivy → Kai' })
  })
})
