import { describe, expect, it } from 'vitest'
import { effortsOf } from '../../crew'
import { blueprintList, flowList, hireList } from '../model'
import type { LocalSkills, World } from '../domain/types'
import { seedWorld } from './seed'
import { AIRPORT_BLUEPRINT, isLocked } from './presets'
import { OFFICIAL_SOURCE, sourceOfId } from '../domain/sources'
import { deleteSource, duplicateWorkflow, setLanguage } from '../domain/sim'

describe('presets', () => {
  const blueprints = (w: World) => Object.values(w.blueprints).filter((b) => sourceOfId(b.id) === OFFICIAL_SOURCE)

  it('are the official source\'s and the airport staff\'s, in the mock world in the language picked', () => {
    const w = seedWorld()
    expect(blueprints(w).map((b) => b.name).sort()).toEqual(['通才', '前端工程師', '後端工程師', '審查與測試', '介面設計工程師', '媒體設計師', '功能規劃', '研究員', '寫手', 'DevOps 工程師', 'Matt Pocock', 'Poteto'].sort())
    expect(w.blueprints['preset-airport'].name).toBe('機場服務人員')
    expect(w.sources[OFFICIAL_SOURCE]).toMatchObject({ kind: 'git', repo: 'https://github.com/yanun0323/Team-Work-Source', autoApply: true })
    expect(deleteSource(w, OFFICIAL_SOURCE)).toBe(false)
    setLanguage(w, 'en')
    expect(w.blueprints['team-work--product'].name).toBe('Feature Planner')
    expect(w.blueprints['team-work--product'].prompt).toContain("company's feature planner")
    expect(w.workflows['team-work--feature'].name).toBe('Feature development')
  })

  it('have every text in both languages', () => {
    const w = seedWorld()
    const zh = structuredClone(w)
    setLanguage(w, 'en')
    for (const [id, b] of Object.entries(w.blueprints)) {
      if (!isLocked(id)) continue
      expect(b.prompt).not.toMatch(/[\u4e00-\u9fff]/)
      expect(zh.blueprints[id].prompt).toMatch(/[\u4e00-\u9fff]/)
    }
    for (const n of Object.values(w.workflows).filter((f) => isLocked(f.id)).flatMap((f) => f.nodes)) {
      expect(`${n.name} ${n.prompt}`).not.toMatch(/[\u4e00-\u9fff]/)
    }
  })

  it('keep read-only roles without the write tool', () => {
    const { blueprints: all } = seedWorld()
    for (const id of ['team-work--reviewer']) {
      expect(all[id].tools).not.toContain('writeFile')
      expect(all[id].prompt).toContain('不修改任何檔案')
    }
  })

  it('find skills in the agent folders', () => {
    const w = seedWorld()
    expect(w.blueprints[AIRPORT_BLUEPRINT].skills.map((p) => (p.source as LocalSkills).path)).toEqual(['~/.agents/', '~/.team-work/', '~/.codex/', '~/.claude/'])
    // the official source's read the agent folders and its own skills folder, never Codex's or Claude's, then repos
    for (const b of blueprints(w)) {
      const whole = b.id === 'team-work--matt-pocock' || b.id === 'team-work--poteto'
      const folders = b.skills.flatMap((p) => (p.sourceId === OFFICIAL_SOURCE ? [p.path] : w.sources[p.sourceId!].kind === 'local' ? [w.sources[p.sourceId!].path] : []))
      expect(folders).toEqual(whole ? ['~/.agents/', '~/.team-work/'] : ['~/.agents/', '~/.team-work/', 'skills'])
      const repos = b.skills.filter((p) => w.sources[p.sourceId!]?.kind === 'git' && p.sourceId !== OFFICIAL_SOURCE)
      expect(repos.length).toBeGreaterThan(0)
      for (const p of repos) expect(p.include === null).toBe(whole)
    }
  })

  it('keep the repos they read from GitHub as sources', () => {
    const w = seedWorld()
    const read = (id: string) => w.blueprints[id].skills.map((p) => ({ repo: w.sources[p.sourceId!]?.repo, ref: w.sources[p.sourceId!]?.ref, path: p.path }))
    expect(read('team-work--matt-pocock')[0]).toEqual({ repo: 'https://github.com/mattpocock/skills', ref: 'main', path: undefined })
    expect(read('team-work--poteto')[0]).toEqual({ repo: 'https://github.com/cursor/plugins', ref: 'main', path: 'pstack' })
    const kept = Object.keys(w.sources).length
    setLanguage(w, 'en')
    expect(Object.keys(w.sources)).toHaveLength(kept)
    expect(deleteSource(w, w.blueprints['team-work--poteto'].skills[0].sourceId!)).toBe(false)
  })

  it('start where they do the work, join every step up, and run side by side where drawn', () => {
    const feature = seedWorld().workflows['team-work--feature']
    expect(feature.nodes.some((n) => n.name === '整理需求')).toBe(false)
    const starts = feature.nodes.filter((n) => !feature.edges.some((e) => e.to === n.id))
    expect(starts.map((n) => n.name)).toEqual(['撰寫規格'])
    const at = (name: string) => feature.nodes.find((n) => n.name === name)!.pos
    expect(at('後端開發').y).toBe(at('前端開發').y)
    // the source still writes sendBack on its steps; the flow does not keep it
    for (const n of feature.nodes) expect('sendBack' in n).toBe(false)
  })

  it('copy as shown, and a copy stays as it was while what the app wrote follows the language', () => {
    const w = seedWorld()
    const copy = duplicateWorkflow(w, 'team-work--feature')!
    expect(isLocked(copy.id)).toBe(false)
    expect(copy.name).toBe('功能開發-1')
    setLanguage(w, 'en')
    const shown = w.workflows[copy.id]
    expect(shown.name).toBe('功能開發-1')
    expect(shown.nodes.map((n) => n.name)).toContain('撰寫規格')
  })

  it('put a step still named and told as the start template, or an old flow\'s first step, into the language', () => {
    const w = seedWorld()
    const wf = w.workflows['wf-bugfix']
    setLanguage(w, 'en')
    expect(wf.nodes.find((n) => n.id === 'b-start')!.name).toBe('Clarify requirements')
    expect(wf.nodes.find((n) => n.id === 'b-start')!.prompt).toContain('next step can act')
    expect(wf.nodes.find((n) => n.id === 'b-fix')!.name).toBe('修正')
  })
})

describe('own first', () => {
  it('lists the user\'s own, then the official source\'s, then the built-in ones', () => {
    const w = seedWorld()
    const ids = blueprintList(w).map((b) => b.id)
    const official = ids.filter((id) => sourceOfId(id) === OFFICIAL_SOURCE)
    expect(official).toHaveLength(12)
    expect(ids.findIndex((id) => sourceOfId(id) === OFFICIAL_SOURCE)).toBeGreaterThan(ids.findLastIndex((id) => !isLocked(id)))
    expect(ids.at(-1)).toBe(AIRPORT_BLUEPRINT)
    expect(hireList(w).map((b) => b.id)).toEqual(ids.slice(0, -1))
    expect(flowList(w).slice(-4).map((f) => f.id).sort()).toEqual(['team-work--bugfix', 'team-work--feature', 'team-work--review', 'team-work--small'])
  })
})

describe('flowList', () => {
  it('lists flows in the order they were made, not by id text', () => {
    const wf = (id: string) => ({ id, name: id, nodes: [], edges: [] })
    const w = { workflows: { 'wf-12': wf('wf-12'), 'wf-9': wf('wf-9') } } as unknown as World
    expect(flowList(w).map((x) => x.id)).toEqual(['wf-9', 'wf-12'])
  })

  it('lists a source\'s flows by the order their files give, then those giving none by name', () => {
    const wf = (id: string, name: string, order?: number) => ({ id, name, nodes: [], edges: [], ...(order !== undefined && { order }) })
    const w = { workflows: {
      'src-1--a': wf('src-1--a', 'Alpha'), 'src-1--b': wf('src-1--b', 'Beta', 2), 'src-1--c': wf('src-1--c', 'Gamma', -1),
      'src-1--d': wf('src-1--d', 'Delta'), 'src-1--e': wf('src-1--e', 'Echo', 0.5), 'wf-1': wf('wf-1', 'Mine', -9),
    } } as unknown as World
    expect(flowList(w).map((x) => x.id)).toEqual(['wf-1', 'src-1--c', 'src-1--e', 'src-1--b', 'src-1--a', 'src-1--d'])
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
