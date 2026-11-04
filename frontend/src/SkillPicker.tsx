// The skills a blueprint or an employee's own settings take, from every source kept on the airport: a source ticked
// whole, or its skills switched on one at a time. Two skills of one name taken from two sources turn red.

import { useEffect, useMemo, useState } from 'react'
import { tr } from './core/i18n'
import { useStore } from './core/store'
import { sourceItems } from './core/ops'
import { clashesOf, loosePack, takenOf, takes, takesAll, toggleSkill, toggleSource } from './blueprintForm'
import { sourceName, sourceText } from './source'
import type { SkillPack, Source, SourceItem } from './core/domain/types'

/** A source's skills, by folder, the top first. */
export function byCategory(items: SourceItem[]) {
  const out = new Map<string, SourceItem[]>()
  for (const it of [...items].sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name))) {
    out.set(it.category, [...(out.get(it.category) ?? []), it])
  }
  return out
}

/** The skills of each source in `ids`, read once each; undefined until read. */
export function useSourceItems(ids: string[]) {
  const [items, setItems] = useState<Record<string, SourceItem[] | undefined>>({})
  const sources = useStore((s) => s.world.sources)
  // read again when a source moves to another version
  const key = ids.map((id) => `${id}@${sources[id]?.commit ?? ''}`).join(',')
  useEffect(() => {
    const ask = new AbortController()
    for (const id of ids) {
      sourceItems(useStore.getState().world, id, ask.signal).then((list) => setItems((x) => ({ ...x, [id]: list })), () => {})
    }
    return () => ask.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return items
}

/**
 * Picks skills into `packs`. Every source kept on the airport is listed under a tick of its name: ticked, its skills
 * are all on and those added later come too, a skill switched off being left out; unticked, only the skills switched
 * on are taken. Packs that read no source kept apart (a built-in blueprint's, or the blueprint's own repo) are listed
 * as they are and can only be removed.
 */
export function SkillPicker({ packs, onChange }: { packs: SkillPack[]; onChange: (packs: SkillPack[]) => void }) {
  const sources = useStore((s) => s.world.sources)
  const listed = useMemo(() => Object.values(sources).sort(bySource), [sources])
  const items = useSourceItems(listed.map((s) => s.id))
  // skills taken under one name from two sources: their notes turn red
  const clashes = useMemo(() => clashesOf(takenOf(packs, items)), [packs, items])

  return (
    <section className="fx-d-sec">
      <h3>{tr('技能')}</h3>
      {packs.some(loosePack) && (
        <ul className="fx-src-list">
          {packs.map((p, i) => (loosePack(p) ? (
            <li key={i} className="fx-src">
              <p className="fx-src-head">
                <span>{p.source ? sourceText(p.source) : tr('藍圖本身')}</span>
                <button type="button" className="fx-tool fx-hit" aria-label={tr('移除')} title={tr('移除')}
                  onClick={() => onChange(packs.filter((x) => x !== p))}>{CROSS}</button>
              </p>
            </li>
          ) : null))}
        </ul>
      )}
      {listed.map((s) => {
        const list = items[s.id]
        const name = sourceName(s)
        const head = `fx-skill-src-${s.id}`
        return (
          <div key={s.id} className="fx-skill-src" role="group" aria-labelledby={head}>
            <label className="fx-skill-src-head">
              <input type="checkbox" className="fx-tick" checked={takesAll(packs, s.id)} onChange={() => onChange(toggleSource(packs, s.id))} />
              <b id={head}>{name}</b>
            </label>
            {!list ? <p className="fx-d-muted">{tr('讀取中…')}</p> : list.length === 0 ? <p className="fx-d-muted">{tr('沒有技能')}</p> : (
              <p className="fx-skill-notes">
                {[...list].sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path)).map((it) => {
                  const clash = clashes.get(it.name)?.some((t) => t.sourceId === s.id && t.item.path === it.path)
                  return (
                    <button key={it.path} type="button" className={clash ? 'fx-skill-note fx-skill-clash' : 'fx-skill-note'}
                      aria-pressed={takes(packs, s.id, it)} title={it.description || undefined}
                      onClick={() => onChange(toggleSkill(packs, s.id, it, list))}>{it.name}</button>
                  )
                })}
              </p>
            )}
          </div>
        )
      })}
    </section>
  )
}

/** Repos first, then folders, each by name. */
const bySource = (a: Source, b: Source) => (a.kind === b.kind ? sourceName(a).localeCompare(sourceName(b)) : a.kind === 'git' ? -1 : 1)

const CROSS = (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
  </svg>
)
