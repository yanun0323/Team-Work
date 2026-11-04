// The airport's sources: every repo and folder skills are read from, kept once for all that use them. The tab lists
// them; a source's sheet shows its skills, checks for a newer version and, once what it would change is seen, puts it
// in use.

import { useEffect, useState } from 'react'
import { tr } from './core/i18n'
import { useStore } from './core/store'
import { addSource, applySource, previewSource, seeSource, deleteSource, setSourceAutoApply, sourceChanges } from './core/ops'
import { sourceUsers } from './core/domain/sources'
import { githubAddress, parseGithub } from './github'
import { keptState, sourceName } from './source'
import { BlueprintIcon } from './BlueprintIcon'
import { CrewRow, crewOrder } from './Pickers'
import { Switcher, Toggle, WaitBadge } from './Controls'
import { byCategory, useSourceItems } from './SkillPicker'
import { DeleteTool, Gone, Heading, itemKey, type Head, type Item } from './DrawerDetail'
import type { Replica, Source, SourceChanges, SourceItem, SourcePreview } from './core/domain/types'

const sorted = (sources: Record<string, Source>) =>
  Object.values(sources).sort((a, b) => (a.kind === b.kind ? sourceName(a).localeCompare(sourceName(b)) : a.kind === 'git' ? -1 : 1))

/**
 * The mark before a source in the list, the same as the chat list's: a red ! while a newer version waits, a red dot
 * once one was applied by itself and the source not opened since. The slot stays when empty, so the names line up.
 */
export function SourceSign({ s }: { s: Source }) {
  const waiting = s.kind === 'git' && !!s.latest && s.latest !== s.commit
  return (
    <span className="fx-chat-sign">
      {waiting ? <WaitBadge inline label={tr('有新版本')} />
        : s.unseen && <span className="fx-chat-unread" title={tr('已自動更新')}><span className="fx-sr">{tr('已自動更新')}</span></span>}
    </span>
  )
}

/** A source's row in the list: its mark, its name with what went wrong, and a stamp: 本地 for a folder, 自動更新 for a repo that updates itself. */
export function SourceRow({ s, now }: { s: Source; now: number }) {
  const state = keptState(s, now)
  return (
    <>
      <SourceSign s={s} />
      <span className="fx-row-main">
        <b>{sourceName(s)}</b>
        {state?.tone === 'bad' && <span className={`fx-src-state fx-src-${state.tone}`}>{state.label}</span>}
      </span>
      {s.kind === 'git' ? s.autoApply && <span className="fx-pill">{tr('自動更新')}</span> : <span className="fx-pill">{tr('本地')}</span>}
    </>
  )
}

export function SourcesTab({ open, onOpen }: { open: string | null; onOpen: (x: Item) => void }) {
  const w = useStore((s) => s.world)
  const opener = (x: Item) => ({ type: 'button' as const, 'aria-expanded': open === itemKey(x), 'aria-controls': 'fx-detail', onClick: () => onOpen(x) })
  return (
    <div className="fx-d-groups">
      <button className="fx-task fx-task-new fx-flow-new fx-hit" {...opener({ kind: 'newSource' })}>{tr('＋ 新增來源')}</button>
      <ul className="fx-list">
        {sorted(w.sources).map((s) => (
          <li key={s.id}><button className="fx-row fx-src-row fx-hit" {...opener({ kind: 'source', id: s.id })}><SourceRow s={s} now={w.now} /></button></li>
        ))}
      </ul>
    </div>
  )
}

function Section({ name, className, children }: { name: string; className?: string; children: React.ReactNode }) {
  return <section className={className ? `fx-d-sec ${className}` : 'fx-d-sec'}><h3>{name}</h3>{children}</section>
}

function ItemChips({ items, tone }: { items: SourceItem[]; tone?: 'out' }) {
  return (
    <p className="fx-d-chips">
      {items.map((it) => <span key={it.path} className={tone === 'out' ? 'fx-chip-out' : undefined} title={it.description || undefined}>{it.name}</span>)}
    </p>
  )
}

/** One source: its state, what a newer version would change and for whom, and its skills by folder. */
export function SourceDetail({ id, onGoneSource, ...h }: Head & { id: string; onGoneSource: () => void }) {
  const w = useStore((s) => s.world)
  const act = useStore((s) => s.act)
  const s = w.sources[id]
  // opening it is seeing the update it applied by itself
  const unseen = !!s?.unseen
  useEffect(() => {
    if (unseen) act((x) => void seeSource(x, id))
  }, [act, id, unseen])
  const items = useSourceItems(s ? [id] : [])[id]
  const [changes, setChanges] = useState<SourceChanges | null>(null)
  // what the newest version would change, read again whenever a version moves
  useEffect(() => {
    setChanges(null)
    if (!s || s.kind !== 'git' || !s.latest || s.latest === s.commit) return
    const ask = new AbortController()
    sourceChanges(useStore.getState().world, id, ask.signal).then(setChanges, () => {})
    return () => ask.abort()
  }, [id, s?.kind, s?.commit, s?.latest]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!s) return <Gone {...h} />
  const state = keptState(s, w.now)
  const users = sourceUsers(w, id)
  const crew = (changes?.replicas ?? []).map((r) => w.replicas[r]).filter(Boolean) as Replica[]
  return (
    <>
      <div className="fx-tools">
        <DeleteTool what={tr('來源')} disabled={users.length > 0} why={tr('還有 {length} 個藍圖或員工使用這個來源，無法刪除', { length: users.length })}
          onConfirm={() => { onGoneSource(); act((x) => void deleteSource(x, id)) }} />
      </div>
      <header className="fx-d-head"><Heading {...h}>{sourceName(s)}</Heading></header>
      {s.kind === 'git' && (
        <>
          <Section name={tr('版本')}>
            <p className="fx-src-head">
              <code>{(s.commit ?? '').slice(0, 7) || tr('沒有')}</code>
              {state && <span className={`fx-src-state fx-src-${state.tone}`}>{state.label}</span>}
            </p>
            {state?.note && <p className={state.tone === 'bad' ? 'fx-src-note fx-src-note-bad' : 'fx-src-note'}>{state.note}</p>}
          </Section>
          <div className="fx-fields">
            <Toggle label={tr('自動套用更新')} checked={s.autoApply} onChange={(on) => act((x) => void setSourceAutoApply(x, id, on))} />
          </div>
          {changes && (
            <Section name={tr('更新內容')} className="fx-src-changes">
              {changes.added.length > 0 && <><h4>{tr('新增')}</h4><ItemChips items={changes.added} /></>}
              {changes.removed.length > 0 && <><h4>{tr('移除')}</h4><ItemChips items={changes.removed} tone="out" /></>}
              {changes.added.length + changes.removed.length === 0 && <p className="fx-d-muted">{tr('技能沒有增減')}</p>}
              {changes.blueprints.length > 0 && (
                <ul className="fx-list">
                  {changes.blueprints.map((b) => w.blueprints[b]).filter((b) => b && !b.owner).map((b) => (
                    <li key={b!.id} className="fx-row">
                      <span aria-hidden="true"><BlueprintIcon look={b!.look} name={b!.name} size={26} /></span>
                      <span className="fx-row-main"><b>{b!.name}</b></span>
                    </li>
                  ))}
                </ul>
              )}
              {crew.length > 0 && (
                <ul className="fx-list">
                  {crewOrder(w, crew).map((r) => <li key={r} className="fx-row"><CrewRow r={w.replicas[r]} /></li>)}
                </ul>
              )}
              <div className="fx-settings-file-acts">
                <button type="button" className="fx-save" onClick={() => act((x) => void applySource(x, id))}>{tr('套用更新')}</button>
              </div>
            </Section>
          )}
        </>
      )}
      <Section name={tr('技能')}>
        {!items ? <p className="fx-d-muted">{tr('讀取中…')}</p> : items.length === 0 ? <p className="fx-d-muted">{tr('沒有')}</p> : (
          [...byCategory(items)].map(([category, list]) => (
            <div key={category} className="fx-skill-group">
              <h4>{category || tr('最上層')}</h4>
              <ItemChips items={list} />
            </div>
          ))
        )}
      </Section>
    </>
  )
}

/** Keeps a GitHub repo, at a branch, or a folder on this computer as a source. */
export function NewSource({ onDone, ...h }: Head & { onDone: () => void }) {
  const act = useStore((s) => s.act)
  const [kind, setKind] = useState<Source['kind']>('git')
  const [where, setWhere] = useState('')
  const [ref, setRef] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const repo = kind === 'git' ? parseGithub(where.trim()) : null
  const place = kind === 'git' ? (repo ? githubAddress(repo) : '') : where.trim()
  const branch = ref.trim() || repo?.ref || ''
  const bad = kind === 'git' && where.trim() !== '' && !repo
  // a repo's skills are read as it is typed, and it is kept at the version they were read at
  const [read, setRead] = useState<{ key: string; preview?: SourcePreview; error?: string } | null>(null)
  const key = `${place}@${branch}`
  useEffect(() => {
    if (kind !== 'git' || !place) return
    const stop = new AbortController()
    const wait = setTimeout(() => {
      setRead({ key })
      previewSource('git', place, branch, stop.signal).then(
        (preview) => setRead({ key, preview }),
        (err: Error) => { if (!stop.signal.aborted) setRead({ key, error: err.message }) },
      )
    }, 500)
    return () => { clearTimeout(wait); stop.abort() }
  }, [kind, place, branch, key])
  const shown = kind === 'git' && place && read?.key === key ? read : null
  const items = shown?.preview?.items
  const ready = kind === 'local' ? place !== '' : (items?.length ?? 0) > 0
  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!ready) return
    setBusy(true)
    setError('')
    try {
      await addSource(act, kind, place, branch, shown?.preview?.commit)
      onDone()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <form className="fx-d-form" onSubmit={(e) => void save(e)}>
      <header className="fx-d-head"><Heading {...h}>{tr('新增來源')}</Heading></header>
      <div className="fx-fields">
        <Switcher label={tr('位置')} value={kind} options={['git', 'local'] as const}
          labelOf={(x) => (x === 'git' ? 'GitHub' : tr('本機資料夾'))} onChange={setKind} />
        <label className="fx-field">
          <span>{kind === 'git' ? 'Repo' : tr('資料夾')}</span>
          <input className="fx-control" value={where} required pattern=".*\S.*" spellCheck={false} autoComplete="off"
            placeholder={kind === 'git' ? 'owner/repo' : '~/.agents/'} aria-invalid={bad || undefined}
            aria-describedby={bad ? 'fx-source-error' : undefined} onChange={(e) => setWhere(e.target.value)} />
        </label>
        {bad && <p id="fx-source-error" className="fx-field-error">{tr('請輸入 owner/repo 或 GitHub 網址')}</p>}
        {kind === 'git' && (
          <label className="fx-field">
            <span>{tr('分支')}</span>
            <input className="fx-control" value={ref} spellCheck={false} autoComplete="off" placeholder={tr('留空為預設分支')}
              onChange={(e) => setRef(e.target.value)} />
          </label>
        )}
      </div>
      {kind === 'git' && place && (
        <Section name={tr('技能')}>
          <div aria-live="polite">
            {shown?.error ? <p role="alert" className="fx-field-error">{shown.error}</p>
              : !items ? <p className="fx-d-muted">{tr('讀取中…')}</p>
                : items.length === 0 ? <p className="fx-field-error">{tr('這個來源沒有技能')}</p>
                  : [...byCategory(items)].map(([category, list]) => (
                    <div key={category} className="fx-skill-group">
                      <h4>{category || tr('最上層')}</h4>
                      <ItemChips items={list} />
                    </div>
                  ))}
          </div>
        </Section>
      )}
      {error && <p role="alert" className="fx-field-error">{error}</p>}
      <button type="submit" className="fx-save" disabled={busy || !ready}>{busy ? tr('讀取中…') : tr('新增')}</button>
    </form>
  )
}
