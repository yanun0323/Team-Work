import { describe, expect, it } from 'vitest'
import { combine } from './rollup'
import {
  cancelTask, fire, changeWorkflow, createTask, createTeam, DEFAULT_MODEL, deleteBlueprint, deleteTask, deleteTeam, gitSources, updateBlueprint, updateSource, deleteWorkflow, duplicateWorkflow, newWorkflow, hire, pauseTask, mergeTask, returnTask,
  MERGE_TIME, RESOLVE_TIME, resolveReview, resumeTask, setOwner, statusOf, subsOf, tick, END_PROMPT, START_PROMPT,
  endTalk, REPLY_TIME, sayInTalk,
} from './sim'
import { composePrompt, validate, wouldCreateCycle } from './graph'
import type { GitSource, Script, World, Workflow, WorkflowNode } from './types'

// No random questions or failures, so each test only sees the events it sets up.
const calm: Partial<Script> = { duration: 10, costRate: 0.001, route: 0, ask: undefined, fail: undefined, sendBack: undefined }

function world(): World {
  const w: World = {
    now: 0, seq: 0, teams: {}, providers: {}, blueprints: {}, replicas: {}, workflows: {}, tasks: {}, subTasks: {},
    nextDriftAt: Infinity, rng: 42, events: [],
  }
  w.blueprints.bp = {
    id: 'bp', name: 'Dev', source: { kind: 'yaml', text: '' }, autoUpdate: false,
    prompt: '', comment: '', skills: [], tools: [],
    look: { skin: '#fff', hair: '#000', shirt: '#00f', pants: '#333', extra: 'none' },
  }
  return w
}

function node(id: string, extra: Partial<WorkflowNode> = {}): WorkflowNode {
  return {
    id, kind: 'work', name: id, prompt: id, replicaIds: [], assignment: 'firstAvailable', handoff: 'all',
    join: 'all', pos: { x: 0, y: 0 }, ...extra,
  }
}

/** Build a team whose default workflow is given as `edges`, each node staffed by its own Replica. */
function setup(edges: [string, string, string?][], nodes: Record<string, Partial<WorkflowNode>> = {}) {
  const w = world()
  const team = createTeam(w, { name: 't', folder: '/tmp/t', targetBranch: 'main', branches: ['main'], initializedGit: false })
  const wf: Workflow = w.workflows[team.defaultWorkflowId]
  // tests draw their own flow, so drop the review the new flow ends with
  const start = wf.nodes[0]
  wf.nodes = [start]
  const ids = new Set(edges.flatMap(([a, b]) => [a, b]))
  ids.delete('start')
  wf.nodes.push(...[...ids].map((id) => node(id, nodes[id])))
  wf.edges = edges.map(([from, to, condition], i) => ({
    id: `e${i}`, from: from === 'start' ? start.id : from, to, condition: condition ?? '',
  }))
  Object.assign(start, nodes.start ?? {})
  for (const n of wf.nodes) if (!n.replicaIds.length) n.replicaIds = [hire(w, team.id, 'bp', n.id).id]
  return { w, team, wf, start }
}

function run(w: World, seconds: number) {
  for (let i = 0; i < seconds * 2; i++) tick(w, 0.5)
}

const nodesDone = (w: World, taskId: string) =>
  subsOf(w, taskId).filter((s) => !s.cancelled && s.status === 'complete').map((s) => w.tasks[taskId].workflow.nodes.find((n) => n.id === s.nodeId)!.name)

describe('createTeam', () => {
  it('starts a new company with empty rules', () => {
    const w = world()
    const team = createTeam(w, { name: 't', folder: '/tmp/t', targetBranch: 'main', branches: ['main'], initializedGit: false })
    expect(team.prompt).toBe('')
  })
})

describe('createTask', () => {
  it('keeps the pictures added with it, and has none otherwise', () => {
    const { w, team } = setup([['start', 'research']])
    const im = { name: 'shot.png', url: 'data:image/png;base64,AA==' }
    const t = createTask(w, { teamId: team.id, title: 'x', description: '', workflowId: team.defaultWorkflowId, images: [im] })
    expect(t.images).toEqual([im])
    const u = createTask(w, { teamId: team.id, title: 'y', description: '', workflowId: team.defaultWorkflowId })
    expect(u.images).toEqual([])
  })
})

describe('rollup', () => {
  it('review floats up, then progressing, then complete', () => {
    expect(combine(['complete', 'review', 'progressing'])).toBe('review')
    expect(combine(['complete', 'todo'])).toBe('progressing')
    expect(combine(['complete', 'complete'])).toBe('complete')
    expect(combine(['todo', 'todo'])).toBe('todo')
  })
})

describe('workflow run', () => {
  it('hands off to every downstream in All mode and then waits to be merged', () => {
    const { w, team } = setup([['start', 'research'], ['research', 'report'], ['research', 'dev']])
    const t = createTask(w, { teamId: team.id, title: 'x', description: '', workflowId: team.defaultWorkflowId, overrides: { '*': calm } })
    run(w, 80)
    expect(nodesDone(w, t.id).sort()).toEqual(['dev', 'report', 'research', '整理需求'].sort())
    expect(t.stage).toBe('awaitMerge')
    expect(statusOf(w, t)).toBe('review')
    mergeTask(w, t.id)
    run(w, MERGE_TIME + 1)
    expect(statusOf(w, t)).toBe('complete')
  })

  it('staffs the task from its own list, leaving the flow as it was', () => {
    const { w, team, wf } = setup([['start', 'dev']])
    const dev = wf.nodes.find((n) => n.name === 'dev')!
    const kim = hire(w, team.id, 'bp', 'kim')
    const t = createTask(w, {
      teamId: team.id, title: 'x', description: '', workflowId: wf.id, overrides: { '*': calm }, staff: { [dev.id]: [kim.id] },
    })
    run(w, 40)
    expect(t.workflow.nodes.find((n) => n.id === dev.id)!.replicaIds).toEqual([kim.id])
    expect(dev.replicaIds).not.toContain(kim.id)
    expect(subsOf(w, t.id).find((s) => s.nodeId === dev.id)?.replicaId).toBe(kim.id)
  })

  it('duplicates a flow under the first free name-N, sharing nothing with it', () => {
    const { w, team, wf } = setup([['start', 'a']])
    wf.name = '修 Bug'
    const one = duplicateWorkflow(w, wf.id)!
    const two = duplicateWorkflow(w, wf.id)!
    expect([one.name, two.name]).toEqual(['修 Bug-1', '修 Bug-2'])
    expect(one.id).not.toBe(wf.id)
    expect(one.nodes).toEqual(wf.nodes)
    one.nodes[1].name = 'changed'
    expect(wf.nodes[1].name).toBe('a')
    expect(w.teams[team.id].defaultWorkflowId).toBe(wf.id)
    // a gap left by a deleted copy is filled first
    deleteWorkflow(w, one.id)
    expect(duplicateWorkflow(w, wf.id)!.name).toBe('修 Bug-1')
  })

  it('deletes a flow but never the last, moving the default on', () => {
    const { w, team } = setup([['start', 'dev']])
    const first = team.defaultWorkflowId
    const t = createTask(w, { teamId: team.id, title: 'x', description: '', workflowId: first, overrides: { '*': calm } })
    deleteWorkflow(w, first)
    expect(w.workflows[first]).toBeDefined()
    const second = newWorkflow(w, 'b')
    deleteWorkflow(w, first)
    expect(w.workflows[first]).toBeUndefined()
    expect(w.teams[team.id].defaultWorkflowId).toBe(second.id)
    run(w, 40)
    expect(w.tasks[t.id].workflow.nodes.length).toBeGreaterThan(0)
  })

  it('deletes a task with its sub-tasks', () => {
    const { w, team } = setup([['start', 'dev']])
    const t = createTask(w, { teamId: team.id, title: 'x', description: '', workflowId: team.defaultWorkflowId, overrides: { '*': calm } })
    run(w, 20)
    deleteTask(w, t.id)
    expect(w.tasks[t.id]).toBeUndefined()
    expect(Object.values(w.subTasks).some((s) => s.taskId === t.id)).toBe(false)
    run(w, 20)
  })

  it('takes only one route in Pick-one mode', () => {
    const { w, team } = setup(
      [['start', 'research'], ['research', 'report', 'only a report'], ['research', 'dev', 'needs code']],
      { research: { handoff: 'pickOne' } },
    )
    const t = createTask(w, { teamId: team.id, title: 'x', description: '', workflowId: team.defaultWorkflowId, overrides: { '*': { ...calm, route: 1 } } })
    run(w, 80)
    expect(nodesDone(w, t.id)).toContain('dev')
    expect(nodesDone(w, t.id)).not.toContain('report')
    expect(t.stage).toBe('awaitMerge')
  })

  it('asks the user when no handoff condition fits', () => {
    const { w, team } = setup(
      [['start', 'research'], ['research', 'report', 'a'], ['research', 'dev', 'b']],
      { research: { handoff: 'pickOne' } },
    )
    const t = createTask(w, {
      teamId: team.id, title: 'x', description: '', workflowId: team.defaultWorkflowId,
      overrides: { '*': calm, research: { ...calm, route: 'unsure' } },
    })
    run(w, 40)
    const research = subsOf(w, t.id).find((s) => s.nodeId === 'research')!
    expect(research.review?.kind).toBe('pickRoute')
    expect(statusOf(w, t)).toBe('review')
    resolveReview(w, research.id, 'report', 'just a report')
    run(w, 40)
    expect(nodesDone(w, t.id)).toContain('report')
    expect(nodesDone(w, t.id)).not.toContain('dev')
    expect(w.replicas[research.replicaId!].memory[0].source).toBe('review')
  })

  it('All-join waits for every upstream and hangs under their common ancestor', () => {
    const { w, team } = setup(
      [['start', 'a'], ['start', 'b'], ['a', 'merge'], ['b', 'merge']],
      { merge: { join: 'all' } },
    )
    const t = createTask(w, {
      teamId: team.id, title: 'x', description: '', workflowId: team.defaultWorkflowId,
      overrides: { '*': calm, b: { ...calm, duration: 40 } },
    })
    run(w, 30)
    const merge = () => subsOf(w, t.id).find((s) => s.nodeId === 'merge')!
    expect(merge().waiting).toBe(true)
    run(w, 60)
    const m = merge()
    expect(m.upstreamIds).toHaveLength(2)
    expect(w.subTasks[m.parentId!].nodeId).toBe(w.tasks[t.id].workflow.nodes[0].id)
    expect(t.stage).toBe('awaitMerge')
  })

  it('Any-join starts on the first arrival and cancels the slower branch', () => {
    const { w, team } = setup(
      [['start', 'a'], ['start', 'b'], ['a', 'merge'], ['b', 'merge']],
      { merge: { join: 'any' } },
    )
    const t = createTask(w, {
      teamId: team.id, title: 'x', description: '', workflowId: team.defaultWorkflowId,
      overrides: { '*': calm, b: { ...calm, duration: 200 } },
    })
    run(w, 60)
    const b = subsOf(w, t.id).find((s) => s.nodeId === 'b')!
    expect(b.cancelled).toBe(true)
    expect(subsOf(w, t.id).filter((s) => s.nodeId === 'merge' && !s.cancelled)).toHaveLength(1)
    expect(t.stage).toBe('awaitMerge')
  })

  it('a Replica works on one sub-task at a time', () => {
    const { w, team, wf } = setup([['start', 'a'], ['start', 'b']])
    const shared = wf.nodes.find((n) => n.id === 'a')!.replicaIds[0]
    wf.nodes.find((n) => n.id === 'b')!.replicaIds = [shared]
    const t = createTask(w, { teamId: team.id, title: 'x', description: '', workflowId: team.defaultWorkflowId, overrides: { '*': calm } })
    for (let i = 0; i < 160; i++) {
      tick(w, 0.5)
      const busy = subsOf(w, t.id).filter((s) => s.status === 'progressing' && s.replicaId === shared)
      expect(busy.length).toBeLessThanOrEqual(1)
    }
    expect(t.stage).toBe('awaitMerge')
  })

  it('Everyone mode runs one sub-task per Replica and hands off once', () => {
    const { w, team, wf } = setup([['start', 'a'], ['a', 'b']])
    const a = wf.nodes.find((n) => n.id === 'a')!
    a.assignment = 'everyone'
    a.replicaIds.push(hire(w, team.id, 'bp', 'a2').id)
    const t = createTask(w, { teamId: team.id, title: 'x', description: '', workflowId: team.defaultWorkflowId, overrides: { '*': calm } })
    run(w, 80)
    expect(subsOf(w, t.id).filter((s) => s.nodeId === 'a')).toHaveLength(2)
    const b = subsOf(w, t.id).filter((s) => s.nodeId === 'b')
    expect(b).toHaveLength(1)
    expect(b[0].upstreamIds).toHaveLength(2)
  })

  it('takes a question answered in words alone, but not other waits', () => {
    const { w, team } = setup([['start', 'a']])
    const t = createTask(w, {
      teamId: team.id, title: 'x', description: '', workflowId: team.defaultWorkflowId,
      overrides: { '*': calm, a: { ...calm, ask: { p: 0.5, prompt: 'Which one?', options: ['A', 'B'] } } },
    })
    run(w, 30)
    const a = subsOf(w, t.id).find((s) => s.nodeId === 'a')!
    expect(a.review?.kind).toBe('question')
    resolveReview(w, a.id, '', '   ')
    expect(a.review).toBeDefined()
    resolveReview(w, a.id, '', 'Neither, use C')
    expect(a.review).toBeUndefined()
    expect(a.log.at(-1)?.text).toBe('Neither, use C')
    expect(w.replicas[a.replicaId!].memory.some((m) => m.text.includes('Neither, use C'))).toBe(true)
    run(w, 30)
    expect(t.stage).toBe('awaitMerge')
  })

  it('retries failures up to the team limit, then asks the user', () => {
    const { w, team } = setup([['start', 'a']])
    team.settings.retries = 1
    const t = createTask(w, {
      teamId: team.id, title: 'x', description: '', workflowId: team.defaultWorkflowId,
      overrides: { '*': calm, a: { ...calm, fail: { p: 0.5, reason: 'error', times: 2 } } },
    })
    run(w, 60)
    const a = subsOf(w, t.id).find((s) => s.nodeId === 'a')!
    expect(a.attempts).toBe(2)
    expect(a.review?.kind).toBe('failed')
    resolveReview(w, a.id, 'skip')
    run(w, 5)
    expect(a.skipped).toBe(true)
    expect(t.stage).toBe('awaitMerge')
  })

  it('stops at the cost limit and continues after adding budget', () => {
    const { w, team } = setup([['start', 'a']])
    team.settings.costLimitUsd = 0.05
    const t = createTask(w, {
      teamId: team.id, title: 'x', description: '', workflowId: team.defaultWorkflowId,
      overrides: { '*': { ...calm, costRate: 0.01 } },
    })
    run(w, 30)
    const review = subsOf(w, t.id).find((s) => s.review)!
    expect(review.review?.kind).toBe('budget')
    resolveReview(w, review.id, 'addBudget')
    team.settings.costLimitUsd = 10
    run(w, 60)
    expect(t.stage).toBe('awaitMerge')
  })

  it('pause keeps progress; cancel and workflow change need a pause first', () => {
    const { w, team } = setup([['start', 'a']])
    const t = createTask(w, { teamId: team.id, title: 'x', description: '', workflowId: team.defaultWorkflowId, overrides: { '*': calm } })
    run(w, 6)
    cancelTask(w, t.id)
    expect(t.stage).toBe('running')
    pauseTask(w, t.id)
    const progress = subsOf(w, t.id)[0].progress
    run(w, 20)
    expect(subsOf(w, t.id)[0].progress).toBe(progress)
    expect(subsOf(w, t.id).every((s) => s.status !== 'progressing')).toBe(true)
    resumeTask(w, t.id)
    run(w, 60)
    expect(t.stage).toBe('awaitMerge')
  })

  it('changing the workflow discards progress and starts over', () => {
    const { w, team } = setup([['start', 'a']])
    const t = createTask(w, { teamId: team.id, title: 'x', description: '', workflowId: team.defaultWorkflowId, overrides: { '*': calm } })
    run(w, 20)
    pauseTask(w, t.id)
    const before = subsOf(w, t.id).length
    expect(before).toBeGreaterThan(1)
    changeWorkflow(w, t.id, team.defaultWorkflowId)
    expect(subsOf(w, t.id)).toHaveLength(1)
    expect(t.costCarry).toBeGreaterThan(0)
    expect(t.paused).toBe(false)
  })

})

describe('work tree and merge', () => {
  it('the owner makes one work tree at 整理需求, and every step commits to it', () => {
    const { w, team } = setup([['start', 'a'], ['a', 'b']])
    const t = createTask(w, { teamId: team.id, title: 'x', description: '', workflowId: team.defaultWorkflowId, overrides: { '*': calm } })
    run(w, 80)
    const subs = subsOf(w, t.id)
    const intake = subs.find((s) => s.nodeId === t.workflow.nodes[0].id)!
    expect(intake.log.some((l) => l.text === `建立 work tree，分支 ${t.branch}（從 main）`)).toBe(true)
    for (const s of subs) expect(s.handoff!.agent.outputs.at(-1)).toMatch(new RegExp(`@ ${t.branch}$`))
  })

  it('a step whose work tree took another commit while it worked takes it in before committing', () => {
    const { w, team } = setup([['start', 'a'], ['start', 'b'], ['a', 'end'], ['b', 'end']])
    const t = createTask(w, {
      teamId: team.id, title: 'x', description: '', workflowId: team.defaultWorkflowId,
      overrides: { '*': calm, a: { ...calm, duration: 6 }, b: { ...calm, duration: 12 } },
    })
    run(w, 80)
    const of = (n: string) => subsOf(w, t.id).find((s) => s.nodeId === n)!
    expect(of('b').log.some((l) => l.text.startsWith('commit 衝突：先合進 a 的 commit'))).toBe(true)
    expect(of('a').log.some((l) => l.text.startsWith('commit 衝突'))).toBe(false)
  })

  it('waits for the user, then the owner merges it into the target branch', () => {
    const { w, team } = setup([['start', 'a']])
    const owner = hire(w, team.id, 'bp', 'Boss').id
    const t = createTask(w, { teamId: team.id, title: 'x', description: '', workflowId: team.defaultWorkflowId, ownerId: owner, overrides: { '*': calm } })
    run(w, 200)
    expect(t.stage).toBe('awaitMerge')
    mergeTask(w, t.id)
    expect(t.stage).toBe('merging')
    expect(t.merge!.replicaId).toBe(owner)
    run(w, MERGE_TIME - 1)
    expect(t.stage).toBe('merging')
    expect(statusOf(w, t)).toBe('progressing')
    run(w, 2)
    expect(t.stage).toBe('done')
    expect(t.merge!.log.at(-1)!.text).toBe('已合併回 main，移除 work tree')
  })

  it('a clash with the target branch: the owner resolves it first, which takes longer', () => {
    const { w, team } = setup([['start', 'a']])
    const t = createTask(w, {
      teamId: team.id, title: 'x', description: '', workflowId: team.defaultWorkflowId, overrides: { '*': calm }, mergeConflict: true,
    })
    run(w, 60)
    mergeTask(w, t.id)
    run(w, MERGE_TIME + 1)
    expect(t.stage).toBe('merging')
    run(w, RESOLVE_TIME)
    expect(t.stage).toBe('done')
    expect(t.merge!.log.map((l) => l.text)).toContain('衝突已解決')
  })

  it('the merge waits until the owner is free of other work', () => {
    const { w, team, wf } = setup([['start', 'a']])
    const owner = wf.nodes[1].replicaIds[0]
    const t = createTask(w, { teamId: team.id, title: 'x', description: '', workflowId: wf.id, ownerId: owner, overrides: { '*': calm } })
    run(w, 60)
    // the owner takes a long step on another task
    const other = createTask(w, {
      teamId: team.id, title: 'y', description: '', workflowId: wf.id, ownerId: owner, overrides: { '*': { ...calm, duration: 40 } },
    })
    run(w, 5)
    expect(subsOf(w, other.id).some((s) => s.status === 'progressing' && s.replicaId === owner)).toBe(true)
    mergeTask(w, t.id)
    run(w, 20)
    expect(t.merge!.startedAt).toBeUndefined()
    run(w, 40)
    expect(t.stage).toBe('done')
  })

  it('sent back with feedback, the steps before 驗收 redo the work and it comes back to be merged', () => {
    const { w, team } = setup([['start', 'a'], ['a', 'end']])
    const t = createTask(w, { teamId: team.id, title: 'x', description: '', workflowId: team.defaultWorkflowId, overrides: { '*': calm } })
    run(w, 80)
    returnTask(w, t.id, '  ')
    expect(t.stage).toBe('awaitMerge')
    returnTask(w, t.id, '按鈕顏色不對')
    expect(t.stage).toBe('running')
    const redo = subsOf(w, t.id).find((s) => s.rework)!
    expect(redo.nodeId).toBe('a')
    expect(redo.rework!.reason).toBe('按鈕顏色不對')
    run(w, 80)
    expect(t.stage).toBe('awaitMerge')
    expect(subsOf(w, t.id).filter((s) => s.nodeId === 'end' && s.status === 'complete')).toHaveLength(2)
  })
})

describe('task owner', () => {
  it('works the first and last steps with fixed instructions, whatever the flow or staff says', () => {
    const { w, team, wf } = setup([['start', 'a'], ['a', 'rev']], { rev: { prompt: 'my own review' } })
    const owner = hire(w, team.id, 'bp', 'Boss').id
    const task = createTask(w, {
      teamId: team.id, title: 't', description: '', workflowId: wf.id, ownerId: owner,
      staff: { [wf.nodes[0].id]: [wf.nodes[1].replicaIds[0]], rev: [wf.nodes[1].replicaIds[0]] }, overrides: { '*': calm },
    })
    const [start, a, rev] = task.workflow.nodes
    expect(task.ownerId).toBe(owner)
    expect(start.replicaIds).toEqual([owner])
    expect(rev.replicaIds).toEqual([owner])
    expect(a.replicaIds).not.toEqual([owner])
    expect(start.prompt).toBe(START_PROMPT)
    expect(rev.prompt).toBe(END_PROMPT)
    // the flow itself is left as it was
    expect(wf.nodes.find((n) => n.id === 'rev')!.prompt).toBe('my own review')
    run(w, 100)
    const who = (nodeId: string) => subsOf(w, task.id).find((s) => s.nodeId === nodeId)!.replicaId
    expect(who(start.id)).toBe(owner)
    expect(who('rev')).toBe(owner)
  })

  it('a new owner takes over both ends', () => {
    const { w, team, wf } = setup([['start', 'rev']])
    const [x, y] = [hire(w, team.id, 'bp', 'X').id, hire(w, team.id, 'bp', 'Y').id]
    const task = createTask(w, { teamId: team.id, title: 't', description: '', workflowId: wf.id, ownerId: x })
    setOwner(task, y)
    expect(task.workflow.nodes.map((n) => n.replicaIds)).toEqual([[y], [y]])
  })

  it('firing hands every unfinished job to the heir, who works them one at a time', () => {
    const { w, team, wf } = setup([['start', 'a'], ['start', 'b'], ['a', 'rev'], ['b', 'rev']])
    const gone = hire(w, team.id, 'bp', 'Gone').id
    const heir = wf.nodes.find((n) => n.id === 'b')!.replicaIds[0]
    const task = createTask(w, {
      teamId: team.id, title: 't', description: '', workflowId: wf.id, ownerId: gone,
      staff: { a: [gone], b: [heir] }, overrides: { '*': { ...calm, duration: 30 } },
    })
    const aOf = () => subsOf(w, task.id).find((s) => s.nodeId === 'a')
    for (let i = 0; i < 200 && !(aOf()?.progress); i++) tick(w, 0.5)
    const a = aOf()!
    expect(a.replicaId).toBe(gone)
    expect(a.status).toBe('progressing')
    const progress = a.progress
    fire(w, gone, heir)
    expect(w.replicas[gone]).toBeUndefined()
    expect(task.ownerId).toBe(heir)
    expect(task.workflow.nodes.every((n) => !n.replicaIds.includes(gone))).toBe(true)
    expect(a.replicaId).toBe(heir)
    expect(a.progress).toBe(progress)
    for (let i = 0; i < 400 && task.stage === 'running'; i++) {
      tick(w, 0.5)
      expect(subsOf(w, task.id).filter((s) => s.status === 'progressing' && s.replicaId === heir).length).toBeLessThanOrEqual(1)
    }
    expect(task.stage).toBe('awaitMerge')
  })

  it('a flow does not need staff on its two ends', () => {
    const { wf } = setup([['start', 'a'], ['a', 'rev']])
    wf.nodes[0].replicaIds = []
    wf.nodes.find((n) => n.id === 'rev')!.replicaIds = []
    expect(validate(wf)).toEqual([])
  })
})

describe('send-backs', () => {
  const names = (w: World, taskId: string, ids: string[]) => ids.map((id) => w.tasks[taskId].workflow.nodes.find((n) => n.id === id)!.name)

  it('a review that does not pass sends every step before it back, then reviews again', () => {
    const { w, team, wf } = setup([['start', 'a'], ['start', 'b'], ['a', 'rev'], ['b', 'rev']])
    const task = createTask(w, {
      teamId: team.id, title: 't', description: '', workflowId: wf.id,
      overrides: { '*': calm, rev: { sendBack: { roll: 0.2, reason: '少了測試' } } },
    })
    run(w, 200)
    const subs = subsOf(w, task.id).filter((s) => !s.cancelled)
    const reviews = subs.filter((s) => s.nodeId === 'rev').sort((x, y) => x.createdAt - y.createdAt)
    expect(reviews).toHaveLength(2)
    expect(names(w, task.id, reviews[0].sentBack!.to).sort()).toEqual(['a', 'b'])
    expect(reviews[0].sentBack!.reason).toBe('少了測試')
    const redo = subs.filter((s) => s.rework)
    expect(redo.map((s) => s.nodeId).sort()).toEqual(['a', 'b'])
    expect(redo.every((s) => s.rework!.from === reviews[0].id && s.status === 'complete')).toBe(true)
    // the second review comes after both redone steps, and passes
    expect(reviews[1].sentBack).toBeUndefined()
    expect(w.tasks[task.id].stage).toBe('awaitMerge')
  })

  it('a step sent back may send it further back, up to two send-backs a task', () => {
    const { w, team, wf } = setup([['start', 'a'], ['a', 'b'], ['b', 'rev']])
    const task = createTask(w, {
      teamId: team.id, title: 't', description: '', workflowId: wf.id,
      overrides: {
        '*': { ...calm, sendBack: { roll: 0, reason: '還是不對' } },
      },
    })
    run(w, 300)
    const subs = subsOf(w, task.id).filter((s) => !s.cancelled)
    const backs = subs.filter((s) => s.sentBack).sort((x, y) => x.createdAt - y.createdAt)
    // the review sends b back, b sends a back; then the cap is reached and the flow runs on to the end
    expect(backs.map((s) => names(w, task.id, [s.nodeId])[0])).toEqual(['rev', 'b'])
    expect(names(w, task.id, backs[1].sentBack!.to)).toEqual(['a'])
    expect(subs.filter((s) => s.nodeId === 'rev')).toHaveLength(2)
    expect(w.tasks[task.id].stage).toBe('awaitMerge')
  })

  it('the first step never sends anything back', () => {
    const { w, team, wf } = setup([['start', 'rev']])
    const task = createTask(w, {
      teamId: team.id, title: 't', description: '', workflowId: wf.id,
      overrides: { '*': { ...calm, sendBack: { roll: 0, reason: 'x' } } },
    })
    run(w, 200)
    const subs = subsOf(w, task.id)
    // rev sends the start back twice (the cap); the start runs again each time and never bounces
    expect(subs.filter((s) => s.sentBack).map((s) => s.nodeId)).toEqual(['rev', 'rev'])
    expect(subs.filter((s) => s.rework).map((s) => s.nodeId)).toEqual([w.tasks[task.id].workflow.nodes[0].id, w.tasks[task.id].workflow.nodes[0].id])
    expect(subs.filter((s) => s.nodeId === 'rev')).toHaveLength(3)
    expect(w.tasks[task.id].stage).toBe('awaitMerge')
  })
})

describe('workflow editing', () => {
  it('rejects cycles, flags missing Replicas and conditions', () => {
    const { wf } = setup([['start', 'a'], ['a', 'b']])
    expect(wouldCreateCycle(wf, 'b', 'a')).toBe(true)
    expect(wouldCreateCycle(wf, 'a', 'b')).toBe(false)
    wf.nodes.find((n) => n.id === 'a')!.handoff = 'pickOne'
    wf.edges.push({ id: 'x', from: 'a', to: 'c', condition: '' })
    wf.nodes.push(node('c'))
    // c is now the last step, which the task's owner works; a middle step with nobody is the problem
    wf.nodes.find((n) => n.id === 'a')!.replicaIds = []
    const kinds = validate(wf).map((i) => i.kind).sort()
    expect(kinds).toEqual(['noCondition', 'noCondition', 'noReplica'])
  })

  it('composes the prompt with the node first, then handoff, then the Replica', () => {
    const { wf } = setup([['start', 'a'], ['a', 'b', 'when done']], { a: { handoff: 'pickOne', prompt: 'do A' } })
    const p = composePrompt(wf, 'a', 'I am dev', ['remember this'])
    expect(p.map((s) => s.key)).toEqual(['system', 'node', 'handoff', 'replica'])
    expect(p[1].body).toBe('do A')
    expect(p[3].body).toContain('remember this')
  })
})

describe('closing a company', () => {
  it('takes its people, tasks and sub-tasks, and leaves the rest, flows too, running', () => {
    const { w, team } = setup([['start', 'a']])
    const other = createTeam(w, { name: 'o', folder: '/tmp/o', targetBranch: 'main', branches: ['main'], initializedGit: false })
    const keep = hire(w, other.id, 'bp', 'Keep')
    createTask(w, { teamId: team.id, title: 'x', description: '', workflowId: team.defaultWorkflowId, overrides: { '*': calm } })
    run(w, 3)
    expect(Object.keys(w.subTasks).length).toBeGreaterThan(0)
    deleteTeam(w, team.id, { removeFiles: false })
    expect(w.teams[team.id]).toBeUndefined()
    expect(Object.values(w.replicas)).toEqual([keep])
    expect(w.workflows[other.defaultWorkflowId]).toBeDefined()
    expect(w.tasks).toEqual({})
    expect(w.subTasks).toEqual({})
    expect(w.blueprints.bp).toBeDefined()
    run(w, 5)
  })
})

describe('blueprint sources', () => {
  const git = (upstream = true): GitSource => ({
    kind: 'git', repo: 'git@github.com:a/b', ref: 'v1.0.0', commit: 'old', latestRef: 'v1.1.0', latest: 'new',
    private: false, upstream,
  })

  it('reads the blueprint repo and every skill repo', () => {
    const w = world()
    const bp = w.blueprints.bp
    bp.source = git()
    bp.skills = [{ source: null, include: ['a'], exclude: [] }, { source: git(), include: null, exclude: [] }, { source: { kind: 'local', path: '~/.agents/' }, include: null, exclude: [] }]
    expect(gitSources(bp)).toEqual([bp.source, bp.skills[1].source])
  })

  it('records a failed update and keeps the version in use when the upstream is gone', () => {
    const w = world()
    const s = git(false)
    updateSource(w, s)
    expect(s.update).toEqual({ at: 0, ok: false, error: '找不到上游' })
    expect([s.ref, s.commit]).toEqual(['v1.0.0', 'old'])
  })

  it('moves to the newest version when an update works, and records every attempt', () => {
    const w = world()
    let worked = 0
    for (let i = 0; i < 40; i++) {
      const s = git()
      w.now = i
      updateSource(w, s)
      expect(s.update?.at).toBe(i)
      if (s.update?.ok) {
        worked++
        expect([s.ref, s.commit]).toEqual(['v1.1.0', 'new'])
      } else {
        expect(s.update?.error).toBeTruthy()
        expect([s.ref, s.commit]).toEqual(['v1.0.0', 'old'])
      }
    }
    // most updates work, some don't
    expect(worked).toBeGreaterThan(20)
    expect(worked).toBeLessThan(40)
  })

  it('updates only sources that are behind or unreachable', () => {
    const w = world()
    const bp = w.blueprints.bp
    const current = { ...git(), commit: 'new', ref: 'v1.1.0' }
    bp.source = current
    bp.skills = [{ source: git(false), include: ['x'], exclude: [] }]
    updateBlueprint(w, 'bp')
    expect(current.update).toBeUndefined()
    expect((bp.skills[0].source as GitSource).update?.ok).toBe(false)
  })
})

describe('deleting a blueprint', () => {
  it('waits until no employee anywhere is made from it', () => {
    const w = world()
    const team = createTeam(w, { name: 'A', folder: '/tmp/a', targetBranch: 'main', branches: ['main'], initializedGit: false })
    const r = hire(w, team.id, 'bp', 'Ann')
    expect(deleteBlueprint(w, 'bp')).toBe(false)
    expect(w.blueprints.bp).toBeDefined()
    delete w.replicas[r.id]
    expect(deleteBlueprint(w, 'bp')).toBe(true)
    expect(w.blueprints.bp).toBeUndefined()
  })

  it('leaves the model to the employee', () => {
    const w = world()
    const team = createTeam(w, { name: 'A', folder: '/tmp/a', targetBranch: 'main', branches: ['main'], initializedGit: false })
    expect(hire(w, team.id, 'bp', 'Ann').model).toBe(DEFAULT_MODEL)
    expect(hire(w, team.id, 'bp', 'Bo', undefined, { model: 'gpt-5.5' }).model).toBe('gpt-5.5')
  })
})

describe('使用者討論', () => {
  /** start → plan → talk → build, the talk step held by its own employee. */
  function talkFlow(extra: Partial<WorkflowNode> = {}, more: [string, string][] = []) {
    const t = setup([['start', 'plan'], ['plan', 'talk'], ['talk', 'build'], ...more], { talk: { kind: 'talk', ...extra } })
    const task = createTask(t.w, { teamId: t.team.id, title: 'x', description: '', workflowId: t.wf.id, overrides: { '*': calm } })
    const at = (node: string) => subsOf(t.w, task.id).filter((s) => s.nodeId === node && !s.cancelled)
    return { ...t, task, at }
  }
  /** Run until the discussion is open, and return it. */
  const opened = (t: ReturnType<typeof talkFlow>) => {
    run(t.w, 40)
    const [sub] = t.at('talk')
    expect(sub.review?.kind).toBe('talk')
    return sub
  }

  it('opens once the employee is ready and waits on the user', () => {
    const t = talkFlow()
    const sub = opened(t)
    expect(sub.talk?.messages.map((m) => m.from)).toEqual(['agent'])
    expect(statusOf(t.w, t.task)).toBe('review')
    // nothing moves on until the user ends it
    run(t.w, 60)
    expect(t.at('build')).toEqual([])
    expect(t.w.subTasks[sub.id].review?.kind).toBe('talk')
  })

  it('has the employee answer each message, one at a time', () => {
    const t = talkFlow()
    const sub = opened(t)
    sayInTalk(t.w, sub.id, '先做基本版')
    // still writing back: the user waits for the answer
    sayInTalk(t.w, sub.id, '再補一句')
    expect(sub.talk?.messages.map((m) => m.from)).toEqual(['agent', 'user'])
    run(t.w, REPLY_TIME)
    expect(sub.talk?.messages.map((m) => m.from)).toEqual(['agent', 'user', 'agent'])
    expect(sub.log.some((l) => l.kind === 'human' && l.text === '先做基本版')).toBe(true)
  })

  it('hands on what was settled when the user goes on', () => {
    const t = talkFlow()
    const sub = opened(t)
    sayInTalk(t.w, sub.id, '先做基本版')
    run(t.w, REPLY_TIME)
    endTalk(t.w, sub.id, { kind: 'continue' })
    expect(sub.status).toBe('complete')
    expect(sub.handoff?.agent.decisions).toEqual(['使用者：先做基本版'])
    expect(t.w.replicas[sub.replicaId!].memory[0].text).toContain('先做基本版')
    run(t.w, 10)
    expect(t.at('build')).toHaveLength(1)
  })

  it('asks which next step to go on to when the step picks one of several', () => {
    const t = talkFlow({ handoff: 'pickOne' }, [['talk', 'docs']])
    const sub = opened(t)
    endTalk(t.w, sub.id, { kind: 'continue' })
    expect(sub.review?.kind).toBe('talk')
    endTalk(t.w, sub.id, { kind: 'continue', to: 'docs' })
    run(t.w, 10)
    expect(t.at('docs')).toHaveLength(1)
    expect(t.at('build')).toEqual([])
  })

  it('sends the work back to the steps before it, with a reason', () => {
    const t = talkFlow()
    const sub = opened(t)
    endTalk(t.w, sub.id, { kind: 'back', reason: '  ' })
    expect(sub.review?.kind).toBe('talk')
    endTalk(t.w, sub.id, { kind: 'back', reason: '規劃少了行動版' })
    expect(sub.sentBack).toEqual({ to: ['plan'], reason: '規劃少了行動版' })
    expect(t.at('plan').filter((s) => s.rework)).toHaveLength(1)
    // the redone plan comes back to a new discussion
    run(t.w, 40)
    expect(t.at('talk').filter((s) => s.review?.kind === 'talk')).toHaveLength(1)
  })

  it('stops the task', () => {
    const t = talkFlow()
    const sub = opened(t)
    endTalk(t.w, sub.id, { kind: 'stop' })
    expect(t.task.stage).toBe('cancelled')
    expect(sub.talk?.ended).toBe('stop')
    sayInTalk(t.w, sub.id, '還在嗎')
    expect(sub.talk?.messages.filter((m) => m.from === 'user')).toEqual([])
  })

  it('is held by one employee even when everyone on the step would work it', () => {
    const t = setup([['start', 'talk'], ['talk', 'build']], { talk: { kind: 'talk', assignment: 'everyone' } })
    const two = [hire(t.w, t.team.id, 'bp', 'a').id, hire(t.w, t.team.id, 'bp', 'b').id]
    t.wf.nodes.find((n) => n.id === 'talk')!.replicaIds = two
    const task = createTask(t.w, { teamId: t.team.id, title: 'x', description: '', workflowId: t.wf.id, overrides: { '*': calm } })
    run(t.w, 40)
    expect(subsOf(t.w, task.id).filter((s) => s.nodeId === 'talk')).toHaveLength(1)
  })
})
