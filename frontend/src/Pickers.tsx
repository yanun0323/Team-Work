// The pick-lists of who does the work: employees under their blueprint, and blueprints, each row saying what it can do.

import { tr } from './core/i18n'
import { BlueprintIcon } from './BlueprintIcon'
import { Select } from './Controls'
import { isPreset } from './core/data/presets'
import { TOOLS, type Blueprint, type Replica } from './core/domain/types'
import { blueprintList } from './core/model'
import { useStore } from './core/store'
import { byBlueprint, mindOf } from './crew'
import { ChatFaces } from './ChatFaces'
import { listOf } from './core/i18n'
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

/**
 * Where employees are picked, they come in one plain list, not headed by blueprint: each row says its own, and those
 * of a blueprint still sit together.
 */
export const crewOrder = (w: Parameters<typeof byBlueprint>[0], crew: Replica[]) => byBlueprint(w, crew).flatMap((g) => g.list.map((r) => r.id))

/**
 * One employee as every pick of employees shows them: face, name and blueprint, what they run on and what they can
 * use. `on` ticks them, as picked or already in the chat; `chair` stamps them; `mind` is what they run on where it is
 * not their own setting.
 */
export function CrewRow({ r, on = false, chair, mind }: { r: Replica; on?: boolean; chair?: boolean; mind?: string }) {
  const w = useStore((s) => s.world)
  const bp = w.blueprints[r.blueprintId]
  return (
    <>
      <Picture><PixelFace look={r.look} name={r.name} size={26} /></Picture>
      <span className="fx-row-main">
        <b className="fx-crew-head">
          <span className="fx-crew-name">{r.name}</span>
          {bp && <span className="fx-crew-bp">{bp.name}</span>}
          {chair && <span className="fx-pill fx-chair">{tr('主持人')}</span>}
        </b>
        <span>{mind ?? mindOf(r)}</span>
      </span>
      <Tick on={on} />
      <ToolNotes bp={w.blueprints[r.blueprintId]} />
    </>
  )
}

/** Picks one of `crew`. With nobody picked yet, `value` is empty and the list shows `placeholder`. */
export function CrewSelect({ label, value, crew, placeholder, onChange }: {
  label: string
  value: string
  crew: Replica[]
  placeholder?: string
  onChange: (id: string) => void
}) {
  const w = useStore((s) => s.world)
  const of = (id: string) => crew.find((r) => r.id === id)
  const name = (id: string) => of(id)?.name ?? placeholder ?? ''
  return (
    <Select
      label={label} value={value} options={crewOrder(w, crew)} labelOf={name} onChange={onChange}
      shownAs={(id) => {
        const r = of(id)
        return r
          ? <span className="fx-pick-value"><Picture><PixelFace look={r.look} name={r.name} size={18} /></Picture>{r.name}</span>
          : <span className="fx-d-muted">{placeholder}</span>
      }}
      rowOf={(id, on) => <CrewRow r={of(id) as Replica} on={on} />}
    />
  )
}

/**
 * Picks up to `max` of `crew`, in the order they are picked: the first chairs. Picking one already picked lets them go,
 * though never the last one.
 */
export function CrewPicks({ label, value, crew, max, onChange }: {
  label: string
  value: string[]
  crew: Replica[]
  max: number
  onChange: (ids: string[]) => void
}) {
  const w = useStore((s) => s.world)
  const options = crewOrder(w, crew)
  const of = (id: string) => crew.find((r) => r.id === id)
  const picked = value.map(of).filter((r): r is Replica => !!r)
  const toggle = (id: string) => {
    if (value.includes(id)) { if (value.length > 1) onChange(value.filter((x) => x !== id)) }
    else if (value.length < max) onChange([...value, id])
  }
  return (
    <Select
      label={label} value={value[0] ?? ''} options={options} labelOf={(id) => of(id)?.name ?? ''}
      picked={(id) => value.includes(id)} onChange={toggle}
      shownAs={() => (
        <span className="fx-pick-value">
          <Picture><ChatFaces people={picked} size={18} /></Picture>
          <span className="fx-pick-names">{listOf(picked.map((r) => r.name))}</span>
        </span>
      )}
      rowOf={(id, on) => <CrewRow r={of(id) as Replica} on={on} chair={on && value.length > 1 && id === value[0]} />}
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
