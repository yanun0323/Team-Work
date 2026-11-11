import { describe, expect, it } from 'vitest'
import { seedWorld } from './data/seed'
import { createTask, statusOf } from './domain/sim'
import type { Status } from './domain/types'
import { keepsEscape, laneTasks } from './model'

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
