import { describe, expect, it } from 'vitest'
import { emptyWorld } from './core/backend'
import { seedWorld } from './core/data/seed'
import type { TutorialState } from './core/domain/types'
import { EMPTY_TUTORIAL, listed, newlyMet, seed, STEPS } from './tutorial'

const state = (over: Partial<TutorialState> = {}): TutorialState => ({ ...EMPTY_TUTORIAL, seeded: true, ...over })
const ids = (t: TutorialState) => listed(t).items.map((s) => s.id)

describe('the tutorial steps', () => {
  it('are each listed once, and only after steps that come before them', () => {
    const seen = new Set<string>()
    for (const s of STEPS) {
      expect(seen.has(s.id)).toBe(false)
      for (const before of s.after) expect(seen.has(before)).toBe(true)
      seen.add(s.id)
    }
  })

  it('start with the help page alone', () => {
    expect(ids(state())).toEqual(['help'])
  })

  it('let in the steps that wait for a done one', () => {
    expect(ids(state({ done: ['help'], shown: ['help'], played: ['help'] }))).toEqual(['provider'])
    expect(ids(state({ done: ['help', 'provider'], played: ['help', 'provider'] }))).toEqual(['company', 'airportChat', 'globalAgents', 'sound'])
  })

  it('keep a done step listed until its tick has played', () => {
    const t = state({ done: ['help'], shown: ['help'] })
    expect(ids(t)).toEqual(['help', 'provider'])
    expect(ids({ ...t, played: ['help'] })).toEqual(['provider'])
  })

  it('let a step done before it was ever shown go without a tick', () => {
    const t = state({ done: ['help', 'provider'], shown: ['help'], played: ['help'] })
    expect(listed(t).quiet).toEqual(['provider'])
    expect(ids(t)).not.toContain('provider')
  })
})

describe('what counts as done', () => {
  it('reads the world for some steps and the recorded actions for the rest', () => {
    const w = emptyWorld()
    expect(newlyMet(w, state())).toEqual([])
    expect(newlyMet(w, state({ actions: ['help', 'queue'] }))).toEqual(['help', 'queue'])
    const full = seedWorld()
    expect(newlyMet(full, state())).toEqual(expect.arrayContaining(['provider', 'company', 'hire']))
    expect(newlyMet(full, state({ done: ['provider'] }))).not.toContain('provider')
  })
})

describe('the first run', () => {
  it('puts down what is done already as played, so nothing ticks', () => {
    const w = seedWorld()
    const next = seed(w, state({ seeded: false, actions: ['help'] }))
    expect(next.seeded).toBe(true)
    expect(next.played).toEqual(next.done)
    expect(next.done).toEqual(expect.arrayContaining(['help', 'provider', 'company']))
    // what is listed now counts as seen, so it does not slide in either
    const t = state({ ...next })
    for (const id of ids(t)) expect(t.shown).toContain(id)
  })

  it('leaves a newcomer the first step, as seen', () => {
    const next = seed(emptyWorld(), state({ seeded: false }))
    expect(next).toEqual({ seeded: true, done: [], shown: ['help'], played: [] })
  })
})
