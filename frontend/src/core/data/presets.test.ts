import { describe, expect, it } from 'vitest'
import { taskNodeOf } from '../domain/graph'
import { effortsOf } from '../../crew'
import { blueprintList, flowList } from '../model'
import type { LocalSkills, World } from '../domain/types'
import { seedWorld } from './seed'
import { isPreset } from './presets'
import { duplicateWorkflow, setLanguage } from '../domain/sim'

describe('presets', () => {
  const blueprints = (w: World) => Object.values(w.blueprints).filter((b) => isPreset(b.id))

  it('are in the mock world, in the language picked', () => {
    const w = seedWorld()
    expect(blueprints(w).map((b) => b.name)).toEqual(['專案經理', '產品負責人', '設計師', '後端工程師', '前端工程師', '全端工程師', '測試工程師', '研究員', '程式審查員', '技術架構師', '資安工程師', 'DevOps 工程師', '技術文件寫手', '資料分析師', '行銷文案', '特助'])
    setLanguage(w, 'en')
    expect(w.blueprints['preset-pm'].name).toBe('Project Manager')
    expect(w.blueprints['preset-pm'].prompt).toContain("company's project manager")
    expect(w.workflows['preset-feature'].name).toBe('Feature development')
  })

  it('have every text in both languages', () => {
    const w = seedWorld()
    const zh = structuredClone(w)
    setLanguage(w, 'en')
    for (const [id, b] of Object.entries(w.blueprints)) {
      if (!isPreset(id)) continue
      expect(b.prompt).not.toMatch(/[\u4e00-\u9fff]/)
      expect(zh.blueprints[id].prompt).toMatch(/[\u4e00-\u9fff]/)
    }
    for (const n of Object.values(w.workflows).filter((f) => isPreset(f.id)).flatMap((f) => f.nodes)) {
      expect(`${n.name} ${n.prompt}`).not.toMatch(/[\u4e00-\u9fff]/)
    }
  })

  it('keep read-only roles without the write tool', () => {
    const { blueprints: all } = seedWorld()
    for (const id of ['preset-reviewer', 'preset-security']) {
      expect(all[id].tools).not.toContain('writeFile')
      expect(all[id].prompt).toContain('不修改任何檔案')
    }
  })

  it('find skills in the agent folders', () => {
    for (const b of blueprints(seedWorld())) {
      expect(b.skills.map((p) => (p.source as LocalSkills).path)).toEqual(['~/.agents/', '~/.mho/', '~/.codex/', '~/.claude/'])
    }
  })

  it('join every step up, and run side by side where drawn', () => {
    const feature = seedWorld().workflows['preset-feature']
    expect(taskNodeOf(feature)?.name).toBe('整理需求')
    expect(feature.edges).toHaveLength(6)
    const at = (name: string) => feature.nodes.find((n) => n.name === name)!.pos
    expect(at('後端開發').y).toBe(at('前端開發').y)
    expect(at('驗收').y).toBeGreaterThan(at('前端開發').y)
    for (const n of feature.nodes) {
      if (n.name !== '整理需求') expect(feature.edges.some((e) => e.to === n.id)).toBe(true)
      if (n.name !== '驗收') expect(feature.edges.some((e) => e.from === n.id)).toBe(true)
    }
  })

  it('copy as shown, and a copy stays as it was while what the app wrote follows the language', () => {
    const w = seedWorld()
    const copy = duplicateWorkflow(w, 'preset-feature')!
    expect(isPreset(copy.id)).toBe(false)
    expect(copy.name).toBe('功能開發-1')
    setLanguage(w, 'en')
    const shown = w.workflows[copy.id]
    expect(shown.name).toBe('功能開發-1')
    expect(shown.nodes.map((n) => n.name)).toContain('撰寫規格')
    expect(shown.nodes[0].name).toBe('Clarify requirements')
    expect(shown.nodes[0].prompt).toContain('next step can act')
  })
})

describe('own first', () => {
  it('lists the user\'s own before the built-in ones', () => {
    const w = seedWorld()
    const ids = blueprintList(w).map((b) => b.id)
    expect(ids.findIndex(isPreset)).toBe(ids.length - 16)
    expect(ids.slice(-16)[0]).toBe('preset-pm')
    expect(flowList(w).slice(-6).map((f) => f.id)).toEqual(['preset-feature', 'preset-small', 'preset-bugfix', 'preset-planning', 'preset-review', 'preset-refactor'])
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
