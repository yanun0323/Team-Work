import { describe, expect, it } from 'vitest'
import { activityPage, controlMeeting, controlOwnerTask, createTask, MEETING_BATCH, meetingActivityPage, createTeam, flowEditable, hire, newWorkflow, notStarted, OWNER_TIME, progressOf, sayToOwner, statusOf, subsOf, taskCost, tick, TaskRefusal, updateTask } from './sim'
import { mergeBlocked, resumeBlock, userQuestions } from './owner'
import type { Meeting, Task, World, WorkflowNode } from './types'

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
  it('shows on its card the step at work and how many steps the owner accepted', () => {
    const { w, task, start } = setup()
    expect(progressOf(w, task)).toBeUndefined()
    controlOwnerTask(w, task.id, { requestId: 'r1', action: 'resume', ...versions(task) })
    run(w, 2)
    expect(progressOf(w, task)).toEqual({ now: [start.id], done: 0, total: 2 })
    // handed on but not yet accepted: not done
    run(w, 8)
    expect(progressOf(w, task)).toEqual({ now: [], done: 0, total: 2 })
    run(w, OWNER_TIME + 1)
    expect(progressOf(w, task)).toEqual({ now: ['next'], done: 1, total: 2 })
    // a run a return replaced no longer counts
    subsOf(w, task.id)[0].validity = 'superseded'
    expect(progressOf(w, task)?.done).toBe(0)
    subsOf(w, task.id)[0].validity = 'current'
    run(w, 20)
    expect(task.stage).toBe('awaitMerge')
    expect(progressOf(w, task)).toEqual({ now: [], done: 2, total: 2 })
    task.stage = 'done'
    expect(progressOf(w, task)).toBeUndefined()
  })

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

describe('a meeting held in the conversation of a task its owner runs', () => {
  function meetingSetup() {
    const s = setup()
    const n = s.task.workflow.nodes.find((x) => x.id === 'next')!
    n.kind = 'talk'
    n.name = '規則'
    n.replicaIds = [s.owner.id, s.b.id, s.b.id]
    controlOwnerTask(s.w, s.task.id, { requestId: 'go', action: 'resume', ...versions(s.task) })
    // the first step done and taken in, the meeting is called
    for (let i = 0; i < 200 && !s.task.coordination!.activeMeetingId; i++) tick(s.w, 0.5)
    const sub = s.w.subTasks[s.task.coordination!.activeMeetingId!]
    return { ...s, sub, m: sub.meeting! }
  }
  const mine = (w: World, id: string, m: string) => said(w, id).filter((a) => a.meetingId === m)

  it('is chaired by the owner with one employee or more, the owner not counted twice, and the chair speaks first', () => {
    const { w, task, owner, b, m } = meetingSetup()
    expect(m.version).toBe(2)
    expect(m.chairId).toBe(owner.id)
    expect(m.participants.map((p) => p.replicaId)).toEqual([owner.id, b.id])
    run(w, 6)
    const words = mine(w, task.id, m.id)
    expect(words[0]).toMatchObject({ kind: 'meeting', meetingVersion: 2, meetingPart: 'speech', by: owner.id })
    expect(said(w, task.id).some((a) => a.key === 'meetingCalled' && a.args?.topic === '規則')).toBe(true)
  })

  it('takes the user\'s words only for the meeting under way: those mentioned answer, else the chair', () => {
    const { w, task, owner, b, m } = meetingSetup()
    run(w, 30)
    const before = mine(w, task.id, m.id).length
    expect(() => sayToOwner(w, task.id, { requestId: 'x', text: 'to owner' })).toThrow(TaskRefusal)
    expect(() => sayToOwner(w, task.id, { requestId: 'y', text: 'hi', meetingId: m.id, mentions: ['rep-none'] })).toThrow(TaskRefusal)
    const r = sayToOwner(w, task.id, { requestId: 'z', text: '@Ivy 你呢', meetingId: m.id, mentions: [b.id] })
    expect(r.activity).toMatchObject({ kind: 'meeting', from: 'user', meetingVersion: 2, mentions: [b.id] })
    // sent again, it is not said twice
    expect(sayToOwner(w, task.id, { requestId: 'z', text: '@Ivy 你呢', meetingId: m.id, mentions: [b.id] }).activity.id).toBe(r.activity.id)
    run(w, 5)
    sayToOwner(w, task.id, { requestId: 'q', text: '主持人呢', meetingId: m.id })
    run(w, 5)
    const after = mine(w, task.id, m.id).slice(before)
    expect(after.map((a) => (a.from === 'user' ? 'user' : a.by))).toEqual(['user', b.id, 'user', owner.id])
  })

  // the user asks the chair until the batch of calls is used up
  const useUp = (w: World, task: Task, m: Meeting) => {
    run(w, 30)
    for (let i = 0; m.state === 'open' && i < 3 * MEETING_BATCH; i++) {
      sayToOwner(w, task.id, { requestId: `m${i}`, text: `${i}`, meetingId: m.id })
      run(w, 5)
    }
  }

  it('stops for the user once a batch of model calls is used, and goes on only when told so, on what it showed', () => {
    const { w, task, m } = meetingSetup()
    useUp(w, task, m)
    expect(m.state).toBe('paused')
    expect(m.pauseReason).toBe('limit')
    expect(m.callsInBatch).toBe(MEETING_BATCH)
    expect(said(w, task.id).some((a) => a.key === 'meetingLimitReached' && a.args?.limit === String(MEETING_BATCH))).toBe(true)
    // nothing more is said while it waits
    const n = mine(w, task.id, m.id).length
    run(w, 20)
    expect(mine(w, task.id, m.id).length).toBe(n)
    expect(() => controlMeeting(w, task.id, m.id, { requestId: 'old', action: 'continue', revision: m.revision - 1 })).toThrow(TaskRefusal)
    const op = controlMeeting(w, task.id, m.id, { requestId: 'go', action: 'continue', revision: m.revision }).operation
    expect(op.kind).toBe('meetingContinue')
    // the same request twice is one more batch, not two
    controlMeeting(w, task.id, m.id, { requestId: 'go', action: 'continue', revision: 1 })
    expect([m.batch, m.callsInBatch, m.state]).toEqual([2, 0, 'open'])
  })

  it('goes on with the user\'s words once a batch is used, unless the task is paused', () => {
    const { w, task, owner, m } = meetingSetup()
    useUp(w, task, m)
    expect([m.state, m.pauseReason]).toEqual(['paused', 'limit'])
    sayToOwner(w, task.id, { requestId: 'steer', text: '回到主題', meetingId: m.id })
    expect([m.state, m.batch, m.callsInBatch]).toEqual(['open', 2, 0])
    expect(said(w, task.id).some((a) => a.key === 'meetingContinued' && a.args?.batch === '2')).toBe(true)
    run(w, 5)
    expect(mine(w, task.id, m.id).at(-1)).toMatchObject({ by: owner.id })
    // paused with the task, the words wait
    const other = meetingSetup()
    useUp(other.w, other.task, other.m)
    other.task.paused = true
    sayToOwner(other.w, other.task.id, { requestId: 'wait', text: 'still here', meetingId: other.m.id })
    expect([other.m.state, other.m.batch]).toEqual(['paused', 1])
  })

  it('lets the user call in someone allowed on the task, who joins and answers, and steers past the turns waiting', () => {
    const { w, task, owner, a, b, m } = meetingSetup()
    run(w, 30)
    // the user's words replace who was still due: Ivy, asked first, gives way to Kai
    sayToOwner(w, task.id, { requestId: 'ivy', text: '@Ivy 你呢', meetingId: m.id, mentions: [b.id] })
    const r = sayToOwner(w, task.id, { requestId: 'kai', text: '@Kai 你來說', meetingId: m.id, mentions: [a.id] })
    expect(r.activity.mentions).toEqual([a.id])
    expect(m.participants.map((p) => p.replicaId)).toEqual([owner.id, b.id, a.id])
    expect(said(w, task.id).some((x) => x.key === 'meetingJoined' && x.args?.name === 'Kai' && x.args?.topic === '規則')).toBe(true)
    const before = mine(w, task.id, m.id).length
    run(w, 5)
    expect(mine(w, task.id, m.id).slice(before).map((x) => x.by)).toEqual([a.id])
    // someone not allowed on the task is refused, and nothing changes
    const c = hire(w, task.teamId, 'bp', 'Theo', undefined, { model: 'gpt-5.5' })
    expect(() => sayToOwner(w, task.id, { requestId: 'theo', text: '@Theo', meetingId: m.id, mentions: [c.id] })).toThrow(TaskRefusal)
    expect(m.participants).toHaveLength(3)
  })

  it('keeps only the user\'s latest words: one without @ has the chair answer, even while paused', () => {
    const { w, task, owner, a, b, m } = meetingSetup()
    run(w, 30)
    sayToOwner(w, task.id, { requestId: 'ivy', text: '@Ivy 你呢', meetingId: m.id, mentions: [b.id] })
    sayToOwner(w, task.id, { requestId: 'chair', text: '算了，主持人說', meetingId: m.id })
    const before = mine(w, task.id, m.id).length
    run(w, 5)
    expect(mine(w, task.id, m.id).slice(before).map((x) => x.by)).toEqual([owner.id])
    // paused with the task, the second still replaces the first
    controlOwnerTask(w, task.id, { requestId: 'p', action: 'pause' })
    sayToOwner(w, task.id, { requestId: 'ivy2', text: '@Ivy 你呢', meetingId: m.id, mentions: [b.id] })
    sayToOwner(w, task.id, { requestId: 'kai', text: '@Kai 你來說', meetingId: m.id, mentions: [a.id] })
    run(w, 5)
    expect(m.state).toBe('paused')
    controlOwnerTask(w, task.id, { requestId: 'r', action: 'resume', ...versions(task) })
    controlMeeting(w, task.id, m.id, { requestId: 'again', action: 'continue', revision: m.revision })
    const paused = mine(w, task.id, m.id).length
    run(w, 5)
    expect(mine(w, task.id, m.id).slice(paused).map((x) => x.by)).toEqual([a.id])
  })

  it('does not go on by itself when the task resumes after a pause', () => {
    const { w, task, m } = meetingSetup()
    controlOwnerTask(w, task.id, { requestId: 'p', action: 'pause' })
    expect([m.state, m.pauseReason]).toEqual(['paused', 'taskPaused'])
    run(w, 5)
    controlOwnerTask(w, task.id, { requestId: 'r', action: 'resume', ...versions(task) })
    run(w, 10)
    expect(m.state).toBe('paused')
  })

  it('ends when the user says so with the chair\'s conclusion, one card\'s worth, and the next meeting may open', () => {
    const { w, task, owner, m, sub } = meetingSetup()
    run(w, 10)
    controlMeeting(w, task.id, m.id, { requestId: 'end', action: 'end', revision: m.revision })
    expect(m.state).toBe('closing')
    expect(() => sayToOwner(w, task.id, { requestId: 'late', text: 'late', meetingId: m.id })).toThrow(TaskRefusal)
    expect(() => controlMeeting(w, task.id, m.id, { requestId: 'end2', action: 'end', revision: m.revision })).toThrow(TaskRefusal)
    run(w, 6)
    expect(m.state).toBe('ended')
    expect(task.coordination!.activeMeetingId).toBeUndefined()
    expect(sub.status).toBe('complete')
    const summary = said(w, task.id).find((a) => a.id === m.summaryActivityId)!
    expect(summary).toMatchObject({ meetingPart: 'summary', by: owner.id, text: m.summary })
    expect(said(w, task.id).some((a) => a.key === 'meetingEnded' && a.args?.topic === '規則')).toBe(true)
    expect(task.coordination!.operations.find((o) => o.requestId === 'end')!.status).toBe('applied')
    // its own pages: its words and conclusion alone, oldest first
    const page = meetingActivityPage(w, task.id, m.id, { limit: 2 })
    expect(page.items.map((a) => a.id).at(-1)).toBe(summary.id)
    expect(page.hasMore).toBe(true)
    expect(page.items.every((a) => a.meetingId === m.id)).toBe(true)
    expect(() => meetingActivityPage(w, task.id, m.id, { version: 'stale' })).toThrow(TaskRefusal)
  })
})
