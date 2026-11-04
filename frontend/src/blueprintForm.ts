// The skills a blueprint takes, picked from sources. A source ticked whole takes what is added to it later too, and
// keeps the skills switched off as left out; a source not ticked takes only the skills switched on, and nothing added
// later. Pure, no React.

import { covers } from './core/domain/sources'
import type { SkillPack, SourceItem } from './core/domain/types'

const mine = (p: SkillPack, sourceId: string) => p.sourceId === sourceId

/** Whether the packs take a skill of a source. */
export const takes = (packs: SkillPack[], sourceId: string, it: SourceItem) => packs.some((p) => mine(p, sourceId) && covers(p, it))

/** Whether the packs take the whole of a source, so what is added to it later comes too. */
export const takesAll = (packs: SkillPack[], sourceId: string) => packs.some((p) => mine(p, sourceId) && p.include === null && !p.path)

/** Ticks or unticks a whole source: ticked, every skill of it is on, and those added later too; unticked, none is. */
export function toggleSource(packs: SkillPack[], sourceId: string): SkillPack[] {
  const rest = packs.filter((p) => !mine(p, sourceId))
  return takesAll(packs, sourceId) ? rest : [...rest, { sourceId, include: null, exclude: [] }]
}

/**
 * Switches one skill of a source on or off. In a source ticked whole, a skill off is left out; otherwise the skills on
 * are the ones taken, and only those. `items` are the source's skills, to know which are on.
 */
export function toggleSkill(packs: SkillPack[], sourceId: string, it: SourceItem, items: SourceItem[]): SkillPack[] {
  const on = takes(packs, sourceId, it)
  if (takesAll(packs, sourceId)) {
    return packs.map((p) => (mine(p, sourceId) && p.include === null && !p.path
      ? { ...p, exclude: on ? [...p.exclude, it.name] : p.exclude.filter((n) => n !== it.name) }
      : p))
  }
  const names = [...new Set(items.filter((x) => takes(packs, sourceId, x)).map((x) => x.name))].filter((n) => n !== it.name)
  if (!on) names.push(it.name)
  const rest = packs.filter((p) => !mine(p, sourceId))
  return names.length ? [...rest, { sourceId, include: names, exclude: [] }] : rest
}

/** A skill taken, and where from. */
export interface Taken {
  sourceId: string
  item: SourceItem
}

/** Every skill the packs take of the sources whose skills are known. */
export function takenOf(packs: SkillPack[], items: Record<string, SourceItem[] | undefined>): Taken[] {
  return Object.entries(items).flatMap(([sourceId, list]) => (list ?? []).filter((it) => takes(packs, sourceId, it)).map((item) => ({ sourceId, item })))
}

/** Skills taken under one name from two sources or more: each such name, with one place a source, the one taken first first. */
export function clashesOf(taken: Taken[]): Map<string, Taken[]> {
  const byName = new Map<string, Taken[]>()
  for (const t of taken) {
    const list = byName.get(t.item.name) ?? []
    if (!list.some((x) => x.sourceId === t.sourceId)) byName.set(t.item.name, [...list, t])
  }
  for (const [name, list] of byName) if (list.length < 2) byName.delete(name)
  return byName
}

/** A pack that does not read a source kept apart: the blueprint's own repo, or a place written into it. */
export const loosePack = (p: SkillPack) => !p.sourceId
