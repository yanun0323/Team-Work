import { describe, expect, it } from 'vitest'
import { seedWorld } from './data/seed'
import { createTask, statusOf } from './domain/sim'
import { STAFFING_ID, type Chat, type Status, type SubTask, type Task } from './domain/types'
import { busyIn, keepsEscape, laneTasks, officePeople, teamReplicas, VISIT } from './model'

describe('laneTasks', () => {
  it('lists open lanes oldest first and 完成 latest first', () => {
    const w = seedWorld()
    const t0 = Object.values(w.tasks).find((t) => w.workflows[t.workflowId])!
    const teamId = t0.teamId
    for (let i = 0; i < 3; i++) createTask(w, { teamId, title: `new ${i}`, description: '', workflowId: t0.workflowId })
    const lanes: Status[] = ['todo', 'progressing', 'review', 'complete']
    for (const status of lanes) {
      const own = Object.values(w.tasks).filter((t) => t.teamId === teamId && t.stage !== 'cancelled' && statusOf(w, t) === status)
      expect(own.length, status).toBeGreaterThan(0)
      // two tasks made at the same moment fall back to their number
      own.forEach((t, i) => { t.createdAt = 1000 + Math.floor(i / 2) })
      const got = laneTasks(w, teamId, status)
      expect(new Set(got.map((t) => t.id))).toEqual(new Set(own.map((t) => t.id)))
      const want = status === 'complete'
        ? [...own].sort((a, b) => b.number - a.number)
        : [...own].sort((a, b) => a.createdAt - b.createdAt || a.number - b.number)
      expect(got.map((t) => t.id), status).toEqual(want.map((t) => t.id))
    }
  })

  it('leaves out cancelled tasks', () => {
    const w = seedWorld()
    const teamId = Object.keys(w.teams)[0]
    const lanes: Status[] = ['todo', 'progressing', 'review', 'complete']
    const t = lanes.flatMap((s) => laneTasks(w, teamId, s))[0]
    t.stage = 'cancelled'
    expect(lanes.flatMap((s) => laneTasks(w, teamId, s))).not.toContain(t)
  })
})

describe('officePeople', () => {
  // a quiet island 30 days in: one company, and two employees of the Immigration Office who have done nothing there yet
  function quiet() {
    const w = seedWorld()
    w.now = 30 * 24 * 3600
    w.chats = {}
    w.subTasks = {}
    w.tasks = {}
    const teamId = Object.keys(w.teams)[0]
    const [a, b] = Object.values(w.replicas).filter((r) => r.teamId !== teamId)
    a.teamId = STAFFING_ID
    b.teamId = STAFFING_ID
    const own = teamReplicas(w, teamId).map((r) => r.id)
    return { w, teamId, a, b, own }
  }
  const chat = (w: ReturnType<typeof seedWorld>, teamId: string, replicaId: string, at: number, more: Partial<Chat> = {}) => {
    w.chats[`c-${replicaId}-${at}`] = {
      id: `c-${replicaId}-${at}`, teamId, replicaId, name: '', look: w.replicas[replicaId].look, model: '', tokens: 0, createdAt: at - 10,
      messages: [{ at, from: 'user', text: 'hi' }], ...more,
    }
  }
  const task = (w: ReturnType<typeof seedWorld>, teamId: string, more: Partial<Task> = {}) => {
    const t = { id: `t${Object.keys(w.tasks).length}`, teamId, ownerId: null, stage: 'running', paused: false, createdAt: 0, ...more } as Task
    w.tasks[t.id] = t
    return t
  }
  const step = (w: ReturnType<typeof seedWorld>, taskId: string, replicaId: string, more: Partial<SubTask>) => {
    const s = { id: `s${Object.keys(w.subTasks).length}`, taskId, replicaId, status: 'complete', cancelled: false, createdAt: 0, ...more } as SubTask
    w.subTasks[s.id] = s
  }

  it('shows only the company\'s own employees when no one from the office came', () => {
    const { w, teamId, own } = quiet()
    expect(officePeople(w, teamId).map((r) => r.id)).toEqual(own)
  })

  it('adds those who chatted there in the last seven days, after the company\'s own', () => {
    const { w, teamId, a, b, own } = quiet()
    chat(w, teamId, a.id, w.now - VISIT + 60)
    chat(w, teamId, b.id, w.now - VISIT - 60)
    expect(officePeople(w, teamId).map((r) => r.id)).toEqual([...own, a.id])
  })

  it('counts guests of a meeting there, and leaves out chats in other companies', () => {
    const { w, teamId, a, b, own } = quiet()
    chat(w, teamId, own[0], w.now - 60, { guests: [{ replicaId: b.id, name: '', look: b.look, model: '' }] })
    chat(w, 'elsewhere', a.id, w.now - 60)
    expect(officePeople(w, teamId).map((r) => r.id)).toEqual([...own, b.id])
  })

  it('adds those who worked a step there lately, or are working one now', () => {
    const { w, teamId, a, b, own } = quiet()
    const t = task(w, teamId, { stage: 'done', doneAt: w.now - VISIT - 100 })
    step(w, t.id, a.id, { endedAt: w.now - 3600 })
    step(w, t.id, b.id, { endedAt: w.now - VISIT - 100 })
    expect(officePeople(w, teamId).map((r) => r.id)).toEqual([...own, a.id])
    step(w, t.id, b.id, { status: 'progressing', startedAt: w.now - VISIT - 100 })
    expect(officePeople(w, teamId).map((r) => r.id)).toEqual([...own, a.id, b.id])
  })

  it('adds the owner of a running task, but not of one long done', () => {
    const { w, teamId, a, b, own } = quiet()
    task(w, teamId, { ownerId: a.id })
    task(w, teamId, { ownerId: b.id, stage: 'done', doneAt: w.now - VISIT - 1 })
    expect(officePeople(w, teamId).map((r) => r.id)).toEqual([...own, a.id])
  })

  it('counts them busy only for work in this company', () => {
    const { w, teamId, a } = quiet()
    const here = task(w, teamId)
    const there = task(w, 'elsewhere')
    step(w, there.id, a.id, { status: 'progressing', startedAt: w.now })
    expect(busyIn(w, a, teamId)).toBe(false)
    step(w, here.id, a.id, { status: 'progressing', startedAt: w.now })
    expect(busyIn(w, a, teamId)).toBe(true)
  })
})

describe('keepsEscape', () => {
  it('leaves Esc to the box a draft is in, and to the lists and menus that take it first', () => {
    const asked: string[] = []
    const inside = { closest: (sel: string) => { asked.push(sel); return {} } } as unknown as Element
    expect(keepsEscape(inside)).toBe(true)
    // one selector, so what the page nests is what decides: an open list, a floating menu, or a box with a draft
    expect(asked).toHaveLength(1)
    expect(asked[0]).toContain('[data-esc="box"]')
    expect(asked[0]).toContain('[aria-expanded="true"][aria-haspopup="listbox"]')
    expect(asked[0]).toContain('[popover]')
    expect(keepsEscape({ closest: () => null } as unknown as Element)).toBe(false)
    expect(keepsEscape(null)).toBe(false)
  })
})
