// The user's look and name, part by part: the figure walking and seated, and each part with what it can be. A pick
// shows at once and is saved a moment later; the name is saved on Enter or on leaving the field. It is the profile's
// edit sheet (DrawerDetail.tsx, `look`), and always this computer's, whichever island the map shows.

import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { tr } from './core/i18n'
import type { Look } from './core/domain/types'
import { HAIRS, SKINS } from './core/domain/sim'
import { lookOf } from './core/profile'
import { setProfile, type Me } from './core/towers'
import { PixelFace } from './core/voxel/PixelFace'
import { Reroll } from './Controls'
import { randomLook } from './crew'
import { BOTTOMS, HAIR_CUTS, SHOES, TOPS, seedOf, styleFor, type Style } from './figureStyle'
import { BOTTOM_NAMES, EXTRAS, FACIALS, HAIR_NAMES, SHOE_NAMES, TOP_NAMES } from './lookNames'
import { Standee } from './Standee'

/** How long the look waits after the last pick before it is saved, so a run of picks is one save. */
export const SAVE_LOOK_MS = 400

const SHIRTS = ['#3f7fbf', '#d9644a', '#4f9a6a', '#8a5bb8', '#e0b13a', '#2f3b52', '#c94f7c', '#5fa8a0', '#eae4d6']
const PANTS = ['#2f3542', '#3b4a6b', '#5b4a3a', '#6b6f78', '#1f2a36', '#7a6a52', '#4f6a4a', '#c8b48a', '#8a3b3b']
const ACCENTS = ['#3a4a6b', '#5b4636', '#c23b3b', '#2f5fa8', '#2f8f5b', '#d9a13b', '#f4f1e8', '#e8a0b4', '#9fc3e0']
const SHOE_COLOURS = ['#2a2a30', '#5b3a26', '#8a5a2b', '#f4f1e8', '#e85d4a', '#3f7fbf', '#4f9a6a', '#e0b13a', '#f2a93b']

/** The look as worn now, with every part picked: what the editor changes one part of. */
export function pinnedParts(look: Look, id: string): Style {
  return styleFor(look, look.style ?? seedOf(id))
}

/** The figure, the name, and each part with what it can be; a pick shows at once and is saved a moment later. */
export function LookEditor({ me }: { me: Me }) {
  const [look, setLook] = useState<Look>(() => lookOf(me))
  const [name, setName] = useState(me.name)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const nameId = useId()
  const timer = useRef(0)
  const latest = useRef({ name: me.name, look })
  const save = useCallback(async (next: { name: string; look: Look }) => {
    window.clearTimeout(timer.current)
    setSaving(true)
    try {
      await setProfile(next.name, next.look)
      setError('')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }, [])
  // a pick waiting to be saved is saved on closing too
  useEffect(() => () => {
    if (timer.current) {
      window.clearTimeout(timer.current)
      void setProfile(latest.current.name, latest.current.look).catch(() => {})
    }
  }, [])
  const wear = (next: Look) => {
    setLook(next)
    latest.current = { ...latest.current, look: next }
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      timer.current = 0
      void save(latest.current)
    }, SAVE_LOOK_MS)
  }
  const parts = pinnedParts(look, me.id)
  const pick = <K extends keyof Style>(k: K, v: Style[K]) => wear({ ...look, parts: { ...parts, [k]: v } })
  const typed = name.trim()
  const rename = () => {
    if (!typed) return setError(tr('請輸入名稱'))
    if (typed === latest.current.name) return
    latest.current = { ...latest.current, name: typed }
    void save(latest.current)
  }
  const seed = look.style ?? seedOf(me.id)
  const face = (over: Partial<Style>, extra = look.extra): Look => ({ ...look, extra, parts: { ...parts, ...over } })
  return (
    <div className="fx-profile-look">
      <div className="fx-profile-figure">
        <Standee look={look} seed={seed} />
        <Reroll label={tr('隨機外型')} onClick={() => { const r = randomLook(); wear({ ...r, parts: undefined }) }} />
      </div>
      <div className="fx-fields">
        <div className="fx-field">
          <label htmlFor={nameId}>{tr('名字')}</label>
          <input id={nameId} className="fx-control" value={name} maxLength={40} autoComplete="off" aria-invalid={!!error || undefined}
            onChange={(e) => { setName(e.target.value); if (error) setError('') }} onBlur={rename}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); rename() } }} />
        </div>
        <Choices label={tr('髮型')} value={parts.hair} options={HAIR_CUTS} nameOf={(h) => tr(HAIR_NAMES[h])} onPick={(h) => pick('hair', h)}
          draw={(h, n) => <PixelFace look={face({ hair: h, facial: 'none' }, 'none')} name={n} size={28} />} />
        <Swatches label={tr('髮色')} value={look.hair} colours={HAIRS} onPick={(c) => wear({ ...look, hair: c })} />
        <Swatches label={tr('膚色')} value={look.skin} colours={SKINS} onPick={(c) => wear({ ...look, skin: c })} />
        <Choices label={tr('鬍子')} value={parts.facial} options={['none', ...FACIALS.map(([f]) => f)] as const}
          nameOf={(f) => (f === 'none' ? tr('無') : tr(FACIALS.find(([x]) => x === f)![1]))} onPick={(f) => pick('facial', f)}
          draw={(f, n) => <PixelFace look={face({ facial: f }, 'none')} name={n} size={28} />} />
        <Choices label={tr('配件')} value={look.extra} options={['none', ...EXTRAS.map(([x]) => x)] as const}
          nameOf={(x) => (x === 'none' ? tr('無') : tr(EXTRAS.find(([e]) => e === x)![1]))} onPick={(x) => wear({ ...look, extra: x, parts })}
          draw={(x, n) => <PixelFace look={face({}, x)} name={n} size={28} />} />
        <Choices label={tr('上衣')} value={parts.top} options={TOPS} nameOf={(t) => tr(TOP_NAMES[t])} onPick={(t) => pick('top', t)} />
        <Swatches label={tr('上衣顏色')} value={look.shirt} colours={SHIRTS} onPick={(c) => wear({ ...look, shirt: c, parts })} />
        <Swatches label={tr('配色')} value={parts.accent} colours={ACCENTS} onPick={(c) => pick('accent', c)} />
        <Choices label={tr('下半身')} value={parts.bottom} options={[...BOTTOMS, 'trunks', 'bikini'] as const} nameOf={(b) => tr(BOTTOM_NAMES[b])} onPick={(b) => pick('bottom', b)} />
        <Swatches label={tr('下身顏色')} value={look.pants} colours={PANTS} onPick={(c) => wear({ ...look, pants: c, parts })} />
        <Choices label={tr('鞋子')} value={parts.shoes} options={SHOES} nameOf={(s) => tr(SHOE_NAMES[s])} onPick={(s) => pick('shoes', s)} />
        {/* bare feet have no colour of their own */}
        {parts.shoes !== 'barefoot' && <Swatches label={tr('鞋子顏色')} value={parts.shoeColor} colours={SHOE_COLOURS} onPick={(c) => pick('shoeColor', c)} />}
        {error && <p className="fx-tower-error" role="alert">{error}</p>}
        {saving && <p className="fx-sr" role="status">{tr('儲存中…')}</p>}
      </div>
    </div>
  )
}

/** One part's options as a row of radio buttons, each a little picture or its name. */
function Choices<T extends string>({ label, value, options, nameOf, onPick, draw }: {
  label: string
  value: T
  options: readonly T[]
  nameOf: (option: T) => string
  onPick: (option: T) => void
  /** A little picture of the option, named `name`. */
  draw?: (option: T, name: string) => ReactNode
}) {
  const id = useId()
  return (
    <div className="fx-field fx-field-top">
      <span id={id}>{label}</span>
      <div className={draw ? 'fx-look-picks fx-look-faces' : 'fx-look-picks'} role="radiogroup" aria-labelledby={id}>
        {options.map((o) => (
          <label key={o} className="fx-look-pick" title={nameOf(o)}>
            <input type="radio" name={id} checked={o === value} onChange={() => onPick(o)} aria-label={draw ? nameOf(o) : undefined} />
            {draw ? <span aria-hidden="true">{draw(o, nameOf(o))}</span> : <span>{nameOf(o)}</span>}
          </label>
        ))}
      </div>
    </div>
  )
}

/** A colour's row: a few to pick from, and the last opens the system's picker for any other. */
function Swatches({ label, value, colours, onPick }: { label: string; value: string; colours: readonly string[]; onPick: (c: string) => void }) {
  const id = useId()
  const own = !colours.some((c) => c.toLowerCase() === value.toLowerCase())
  return (
    <div className="fx-field">
      <span id={id}>{label}</span>
      <div className="fx-look-picks fx-swatches" role="radiogroup" aria-labelledby={id}>
        {colours.map((c) => (
          <label key={c} className="fx-look-pick fx-swatch" style={{ '--swatch': c } as CSSProperties}>
            <input type="radio" name={id} checked={c.toLowerCase() === value.toLowerCase()} onChange={() => onPick(c)} aria-label={c} />
          </label>
        ))}
        <label className="fx-look-pick fx-swatch fx-swatch-own" data-checked={own || undefined} style={own ? { '--swatch': value } as CSSProperties : undefined}
          title={tr('自訂顏色')}>
          <input type="color" value={value} aria-label={tr('自訂顏色')} onChange={(e) => onPick(e.target.value)} />
        </label>
      </div>
    </div>
  )
}
