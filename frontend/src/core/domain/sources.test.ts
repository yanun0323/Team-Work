import { describe, expect, it } from 'vitest'
import { seedWorld } from '../data/seed'
import { adoptSources, applySource, checkSource, deleteSource, sourceChanges } from './sources'
import type { GitSource, World } from './types'

const git = (repo: string, commit: string, at: number, ok = true): GitSource => ({
  kind: 'git', repo, ref: 'main', commit, latestRef: 'main', latest: commit, private: false, upstream: true, update: { at, ok },
})

function world(): World {
  const w = seedWorld()
  w.blueprints = {}
  w.sources = {}
  w.replicas = {}
  const bp = (id: string, ...skills: World['blueprints'][string]['skills']) => {
    w.blueprints[id] = { id, name: id, source: { kind: 'yaml', text: '' }, prompt: '', comment: '', skills, tools: [], look: { skin: '', hair: '', shirt: '', pants: '', extra: 'none' } }
  }
  bp('bp-a', { source: { ...git('r', 'old', 1), path: 'eng' }, include: null, exclude: [] })
  bp('bp-b', { source: git('r', 'new', 5), include: ['x'], exclude: [] }, { source: git('r', 'bad', 9, false), include: null, exclude: [] })
  return w
}

describe('sources kept apart', () => {
  it('are one for each repo and branch, at the version last updated successfully', () => {
    const w = world()
    adoptSources(w)
    const repos = Object.values(w.sources).filter((s) => s.kind === 'git')
    expect(repos).toHaveLength(1)
    expect(repos[0].commit).toBe('new')
    expect(w.blueprints['bp-a'].skills).toEqual([{ sourceId: repos[0].id, path: 'eng', include: null, exclude: [] }])
    expect(w.blueprints['bp-b'].skills.every((p) => p.sourceId === repos[0].id)).toBe(true)
    const before = JSON.stringify(w.sources)
    adoptSources(w)
    expect(JSON.stringify(w.sources)).toBe(before)
  })

  it('say what a newer version changes and for whom, and take it only when applied', () => {
    const w = world()
    adoptSources(w)
    const id = Object.values(w.sources).find((s) => s.kind === 'git')!.id
    checkSource(w, id)
    const s = w.sources[id]
    expect(s.commit).toBe('new')
    const changes = sourceChanges(w, id)
    expect(changes.to).toBe(s.latest)
    expect(changes.added.length + changes.removed.length).toBeGreaterThan(0)
    applySource(w, id)
    expect(w.sources[id].commit).toBe(changes.to)
    expect(sourceChanges(w, id).added).toEqual([])
  })

  it('apply a newer version themselves only when asked to', () => {
    const w = world()
    adoptSources(w)
    const s = Object.values(w.sources).find((x) => x.kind === 'git')!
    s.autoApply = true
    checkSource(w, s.id)
    expect(s.commit).toBe(s.latest)
  })

  it('cannot be deleted while read', () => {
    const w = world()
    adoptSources(w)
    const s = Object.values(w.sources).find((x) => x.kind === 'git')!
    expect(deleteSource(w, s.id)).toBe(false)
  })
})

it('previews a repo\'s skills without keeping it', async () => {
  const { previewSource } = await import('./sources')
  const got = previewSource('git', 'https://github.com/a/b', 'main')
  expect(got.commit).not.toBe('')
  expect(got.items.length).toBeGreaterThan(0)
})

it('marks an update applied by itself as unseen, until the source is opened', async () => {
  const { seeSource, setSourceAutoApply } = await import('./sources')
  const w = seedWorld()
  const s = Object.values(w.sources).find((x) => x.kind === 'git')!
  checkSource(w, s.id)
  expect(s.unseen).toBeUndefined()
  setSourceAutoApply(w, s.id, true)
  w.now += 60
  checkSource(w, s.id)
  expect(s.unseen).toBe(true)
  seeSource(w, s.id)
  expect(s.unseen).toBeUndefined()
})
