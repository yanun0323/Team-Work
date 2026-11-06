import { describe, expect, it } from 'vitest'
import { seedWorld } from '../data/seed'
import { roleOf } from './content'
import { setLanguage } from './sim'
import { OFFICIAL_SOURCE, sourceOfId } from './sources'
import type { Locale, World, WorkflowNode } from './types'

const step = (name: string) => ({ id: 'n', kind: 'work', name }) as WorkflowNode

/** The names of the official flows' steps in a language, by flow and step id. */
const stepNames = (w: World, language: Locale) => {
  setLanguage(w, language)
  return new Map(Object.values(w.workflows).filter((f) => sourceOfId(f.id) === OFFICIAL_SOURCE)
    .flatMap((f) => f.nodes.map((n) => [`${f.id}/${n.id}`, n.name] as const)))
}

describe('roleOf', () => {
  // The mock's lines follow a step's role, so an official step plays the same part whichever language names it.
  it('gives an official step in Simplified Chinese, Japanese or Korean the role of its English name', () => {
    const w = seedWorld()
    const en = stepNames(w, 'en')
    expect(en.size).toBeGreaterThan(0)
    for (const l of ['zh-Hans', 'ja', 'ko'] as const) {
      for (const [id, name] of stepNames(w, l)) expect(roleOf(step(name)), `${en.get(id)} in ${l}`).toBe(roleOf(step(en.get(id)!)))
    }
  })
})
