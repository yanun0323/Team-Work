import { describe, expect, it } from 'vitest'
import data from '../../../../backend/internal/usecase/presets.json'
import { roleOf } from './content'
import type { WorkflowNode } from './types'

const step = (name: string) => ({ id: 'n', kind: 'work', name }) as WorkflowNode

describe('roleOf', () => {
  // The mock's lines follow a step's role, so a built-in step plays the same part whichever language names it.
  it('gives a built-in step in Simplified Chinese, Japanese or Korean the role of its English name', () => {
    for (const flow of data.flows) {
      for (const n of flow.layers.flat()) {
        const want = roleOf(step(n.name.en))
        for (const l of ['zh-Hans', 'ja', 'ko'] as const) expect(roleOf(step(n.name[l])), `${n.name.en} in ${l}`).toBe(want)
      }
    }
  })
})
