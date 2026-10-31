import { describe, expect, it } from 'vitest'
import { seedWorld } from './core/data/seed'
import type { ModelProvider, World } from './core/domain/types'
import { blocked, prereqsOf, type PrereqTab, type ProjectHealth } from './prereqs'

const healthy: ProjectHealth = { folder: true, repo: true, targetBranch: true }

function world(): { w: World; teamId: string } {
  const w = seedWorld()
  return { w, teamId: Object.values(w.replicas)[0].teamId }
}
const ids = (w: World, teamId: string, tab: PrereqTab, health: ProjectHealth | null = healthy) => prereqsOf(w, teamId, tab, health).map((x) => x.id)
const noCrew = (w: World, teamId: string) => {
  for (const r of Object.values(w.replicas)) if (r.teamId === teamId) delete w.replicas[r.id]
}
const provider = (over: Partial<ModelProvider>): ModelProvider => ({ id: 'p', name: 'P', kind: 'openai', baseUrl: '', auth: { kind: 'apiKey', keyHint: 'x' }, models: ['m'], ...over })

describe('what a tab of the company file needs', () => {
  it('is nothing in a company with everything', () => {
    const { w, teamId } = world()
    for (const r of Object.values(w.replicas)) r.model = Object.values(w.providers)[0].models[0]
    for (const tab of ['chats', 'tasks', 'crew', 'terminal'] as const) expect(ids(w, teamId, tab)).toEqual([])
  })

  it('names each thing missing, on the tabs that need it', () => {
    const { w, teamId } = world()
    w.providers = {}
    noCrew(w, teamId)
    w.workflows = {}
    w.blueprints = {}
    expect(ids(w, teamId, 'chats')).toEqual(['provider', 'crew'])
    expect(ids(w, teamId, 'tasks')).toEqual(['provider', 'crew', 'workflow'])
    expect(ids(w, teamId, 'crew')).toEqual(['provider', 'blueprint'])
    expect(ids(w, teamId, 'terminal')).toEqual([])
    expect(blocked(prereqsOf(w, teamId, 'crew', healthy))).toBe(true)
    expect(prereqsOf(w, teamId, 'chats', healthy)[0].text).toBe('沒有模型供應商。請先到機場新增模型供應商')
  })

  it('counts a provider with no models, or signed out of, as none', () => {
    const { w, teamId } = world()
    w.providers = { p: provider({ models: [] }) }
    expect(ids(w, teamId, 'crew')).toEqual(['providerReady'])
    w.providers = { p: provider({ auth: { kind: 'subscription' } }) }
    expect(ids(w, teamId, 'crew')).toEqual(['providerReady'])
    w.providers = { p: provider({ auth: { kind: 'subscription', signedIn: true } }) }
    expect(ids(w, teamId, 'crew')).not.toContain('providerReady')
    // Claude reports no state: its models are all there is to go on
    w.providers = { p: provider({ kind: 'anthropic', auth: { kind: 'subscription' } }) }
    expect(ids(w, teamId, 'crew')).not.toContain('providerReady')
  })

  it('warns, without blocking, about employees whose model has gone', () => {
    const { w, teamId } = world()
    w.providers = { p: provider({}) }
    for (const r of Object.values(w.replicas)) r.model = 'm'
    const one = Object.values(w.replicas).find((r) => r.teamId === teamId)!
    one.model = 'gone'
    const list = prereqsOf(w, teamId, 'tasks', healthy)
    expect(list.map((x) => x.id)).toEqual(['crewModel'])
    expect(list[0].text).toContain(one.name)
    expect(blocked(list)).toBe(false)
  })

  it('leaves the employees out when the providers themselves are the problem', () => {
    const { w, teamId } = world()
    w.providers = {}
    expect(ids(w, teamId, 'chats')).not.toContain('crewModel')
  })

  it('reports the folder where work runs in it, and the repo where tasks need it', () => {
    const { w, teamId } = world()
    for (const r of Object.values(w.replicas)) r.model = Object.values(w.providers)[0].models[0]
    const gone = { folder: false, repo: false, targetBranch: false }
    expect(ids(w, teamId, 'chats', gone)).toEqual(['folder'])
    expect(ids(w, teamId, 'tasks', gone)).toEqual(['folder'])
    expect(ids(w, teamId, 'terminal', gone)).toEqual(['folder'])
    expect(ids(w, teamId, 'crew', gone)).toEqual([])
    expect(ids(w, teamId, 'tasks', { folder: true, repo: false, targetBranch: false })).toEqual(['repo'])
    expect(ids(w, teamId, 'chats', { folder: true, repo: false, targetBranch: false })).toEqual([])
    expect(ids(w, teamId, 'tasks', { folder: true, repo: true, targetBranch: false })).toEqual(['targetBranch'])
  })

  it('says nothing about the folder until it is known', () => {
    const { w, teamId } = world()
    for (const r of Object.values(w.replicas)) r.model = Object.values(w.providers)[0].models[0]
    expect(ids(w, teamId, 'tasks', null)).toEqual([])
  })
})
