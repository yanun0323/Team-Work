import { describe, expect, it } from 'vitest'
import { taskNodeOf } from '../domain/graph'
import { effortsOf } from '../../crew'
import { flowList } from '../model'
import { parse } from 'yaml'
import type { LocalSkills, World } from '../domain/types'
import { seedWorld } from './seed'
import { addPresetFlows, PRESET_BLUEPRINTS } from './presets'

describe('presets', () => {
  it('are in the mock world', () => {
    const w = seedWorld()
    for (const b of PRESET_BLUEPRINTS) expect(w.blueprints[b.id].name).toBe(b.name)
    expect(PRESET_BLUEPRINTS.map((b) => b.name)).toEqual(['專案經理', '產品負責人', '設計師', '後端工程師', '前端工程師', '測試工程師'])
  })

  it('find skills in the agent folders, and say so in their YAML', () => {
    for (const b of PRESET_BLUEPRINTS) {
      expect(b.skills.map((p) => (p.source as LocalSkills).path)).toEqual(['~/.agents/', '~/.codex/', '~/.claude/'])
      const text = b.source.kind === 'yaml' ? parse(b.source.text) : null
      expect(text).toMatchObject({ name: b.name, skills: [{ path: '~/.agents/' }, { path: '~/.codex/' }, { path: '~/.claude/' }] })
      expect(text.prompt.trim()).toBe(b.prompt)
    }
  })

  it('join every step up, and run side by side where drawn', () => {
    const w = seedWorld()
    const flows = Object.values(w.workflows)
    const feature = flows.find((f) => f.name === '功能開發')!
    expect(taskNodeOf(feature)?.name).toBe('整理需求')
    expect(feature.edges).toHaveLength(7)
    const at = (name: string) => feature.nodes.find((n) => n.name === name)!.pos
    expect(at('後端開發').y).toBe(at('前端開發').y)
    expect(at('驗收').y).toBeGreaterThan(at('測試').y)
    for (const n of feature.nodes) {
      if (n.name !== '整理需求') expect(feature.edges.some((e) => e.to === n.id)).toBe(true)
      if (n.name !== '驗收') expect(feature.edges.some((e) => e.from === n.id)).toBe(true)
    }
  })

  it('leave a flow of the same name alone', () => {
    const w = seedWorld()
    addPresetFlows(w)
    expect(Object.values(w.workflows).filter((f) => f.name === '修 Bug')).toHaveLength(1)
  })
})

describe('flowList', () => {
  it('lists flows in the order they were made, not by id text', () => {
    const wf = (id: string) => ({ id, name: id, nodes: [], edges: [] })
    const w = { workflows: { 'wf-12': wf('wf-12'), 'wf-9': wf('wf-9') } } as unknown as World
    expect(flowList(w).map((x) => x.id)).toEqual(['wf-9', 'wf-12'])
  })
})

describe('thinking levels', () => {
  it('are what the provider reports for the model, after default', () => {
    const w = seedWorld()
    expect(effortsOf(w, 'gemini-3-pro')).toEqual(['default', 'low', 'high'])
    expect(effortsOf(w, 'not-offered')).toEqual(['default'])
  })
})


it('offers fallback thinking levels only for compatible models without metadata', () => {
  const w = seedWorld()
  const p = Object.values(w.providers).find((p) => p.kind === 'compatible')!
  const model = p.models[0]
  for (const thinking of [undefined, {}, { [model]: [] }]) {
    p.thinking = thinking
    expect(effortsOf(w, model)).toEqual(['default', 'none', 'low', 'medium', 'high', 'xhigh', 'max'])
  }
  p.thinking = { [model]: ['low', 'high'] }
  expect(effortsOf(w, model)).toEqual(['default', 'low', 'high'])
  for (const kind of ['openai', 'anthropic', 'google'] as const) {
    p.kind = kind
    p.thinking = {}
    expect(effortsOf(w, model)).toEqual(['default'])
  }
})
