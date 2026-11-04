// The skills of a blueprint made here, as rows on its form: reading them in, and reading the rows back. Pure, no React.

import type { GitSource, SkillPack } from './core/domain/types'
import { githubAddress, parseGithub, repoPath, shortRepo } from './github'

export interface SkillRow {
  /** Stays with the row while rows around it come and go. */
  key: number
  /** A folder of this computer, one of the agents' own folders there, or a GitHub repo. */
  kind: 'local' | keyof typeof AGENT_FOLDERS | 'git'
  /** A folder on this computer, or a GitHub repo. */
  where: string
  /** The repo's branch, tag or commit; empty is its default branch. */
  ref: string
  /** The folder in the repo; empty is the whole repo. */
  path: string
  /** Names as typed, separated by commas or spaces. Empty `include` takes every skill. */
  include: string
  exclude: string
}

let lastKey = 0

/** Agents' own folders on this computer, picked by name: their folder is set and cannot be typed. */
export const AGENT_FOLDERS = { codex: '~/.codex/', claude: '~/.claude/' } as const

/** The agent whose own folder this is, if it is one. */
const agentOf = (path: string) =>
  (Object.keys(AGENT_FOLDERS) as (keyof typeof AGENT_FOLDERS)[]).find((k) => AGENT_FOLDERS[k] === `${path.trim().replace(/\/+$/, '')}/`)

export const newSkillRow = (): SkillRow => ({ key: ++lastKey, kind: 'local', where: '~/.agents/', ref: '', path: '', include: '', exclude: '' })

const repoOf = (s: GitSource) => shortRepo(s.repo)

/** The rows for what a blueprint has. A pack of the blueprint's own repo has no row: only a Git blueprint has one. */
export function skillRowsOf(skills: SkillPack[]): SkillRow[] {
  return skills.flatMap((p): SkillRow[] => {
    if (!p.source) return []
    const row = { key: ++lastKey, include: (p.include ?? []).join(', '), exclude: p.exclude.join(', ') }
    return p.source.kind === 'local'
      ? [{ ...row, kind: agentOf(p.source.path) ?? 'local', where: p.source.path, ref: '', path: '' }]
      : [{ ...row, kind: 'git', where: repoOf(p.source), ref: p.source.ref, path: p.source.path ?? '' }]
  })
}

/** Names typed in a row, once each. */
export const skillNames = (text: string) => [...new Set(text.split(/[\s,，、]+/).filter(Boolean))]

/** Reads the rows back; a repo that is not one gives the index of its row. `commit` is what a new version resolves to. */
export function skillPacksOf(rows: SkillRow[], now: number, commit: () => string): { ok: true; skills: SkillPack[] } | { ok: false; row: number } {
  const skills: SkillPack[] = []
  for (const [i, row] of rows.entries()) {
    const include = skillNames(row.include)
    const picks = { include: include.length ? include : null, exclude: skillNames(row.exclude) }
    if (row.kind !== 'git') {
      skills.push({ source: { kind: 'local', path: row.kind === 'local' ? row.where.trim() : AGENT_FOLDERS[row.kind] }, ...picks })
      continue
    }
    const g = parseGithub(row.where)
    if (!g) return { ok: false, row: i }
    const version = g.ref || row.ref.trim()
    const path = repoPath(g.path || row.path)
    const at = commit()
    skills.push({
      source: {
        kind: 'git', repo: githubAddress(g), ref: version, ...(path && { path }), commit: at, latestRef: version, latest: at,
        private: false, upstream: true, update: { at: now, ok: true },
      },
      ...picks,
    })
  }
  return { ok: true, skills }
}
