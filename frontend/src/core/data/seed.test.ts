import { describe, expect, it } from 'vitest'
import { seedWorld } from './seed'
import { statusOf, tick } from '../domain/sim'
import { validate } from '../domain/graph'
import { setLanguage } from '../ops'

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
    // a flow names no staff until a task does; preset flows have none yet
    for (const wf of Object.values(w.workflows)) expect(validate(wf).filter((i) => i.kind !== 'noReplica')).toEqual([])
  })

  it('opens with a meeting under way: the chair opened it, and both answered the user once, the chair last', () => {
    const w = seedWorld()
    const talk = Object.values(w.subTasks).find((s) => s.review?.kind === 'talk')
    const name = (id?: string) => (id ? w.replicas[id]?.name : 'user')
    expect(talk?.talk?.messages.map((m) => name(m.by))).toEqual(['Ada', 'user', 'Leo', 'Ada'])
  })

  it('is written in English too, with the same draws, and stays English as it runs', () => {
    const zh = seedWorld()
    const en = seedWorld('en')
    const shape = (w: typeof zh) => Object.values(w.tasks).map((t) => `${t.number}:${statusOf(w, t)}:${t.stage}:${t.paused}`)
    expect(shape(en)).toEqual(shape(zh))
    expect(en.teams[Object.keys(en.teams)[0]].name).toBe('Acme Store')
    for (let i = 0; i < 1200; i++) tick(en, 0.5)
    // a log line with a key is translated as it is shown, so its own text may stay Chinese
    const shown = JSON.stringify(en, (k, v) => (k === 'log' ? (v as { key?: string }[]).filter((l) => !l.key) : v))
    expect(shown.match(/.{0,30}\p{Script=Han}+.{0,30}/gu)).toBeNull()
  })

  it('starts again in the new language when the language changes under dev-mock, and not otherwise', () => {
    const w = seedWorld()
    const team = Object.keys(w.teams)[0]
    w.teams[team].prompt = 'mine'
    setLanguage(w, 'zh')
    expect(w.teams[team].prompt).toBe('mine')
    setLanguage(w, 'en')
    expect(w.language).toBe('en')
    expect(w.teams[team].name).toBe('Acme Store')
  })

  it('keeps running for ten simulated minutes without throwing', () => {
    const w = seedWorld()
    for (let i = 0; i < 1200; i++) tick(w, 0.5)
    expect(w.now).toBeGreaterThan(600)
  })
})
