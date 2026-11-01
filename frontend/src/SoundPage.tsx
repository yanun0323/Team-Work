import { useEffect, useId, useState, type CSSProperties } from 'react'
import { Select, Toggle } from './Controls'
import { tr } from './core/i18n'
import { MUSIC_STYLES, usePrefs, type MusicStyle } from './prefs'
import { playSound } from './sound'

const SOUND_GROUPS = [
  { key: 'soundTakeoff', label: '飛機音效', keys: ['soundTakeoff', 'soundLanding', 'soundFlyover'] },
  { key: 'soundUI', label: '介面操作', keys: ['soundUI'] },
  { key: 'soundNotice', label: '告示牌通知', keys: ['soundNotice'] },
] as const

export function Volume({ label, value, onChange, min = 0, max = 100, muted, onMute }: { label: string; value: number; onChange: (value: number) => void; min?: number; max?: number; muted?: boolean; onMute?: (muted: boolean) => void }) {
  const id = useId()
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  // Save once per drag/key gesture, not once per pixel of pointer movement.
  const save = () => {
    if (draft === value) return
    // Display only the saved value if the server rejects the change.
    setDraft(value)
    onChange(draft)
  }
  return <div className="fx-field">
    <label htmlFor={id}>{label}</label>
    <span className="fx-volume">
      <input id={id} type="range" min={min} max={max} step="1" value={draft} aria-valuetext={`${draft}%`} style={{ '--volume': (draft - min) / (max - min) } as CSSProperties}
        onChange={(e) => setDraft(Number(e.target.value))} onPointerUp={save} onKeyUp={save} onBlur={save} />
      <output htmlFor={id}>{draft}%</output>
      {onMute && <label className="fx-mute">
        <input type="checkbox" className="fx-tick" aria-label={tr('靜音 {name}', { name: label })} checked={muted} onChange={(e) => onMute(e.target.checked)} />
        {tr('靜音')}
      </label>}
    </span>
  </div>
}

export function MusicSection() {
  const prefs = usePrefs()
  return <section className="fx-d-group" aria-labelledby="fx-music-title" data-sound-controls>
    <h4 id="fx-music-title">{tr('音樂')}</h4>
    <div className="fx-fields">
      <Toggle label={tr('背景執行時靜音')} checked={prefs.muteInBackground} onChange={(muteInBackground) => prefs.set({ muteInBackground })} />
      <Select label={tr('音樂風格')} value={prefs.musicStyle} options={MUSIC_STYLES.map((style) => style.id)}
        labelOf={(id) => tr(MUSIC_STYLES.find((style) => style.id === id)!.label)}
        onChange={(musicStyle) => prefs.set({ musicStyle: musicStyle as MusicStyle })} />
      <Volume label={tr('背景音樂')} value={prefs.musicVolume} onChange={(musicVolume) => prefs.set({ musicVolume })} muted={prefs.musicMuted} onMute={(musicMuted) => prefs.set({ musicMuted })} />
      <Volume label={tr('音效')} value={prefs.effectsVolume} onChange={(effectsVolume) => prefs.set({ effectsVolume })} muted={prefs.effectsMuted} onMute={(effectsMuted) => prefs.set({ effectsMuted })} />
      <div className="fx-sound-switches">
        {SOUND_GROUPS.map(({ key, label, keys }) => <div key={key} className="fx-sound-effect">
          <Toggle label={tr(label)} checked={keys.some((name) => prefs[name])} onChange={(value) => prefs.set(Object.fromEntries(keys.map((name) => [name, value])))} />
          <button type="button" className="fx-tool fx-hit" aria-label={tr('試聽 {name}', { name: tr(label) })}
            disabled={!keys.some((name) => prefs[name]) || prefs.effectsMuted || prefs.effectsVolume === 0} onClick={() => playSound(keys.find((name) => prefs[name]) ?? key, true)}>▶</button>
        </div>)}
      </div>
    </div>
  </section>
}
