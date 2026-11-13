// The sheets that move employees in and out of the staffing agency (人力資源公司), and copy one from another
// computer's island into this computer's. Each one is all or nothing: the sheet waits for the answer and stays open
// with what went wrong.

import { useEffect, useRef, useState } from 'react'
import { idempotencyKey } from './core/backend'
import { tr, listOf } from './core/i18n'
import { useIsland } from './core/island'
import { leavesAlone } from './core/model'
import { copyReplica, moveReplica, previewCopy, type CopyPack, type CopyPreview, type SkillCopy } from './core/ops'
import { useStore } from './core/store'
import { STAFFING_ID, type Effort } from './core/domain/types'
import { PixelFace } from './core/voxel/PixelFace'
import { Select, Switcher } from './Controls'
import { Gone, Handover, Heading, Section, type Head } from './DrawerDetail'

/** An arrow out of a door: someone going to work somewhere else. */
export function MoveIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path d="M6.5 2.5h-4v11h4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M6 8h8M11 5l3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/** A plane: someone flown over from another island, the way people travel between islands. */
export function PlaneIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path transform="translate(1 -1) rotate(45 8 8)" d="M8 1.5C8.6 1.5 9 2.2 9 3v3.5l5 3V11l-5-1.5v3l1.5 1.2v1.1L8 14l-2.5.8v-1.1L7 12.5v-3L2 11V9.5l5-3V3c0-.8.4-1.5 1-1.5Z"
        fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  )
}

/**
 * Moves an employee into the staffing agency, or out of it into a company. Whoever arrives is someone new: same name,
 * look, settings, model and thinking level, with no memory and none of the old conversations; the work they had goes
 * to an heir, as when they are let go.
 */
export function MoveSheet({ id, onDone, ...h }: Head & { id: string; onDone: () => void }) {
  const w = useStore((s) => s.world)
  const act = useStore((s) => s.act)
  const r = w.replicas[id]
  const companies = Object.values(w.teams).sort((a, b) => a.createdAt - b.createdAt)
  const [to, setTo] = useState(() => companies[0]?.id ?? '')
  const [heir, setHeir] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState('')
  if (!r) return <Gone {...h} />
  const shared = r.teamId === STAFFING_ID
  const dest = shared ? to : STAFFING_ID
  const alone = leavesAlone(w, id)
  const ready = !!dest && (alone || !!heir) && !busy
  const go = (e: React.FormEvent) => {
    e.preventDefault()
    if (!ready) return
    setBusy(true)
    setFailed('')
    moveReplica(act, id, dest, alone ? '' : heir ?? '').then(onDone, (err: Error) => { setBusy(false); setFailed(err.message) })
  }
  return (
    <form className="fx-d-form" onSubmit={go} aria-busy={busy}>
      <header className="fx-d-head fx-d-who">
        <PixelFace look={r.look} name={r.name} size={52} />
        <Heading {...h}>{shared ? tr('把 {name} 移到公司', { name: r.name }) : tr('把 {name} 移到人力資源公司', { name: r.name })}</Heading>
      </header>
      {shared && (
        companies.length
          ? <Select label={tr('移到')} value={to} options={companies.map((c) => c.id)} labelOf={(x) => w.teams[x]?.name ?? x} onChange={setTo} />
          : <p className="fx-d-muted">{tr('還沒有公司')}</p>
      )}
      <p className="fx-room-warn" role="note">{tr('移動後是新的員工：記憶會清空，也不會帶走以前的對話')}</p>
      <Handover id={id} heir={heir} onHeir={setHeir} />
      {failed && <p className="fx-room-warn" role="alert">{failed}</p>}
      <button type="submit" className="fx-save" disabled={!ready}>{busy ? tr('移動中…') : tr('移動')}</button>
    </form>
  )
}

/** How a skill pack reads to the user, and what it will be once copied this way. */
export function packLine(p: CopyPack, mode: SkillCopy): { where: string; state: 'ok' | 'missing'; note: string } {
  const where = p.kind === 'git' ? [p.repo, p.path].filter(Boolean).join(' / ') : p.kind === 'local' ? p.path ?? '' : tr('技能來源已不存在')
  const skills = p.skills ? listOf(p.skills) : ''
  if (p.kind === 'missing' || !p.skills) return { where, state: 'missing', note: tr('對方也讀不到，不會複製') }
  if (mode === 'files') return { where, state: 'ok', note: p.skills.length ? tr('複製檔案：{skills}', { skills }) : tr('沒有技能') }
  if (p.kind === 'git') return { where, state: 'ok', note: tr('在這台重新取得：{skills}', { skills }) }
  return { where, state: 'missing', note: tr('對方電腦上的資料夾，複製後要重新指定') }
}

/**
 * Copies an employee of the island shown, another computer's, into this computer's staffing agency: their name,
 * look, settings, model and thinking level, never their memory, tasks, chats, company or credentials. What they read
 * skills from comes along as where to get them again, or with the skills' files; what would not work here is said
 * before anything is copied. The employee there stays as they were.
 */
export function CopyHomeSheet({ id, ...h }: Head & { id: string }) {
  const w = useStore((s) => s.world)
  const peer = useIsland((s) => s.island)
  const r = w.replicas[id]
  const [preview, setPreview] = useState<CopyPreview | null>(null)
  const [loadError, setLoadError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!peer) return
    const asking = new AbortController()
    setPreview(null)
    setLoadError('')
    previewCopy(peer.id, id, asking.signal).then(setPreview, (e: Error) => { if (e.name !== 'AbortError') setLoadError(e.message) })
    return () => asking.abort()
  }, [peer, id, attempt])
  if (!r || !peer) return <Gone {...h} />
  return (
    <div className="fx-d-form">
      <header className="fx-d-head fx-d-who">
        <PixelFace look={r.look} name={r.name} size={52} />
        <Heading {...h}>{tr('把 {name} 複製到我的人力資源公司', { name: r.name })}</Heading>
      </header>
      {loadError ? (
        <div role="alert">
          <p className="fx-room-warn">{loadError}</p>
          <button type="button" className="fx-add" onClick={() => setAttempt((n) => n + 1)}>{tr('重試')}</button>
        </div>
      ) : !preview ? (
        <p className="fx-d-muted" role="status">{tr('載入中…')}</p>
      ) : <CopyForm preview={preview} send={(o, key) => copyReplica(peer.id, id, o, key)} />}
    </div>
  )
}

/**
 * The thinking level a copy goes with: the one chosen while the model picked takes it, else '' for the user to pick;
 * no level is put in its place.
 */
export function copyLevel(preview: CopyPreview, model: string, effort: Effort | ''): Effort | '' {
  return model && effort && (preview.thinking[model] ?? []).includes(effort) ? effort : ''
}

/** The choices of a copy, once what it would give is known; `send` copies, with the key of this one copy. */
export function CopyForm({ preview, send }: {
  preview: CopyPreview
  send: (o: { skills: SkillCopy; model: string; effort: Effort }, key: string) => Promise<{ replica: { name: string }; missing: string[] }>
}) {
  const [mode, setMode] = useState<SkillCopy>('source')
  // their own model and level when this island has them; otherwise the user picks, nothing is put in their place
  const [model, setModel] = useState(preview.modelOk ? preview.model : '')
  const [effort, setEffort] = useState<Effort | ''>(preview.effortOk ? preview.effort : '')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState('')
  const [done, setDone] = useState<{ name: string; missing: string[] } | null>(null)
  // one copy, however many times it is sent: a retry of one that did go through makes nobody new
  const key = useRef(idempotencyKey())
  const levels = (preview.thinking[model] ?? []) as Effort[]
  const level = copyLevel(preview, model, effort)
  const levelGone = preview.modelOk && !preview.effortOk && model === preview.model
  const go = (e: React.FormEvent) => {
    e.preventDefault()
    if (!model || !level || busy) return
    setBusy(true)
    setFailed('')
    send({ skills: mode, model, effort: level as Effort }, key.current).then(
      (res) => { setBusy(false); setDone({ name: res.replica.name, missing: res.missing }) },
      (err: Error) => { setBusy(false); setFailed(err.message) })
  }
  if (done) {
    return (
      <div role="status">
        <p>{tr('{name} 已在你的人力資源公司，記憶是空的', { name: done.name })}</p>
        {done.missing.length > 0 && (
          <Section name={tr('要重新指定的技能來源')}>
            <ul className="fx-d-list">{done.missing.map((m) => <li key={m}><code>{m}</code></li>)}</ul>
          </Section>
        )}
      </div>
    )
  }
  return (
    <form className="fx-d-form" onSubmit={go} aria-busy={busy}>
      <p className="fx-d-muted">{tr('只複製姓名、外觀、工作設定、模型和思考等級；記憶、任務、對話和登入資料不會複製')}</p>
      <Section name={tr('員工藍圖#kind')}>
        <p>{preview.blueprint.name}{preview.blueprint.presetId && !preview.presetOk && <span className="fx-d-muted"> · {tr('這台沒有這個內建藍圖，會改成自訂設定')}</span>}</p>
      </Section>
      <Select label={tr('模型')} value={model} options={preview.models} onChange={setModel}
        shownAs={(m) => (m ? <span>{m}</span> : <span className="fx-d-muted">{tr('選擇模型')}</span>)} />
      {!preview.modelOk && <p className="fx-room-warn" role="note">{tr('這座島沒有 {model}，請選擇要用的模型', { model: preview.model })}</p>}
      {levelGone && <p className="fx-room-warn" role="note">{tr('{model} 沒有思考等級 {effort}，請重新選擇', { model: preview.model, effort: preview.effort })}</p>}
      <Select label={tr('思考等級')} value={level} options={levels} onChange={(x) => setEffort(x as Effort)} disabled={!model}
        shownAs={(x) => (x ? <span>{x}</span> : <span className="fx-d-muted">{tr('選擇思考等級')}</span>)} />
      <Switcher label={tr('技能')} value={mode} options={['source', 'files'] as const}
        labelOf={(x) => (x === 'source' ? tr('只複製技能來源設定') : tr('連技能檔案一起複製'))} onChange={setMode} />
      <Section name={tr('技能來源')}>
        {preview.packs.length === 0 ? <p className="fx-d-muted">{tr('沒有')}</p> : (
          <ul className="fx-d-list">
            {preview.packs.map((p, i) => {
              const line = packLine(p, mode)
              return (
                <li key={i}>
                  <code>{line.where}</code>
                  <span className={line.state === 'missing' ? 'fx-room-warn' : 'fx-d-muted'}> · {line.note}</span>
                </li>
              )
            })}
          </ul>
        )}
      </Section>
      {failed && <p className="fx-room-warn" role="alert">{failed}</p>}
      <button type="submit" className="fx-save" disabled={!model || !level || busy}>{busy ? tr('複製中…') : failed ? tr('重試') : tr('複製')}</button>
    </form>
  )
}
