import { describe, expect, it } from 'vitest'
import { seedWorld } from './seed'
import { statusOf, tick } from '../domain/sim'
import { validate } from '../domain/graph'

describe('seed world', () => {
  it('opens with tasks in several board columns and valid workflows', () => {
    const w = seedWorld()
    const tasks = Object.values(w.tasks)
    const statuses = tasks.map((t) => `${t.title}:${statusOf(w, t)}:${t.stage}:${t.paused}`)
    console.log(statuses.join('\n'))
    const set = new Set(tasks.map((t) => statusOf(w, t)))
    expect(set.has('complete')).toBe(true)
    expect(set.has('review')).toBe(true)
    expect(set.has('progressing')).toBe(true)
    for (const wf of Object.values(w.workflows)) expect(validate(wf)).toEqual([])
  })

  it('keeps running for ten simulated minutes without throwing', () => {
    const w = seedWorld()
    for (let i = 0; i < 1200; i++) tick(w, 0.5)
    expect(w.now).toBeGreaterThan(600)
  })
})
