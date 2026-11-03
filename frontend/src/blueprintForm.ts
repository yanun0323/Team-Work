// The skills of a blueprint made here, as rows on its form: reading them in, and reading the rows back. Pure, no React.

import type { GitSource, SkillPack } from './core/domain/types'
import { githubAddress, parseGithub, shortRepo } from './github'

export interface SkillRow {
  /** Stays with the row while rows around it come and go. */
  key: number
  kind: 'local' | 'git'
  /** A folder on this computer, or a GitHub repo. */
  where: string
  /** The repo's branch, tag or commit; empty is its default branch. */
  ref: string
  /** Names as typed, separated by commas or spaces. Empty `include` takes every skill. */
  include: string
  exclude: string
}

let lastKey = 0

export const newSkillRow = (): SkillRow => ({ key: ++lastKey, kind: 'local', where: '~/.agents/', ref: '', include: '', exclude: '' })

const repoOf = (s: GitSource) => shortRepo(s.repo)

/** The rows for what a blueprint has. A pack of the blueprint's own repo has no row: only a Git blueprint has one. */
export function skillRowsOf(skills: SkillPack[]): SkillRow[] {
  return skills.flatMap((p): SkillRow[] => {
    if (!p.source) return []
    const row = { key: ++lastKey, include: (p.include ?? []).join(', '), exclude: p.exclude.join(', ') }
    return p.source.kind === 'local'
      ? [{ ...row, kind: 'local', where: p.source.path, ref: '' }]
      : [{ ...row, kind: 'git', where: repoOf(p.source), ref: p.source.ref }]
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
    if (row.kind === 'local') {
      skills.push({ source: { kind: 'local', path: row.where.trim() }, ...picks })
      continue
    }
    const g = parseGithub(row.where)
    if (!g) return { ok: false, row: i }
    const version = g.ref || row.ref.trim()
    const at = commit()
    skills.push({
      source: {
        kind: 'git', repo: githubAddress(g), ref: version, commit: at, latestRef: version, latest: at,
        private: false, upstream: true, update: { at: now, ok: true },
      },
      ...picks,
    })
  }
  return { ok: true, skills }
}
