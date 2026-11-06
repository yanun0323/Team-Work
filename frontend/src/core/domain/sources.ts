// Sources as the simulator keeps them: places items are read from, one for each repo and branch or folder, and the
// updates they get. The prototype reads no repos, so a source's skills are made up from its name and version.

import type { Blueprint, Replica, SkillPack, Source, SourceChanges, SourceItem, SourcePreview, World } from './types'

/**
 * The source a blueprint or flow was read from, by its id ('' for one that was not): `src-3--reviewer` is the
 * file `blueprints/reviewer.yaml` of the source `src-3`. Built-in ones never are.
 */
export function sourceOfId(id: string) {
  const at = id.indexOf('--')
  return at < 0 || id.startsWith('preset-') ? '' : id.slice(0, at)
}

/** The official source: the blueprints and flows the app comes with. Every world keeps it, by this id. */
export const OFFICIAL_SOURCE = 'team-work'

/** The agents' own folders, kept as sources to pick skills from. */
export const AGENT_FOLDERS = ['~/.agents/', '~/.team-work/', '~/.codex/', '~/.claude/']

const trimSlash = (path: string) => path.replace(/\/+$/, '')

/** Whether `s` is the place a repo and branch, or a folder, name. */
export function sameSource(s: Source, kind: Source['kind'], where: string, ref = '') {
  if (s.kind !== kind) return false
  return kind === 'local' ? trimSlash(s.path ?? '') === trimSlash(where) : s.repo === where && (s.ref ?? '') === ref
}

/** The source a repo and branch, or a folder, name: the one kept, or a new one. */
export function sourceFor(w: World, kind: Source['kind'], where: string, ref = ''): Source {
  const found = Object.values(w.sources).find((s) => sameSource(s, kind, where, ref))
  if (found) return found
  const id = `src${++w.seq}`
  const s: Source = kind === 'local'
    ? { id, kind, path: where, upstream: true, autoApply: false }
    : { id, kind, repo: where, ref, commit: hexOf(`${where}@${ref}`), upstream: true, autoApply: false }
  s.latest = s.commit
  w.sources[id] = s
  return s
}

const hexOf = (text: string) => {
  let h = 2166136261
  for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
  return (h >>> 0).toString(16).padStart(8, '0').slice(0, 7)
}

/**
 * Moves each place written into a pack to the sources kept apart: one source for a repo and branch, the folder in
 * it the pack's own. Sources made here take the version of whichever pack last updated successfully. Built-in
 * blueprints, and packs of a blueprint's own repo, stay as they are.
 */
export function adoptSources(w: World) {
  w.sources ??= {}
  for (const path of AGENT_FOLDERS) sourceFor(w, 'local', path)
  const fresh = new Map<string, number>()
  for (const bp of Object.values(w.blueprints).sort((a, b) => a.id.localeCompare(b.id))) {
    if (bp.id.startsWith('preset-')) continue
    bp.skills = bp.skills.map((p): SkillPack => {
      if (!p.source || p.sourceId) return p
      const before = Object.keys(w.sources).length
      if (p.source.kind === 'local') {
        return { sourceId: sourceFor(w, 'local', p.source.path).id, include: p.include, exclude: p.exclude }
      }
      const g = p.source
      const s = sourceFor(w, 'git', g.repo, g.ref)
      const at = g.update?.ok ? g.update.at : -1
      if (Object.keys(w.sources).length > before || (fresh.has(s.id) && at > (fresh.get(s.id) ?? -1))) {
        fresh.set(s.id, at)
        Object.assign(s, { commit: g.commit, latest: g.latest, upstream: g.upstream, update: g.update })
      }
      return { sourceId: s.id, ...(g.path && { path: g.path.replace(/^\/+|\/+$/g, '') }), include: p.include, exclude: p.exclude }
    })
  }
}

/** The categories the prototype's sources have, by the source's place: each with a few skills. */
const MADE_UP: Record<string, string[]> = {
  '': ['handoff', 'summarize'],
  'skills/engineering': ['tdd', 'code-review', 'diagnosing-bugs'],
  'skills/writing': ['writing-for-agents', 'better-writing'],
}

/** A source's skills at a version: made up, with one more for each newer version than the first. */
export function itemsOf(s: Source, commit = s.commit): SourceItem[] {
  const local = s.kind === 'local'
  const out: SourceItem[] = []
  for (const [category, names] of Object.entries(MADE_UP)) {
    if (local && category.startsWith('skills/writing')) continue
    for (const name of names) out.push({ name, description: '', path: category ? `${category}/${name}` : name, category })
  }
  if (!local && commit && commit !== hexOf(`${s.repo}@${s.ref ?? ''}`)) {
    out.push({ name: `new-${commit.slice(0, 4)}`, description: '', path: `skills/engineering/new-${commit.slice(0, 4)}`, category: 'skills/engineering' })
  }
  return out
}

/** Whether a pack takes a skill at its place in the source. */
export function covers(p: SkillPack, it: SourceItem) {
  const path = p.path ?? ''
  if (path && it.path !== path && !it.path.startsWith(`${path}/`)) return false
  return (p.include === null || p.include.includes(it.name)) && !p.exclude.includes(it.name)
}

/** What moving a source to its newest version would change, and for whom. */
export function sourceChanges(w: World, id: string): SourceChanges {
  const s = w.sources[id]
  const out: SourceChanges = { from: s?.commit ?? '', to: s?.latest ?? '', added: [], removed: [], blueprints: [], replicas: [],
    addedBlueprints: [], removedBlueprints: [], addedWorkflows: [], removedWorkflows: [], kept: [],
  }
  if (!s || s.kind !== 'git' || !s.latest || s.latest === s.commit) return out
  const was = itemsOf(s, s.commit)
  const is = itemsOf(s, s.latest)
  const has = (list: SourceItem[], it: SourceItem) => list.some((x) => x.path === it.path)
  out.added = is.filter((it) => !has(was, it))
  out.removed = was.filter((it) => !has(is, it))
  const changed = [...out.added, ...out.removed]
  for (const bp of Object.values(w.blueprints)) {
    if (!bp.skills.some((p) => p.sourceId === id && changed.some((it) => covers(p, it)))) continue
    out.blueprints.push(bp.id)
    for (const r of Object.values(w.replicas)) if (r.blueprintId === bp.id) out.replicas.push(r.id)
  }
  out.blueprints.sort()
  out.replicas.sort()
  return out
}

/** Keeps a repo at a branch, or a folder, as a source; the one already kept when it is. */
export function addSource(w: World, kind: Source['kind'], where: string, ref = ''): Source {
  return sourceFor(w, kind, where.trim(), ref.trim())
}

/** What a source would bring, without keeping it: in the prototype every repo has the made-up skills. */
export function previewSource(kind: Source['kind'], where: string, ref = ''): SourcePreview {
  const commit = kind === 'git' ? hexOf(`${where.trim()}@${ref.trim()}`) : ''
  const s: Source = { id: '', kind, repo: where, ref, path: where, commit, upstream: true, autoApply: false }
  return { commit, items: itemsOf(s), blueprints: [], workflows: [], problems: [] }
}

/** Asks a repo source's upstream for its newest version; one that applies updates itself moves to it. */
export function checkSource(w: World, id: string) {
  const s = w.sources[id]
  if (!s || s.kind !== 'git') return
  s.update = s.upstream ? { at: w.now, ok: true } : { at: w.now, ok: false, error: '找不到上游' }
  // the prototype has no upstream: each check finds a newer version
  if (s.upstream) s.latest = hexOf(`${s.repo}@${w.now}`)
  if (s.upstream && s.autoApply) {
    if (s.commit !== s.latest) s.unseen = true
    s.commit = s.latest
  }
}

/** The user has opened a source: an update it applied by itself is no longer news. */
export function seeSource(w: World, id: string) {
  if (w.sources[id]) delete w.sources[id].unseen
}

/** Puts a source's newest version in use. */
export function applySource(w: World, id: string) {
  const s = w.sources[id]
  if (s?.latest) s.commit = s.latest
}

export function setSourceAutoApply(w: World, id: string, on: boolean) {
  const s = w.sources[id]
  if (s) s.autoApply = on
}

/**
 * What keeps a source: the blueprints and employees' own settings that read it, and the employees working by a
 * blueprint it brings. Its own blueprints go with it.
 */
export const sourceUsers = (w: World, id: string): (Blueprint | Replica)[] => [
  ...Object.values(w.blueprints).filter((bp) => sourceOfId(bp.id) !== id && bp.skills.some((p) => p.sourceId === id)),
  ...Object.values(w.replicas).filter((r) => sourceOfId(r.blueprintId) === id),
]

/** Forgets a source nothing reads, with what it brought; false while something does. */
export function deleteSource(w: World, id: string): boolean {
  if (!w.sources[id] || id === OFFICIAL_SOURCE || sourceUsers(w, id).length) return false
  delete w.sources[id]
  for (const all of [w.blueprints, w.workflows]) {
    for (const key of Object.keys(all)) if (sourceOfId(key) === id) delete all[key]
  }
  return true
}
