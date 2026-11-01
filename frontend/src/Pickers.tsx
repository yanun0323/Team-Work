// The pick-lists of who does the work: employees under their blueprint, and blueprints, each row saying what it can do.

import { tr } from './core/i18n'
import { BlueprintIcon } from './BlueprintIcon'
import { Select } from './Controls'
import { isPreset } from './core/data/presets'
import { TOOLS, type Blueprint, type Replica } from './core/domain/types'
import { blueprintList } from './core/model'
import { useStore } from './core/store'
import { byBlueprint, mindOf } from './crew'
import { PixelFace } from './core/voxel/PixelFace'
import { sourceText, toolName } from './source'

/** What a blueprint's employees can use, as up to four notes, two by two. */
export function ToolNotes({ bp }: { bp: Blueprint }) {
  return (
    <span className="fx-staff-tools">
      {TOOLS.filter((t) => bp.tools.includes(t)).map((t) => <span key={t}>{toolName(t)}</span>)}
    </span>
  )
}

const Tick = ({ on }: { on: boolean }) => <span className="fx-check" aria-hidden="true">{on ? '✓' : ''}</span>

/** Who it is, for the closed list and its rows; the names are read out beside the pictures already. */
const Picture = ({ children }: { children: React.ReactNode }) => <span className="fx-pick-picture" aria-hidden="true">{children}</span>

/** Picks one of `crew`. With nobody picked yet, `value` is empty and the list shows `placeholder`. */
export function CrewSelect({ label, value, crew, placeholder, onChange }: {
  label: string
  value: string
  crew: Replica[]
  placeholder?: string
  onChange: (id: string) => void
}) {
  const w = useStore((s) => s.world)
  const groups = byBlueprint(w, crew)
  const of = (id: string) => crew.find((r) => r.id === id)
  const name = (id: string) => of(id)?.name ?? placeholder ?? ''
  return (
    <Select
      label={label} value={value} options={groups.flatMap((g) => g.list.map((r) => r.id))} labelOf={name} onChange={onChange}
      groups={groups.map((g) => ({ label: g.bp.name, count: g.list.length }))}
      groupOf={(id) => groups.findIndex((g) => g.list.some((r) => r.id === id))}
      shownAs={(id) => {
        const r = of(id)
        return r
          ? <span className="fx-pick-value"><Picture><PixelFace look={r.look} name={r.name} size={18} /></Picture>{r.name}</span>
          : <span className="fx-d-muted">{placeholder}</span>
      }}
      rowOf={(id, on) => {
        const r = of(id) as Replica
        return (
          <>
            <Picture><PixelFace look={r.look} name={r.name} size={26} /></Picture>
            <span className="fx-row-main"><b>{r.name}</b><span>{mindOf(r)}</span></span>
            <Tick on={on} />
            <ToolNotes bp={w.blueprints[r.blueprintId]} />
          </>
        )
      }}
    />
  )
}

/** Headings for a list with the user's own first: 我的, then 內建. Without any of their own, just 內建. */
export function mineAndBuiltIn(ids: string[]) {
  const mine = ids.filter((id) => !isPreset(id)).length
  const groups = [{ label: tr('我的'), count: mine }, { label: tr('內建'), count: ids.length - mine }]
  return mine
    ? { groups, groupOf: (id: string) => (isPreset(id) ? 1 : 0) }
    : { groups: groups.slice(1), groupOf: () => 0 }
}

/** Picks one of the island's blueprints, in the same rows as employees. */
export function BlueprintSelect({ label, value, onChange }: { label: string; value: string; onChange: (id: string) => void }) {
  const w = useStore((s) => s.world)
  const blueprints = w.blueprints
  const ids = blueprintList(w).map((b) => b.id)
  return (
    <Select
      label={label} value={value} options={ids} labelOf={(id) => blueprints[id]?.name ?? id} onChange={onChange} {...mineAndBuiltIn(ids)}
      shownAs={(id) => {
        const bp = blueprints[id]
        return bp && <span className="fx-pick-value"><Picture><BlueprintIcon look={bp.look} name={bp.name} size={18} /></Picture>{bp.name}</span>
      }}
      rowOf={(id, on) => {
        const bp = blueprints[id]
        return (
          <>
            <Picture><BlueprintIcon look={bp.look} name={bp.name} size={26} /></Picture>
            <span className="fx-row-main"><b>{bp.name}</b>{!isPreset(id) && <span>{sourceText(bp.source)}</span>}</span>
            <Tick on={on} />
            <ToolNotes bp={bp} />
          </>
        )
      }}
    />
  )
}
