// The airport's sources: every repo and folder skills are read from, kept once for all that use them. The tab lists
// them; a source's sheet shows its skills, checks for a newer version and, once what it would change is seen, puts it
// in use.

import { useEffect, useState } from 'react'
import { tr } from './core/i18n'
import { useNow, useStore } from './core/store'
import { addSource, applySource, attempt, checkSource, previewSource, seeSource, deleteSource, setSourceAutoApply, sourceChanges, sourceProblems } from './core/ops'
import { OFFICIAL_SOURCE, sourceOfId, sourceUsers } from './core/domain/sources'
import { blueprintList, flowList } from './core/model'
import { githubAddress, parseGithub } from './github'
import { keptState, sourceName } from './source'
import { BlueprintIcon } from './BlueprintIcon'
import { CrewRow, crewOrder } from './Pickers'
import { Switcher, Toggle, WaitBadge } from './Controls'
import { byCategory, useSourceItems } from './SkillPicker'
import { DeleteTool, Gone, Heading, itemKey, type Head, type Item } from './DrawerDetail'
import type { Blueprint, Look, Replica, Source, SourceChanges, SourceItem, SourcePreview } from './core/domain/types'

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

/**
 * A source's row in the list: its mark, its name with what it brings and what went wrong, and 自動更新 stamped on a
 * repo that updates itself. Whether it is a repo or a folder its name already says (owner/repo, or a path).
 */
export function SourceRow({ s, now, brings = [] }: { s: Source; now: number; brings?: string[] }) {
  const state = keptState(s, now)
  return (
    <>
      <SourceSign s={s} />
      <span className="fx-row-main">
        <b>{sourceName(s)}</b>
        {/* each count kept whole, so a narrow sheet breaks between them, not inside one */}
        {brings.length > 0 && (
          <span className="fx-src-brings">
            {brings.map((x, i) => <span key={x}>{i > 0 && ' · '}<span>{x}</span></span>)}
          </span>
        )}
        {state?.tone === 'bad' && <span className={`fx-src-state fx-src-${state.tone}`}>{state.label}</span>}
      </span>
      {s.kind === 'git' && s.autoApply && <span className="fx-pill">{tr('自動更新')}</span>}
    </>
  )
}

/**
 * What a source brings: its skills, then the employee and task blueprints it has, then how many blueprints and
 * employees use it (what keeps it from being deleted); nothing until its skills are read.
 */
export function bringsText(skills: number | undefined, blueprints: number, flows: number, users = 0): string[] {
  if (skills === undefined) return []
  const parts = [
    skills > 0 && tr('{length} 個技能', { length: skills }),
    blueprints > 0 && tr('{length} 個員工藍圖', { length: blueprints }),
    flows > 0 && tr('{length} 個任務藍圖', { length: flows }),
  ].filter((x): x is string => !!x)
  return [...(parts.length ? parts : [tr('沒有技能')]), ...(users > 0 ? [tr('用在 {length} 處', { length: users })] : [])]
}

export function SourcesTab({ open, onOpen }: { open: string | null; onOpen: (x: Item) => void }) {
  const now = useNow()
  const w = useStore((s) => s.world)
  const items = useSourceItems(Object.keys(w.sources))
  const blueprints = blueprintList(w).map((b) => sourceOfId(b.id))
  const flows = flowList(w).map((f) => sourceOfId(f.id))
  const brings = (id: string) =>
    bringsText(items[id]?.length, blueprints.filter((x) => x === id).length, flows.filter((x) => x === id).length, sourceUsers(w, id).length)
  const opener = (x: Item) => ({ type: 'button' as const, 'aria-expanded': open === itemKey(x), 'aria-controls': 'fx-detail', onClick: () => onOpen(x) })
  return (
    <div className="fx-d-groups">
      <button className="fx-task fx-task-new fx-flow-new fx-hit" {...opener({ kind: 'newSource' })}>{tr('＋ 新增來源')}</button>
      <ul className="fx-list">
        {sorted(w.sources).map((s) => (
          <li key={s.id}><button className="fx-row fx-src-row fx-hit" {...opener({ kind: 'source', id: s.id })}><SourceRow s={s} now={now} brings={brings(s.id)} /></button></li>
        ))}
      </ul>
    </div>
  )
}

function Section({ name, className, children }: { name: string; className?: string; children: React.ReactNode }) {
  return <section className={className ? `fx-d-sec ${className}` : 'fx-d-sec'}><h3>{name}</h3>{children}</section>
}

/** Skills by name; with onOpen, each opens its own sheet, the one open (by path) pressed. */
export function ItemChips({ items, tone, open, onOpen }: { items: SourceItem[]; tone?: 'out'; open?: string | null; onOpen?: (path: string) => void }) {
  return (
    <p className="fx-d-chips">
      {items.map((it) => (onOpen
        ? <button key={it.path} type="button" aria-expanded={open === it.path} title={it.description || undefined} onClick={() => onOpen(it.path)}>{it.name}</button>
        : <span key={it.path} className={tone === 'out' ? 'fx-chip-out' : undefined} title={it.description || undefined}>{it.name}</span>))}
    </p>
  )
}

/** Names that come and go: those that come, then those that go struck through. */
function NameChips({ added, removed = [] }: { added: string[]; removed?: string[] }) {
  return (
    <p className="fx-d-chips">
      {added.map((name) => <span key={`+${name}`}>{name}</span>)}
      {removed.map((name) => <span key={`-${name}`} className="fx-chip-out">{name}</span>)}
    </p>
  )
}

/** The files of a source that could not be read as blueprints, each with why. */
function Problems({ list }: { list: string[] }) {
  if (!list.length) return null
  return (
    <Section name={tr('無法讀取')}>
      <ul className="fx-src-problems">{list.map((p) => <li key={p} className="fx-field-error">{p}</li>)}</ul>
    </Section>
  )
}

/** The blueprints or flows a source brings, by face and name, each opening its own sheet, the one open pressed. */
function Brought({ name, kind, items, open, onOpen }: {
  name: string
  kind: 'blueprint' | 'flow'
  items: { id: string; name: string; look?: Look }[]
  open: string | null
  onOpen: (x: Item) => void
}) {
  if (!items.length) return null
  return (
    <Section name={name}>
      <ul className="fx-list">
        {items.map((x) => (
          <li key={x.id}>
            <button type="button" className="fx-row fx-hit" aria-expanded={open === itemKey({ kind, id: x.id })} onClick={() => onOpen({ kind, id: x.id })}>
              {x.look && <span aria-hidden="true"><BlueprintIcon look={x.look} name={x.name} size={26} /></span>}
              <span className="fx-row-main"><b>{x.name}</b></span>
            </button>
          </li>
        ))}
      </ul>
    </Section>
  )
}

/**
 * Asks a repo source's upstream now, turning while it waits. It stays focusable while it turns, so the keyboard does
 * not lose its place; a second press then does nothing.
 */
function CheckTool({ id, local }: { id: string; local?: boolean }) {
  const act = useStore((s) => s.act)
  const [checking, setChecking] = useState(false)
  const check = async () => {
    if (checking) return
    setChecking(true)
    await attempt(() => checkSource(act, id))
    setChecking(false)
  }
  const label = local ? (checking ? tr('正在重新讀取') : tr('重新讀取')) : checking ? tr('正在檢查更新') : tr('檢查更新')
  return (
    <button type="button" className="fx-tool fx-hit fx-src-check" aria-busy={checking} aria-label={label} title={label} onClick={check}>
      <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
        <path d="M13 8a5 5 0 1 1-1.46-3.54M12.8 2v3h-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  )
}

/** The repo's page on GitHub, at its branch when it keeps one; none for an address that is not GitHub's. */
export function repoPage(s: Source) {
  const g = s.kind === 'git' ? parseGithub(s.repo ?? '') : null
  if (!g) return null
  return `https://github.com/${g.repo}${s.ref ? `/tree/${s.ref.split('/').map(encodeURIComponent).join('/')}` : ''}`
}

/** Opens the repo's page on GitHub. */
function RepoTool({ href }: { href: string }) {
  const label = tr('在 GitHub 開啟')
  return (
    <a className="fx-tool fx-hit" href={href} target="_blank" rel="noreferrer" aria-label={label} title={label}>
      <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
        <path d="M9 3h4v4M13 3 7.5 8.5M11.5 9.5V13H3V4.5h3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </a>
  )
}

/** One source: its state, what a newer version would change and for whom, and its skills by folder, each opening its own sheet. */
export function SourceDetail({ id, open, onSkill, openItem = null, onItem = () => {}, onGoneSource, ...h }: Head & {
  id: string
  /** The path of the skill open on the sheet above, if any. */
  open: string | null
  onSkill: (path: string) => void
  /** The blueprint or flow it brings open on the sheet above, by `itemKey`, if any. */
  openItem?: string | null
  onItem?: (x: Item) => void
  onGoneSource: () => void
}) {
  const now = useNow()
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
  // the employee and task blueprints it brings, and the files of those that could not be read
  const blueprints = blueprintList(w).filter((b) => sourceOfId(b.id) === id)
  const flows = flowList(w).filter((f) => sourceOfId(f.id) === id)
  const [problems, setProblems] = useState<string[]>([])
  const read = `${s?.commit}:${blueprints.map((b) => b.id).join()}:${flows.map((f) => f.id).join()}`
  useEffect(() => {
    const ask = new AbortController()
    sourceProblems(id, ask.signal).then(setProblems, () => {})
    return () => ask.abort()
  }, [id, read])
  if (!s) return <Gone {...h} />
  const state = keptState(s, now)
  const users = sourceUsers(w, id)
  const crew = (changes?.replicas ?? []).map((r) => w.replicas[r]).filter(Boolean) as Replica[]
  const kept = (changes?.kept ?? []).map((r) => w.replicas[r]).filter(Boolean) as Replica[]
  // a company's own copy of a blueprint is not listed: its employees are
  const touched = (changes?.blueprints ?? []).map((b) => w.blueprints[b]).filter((b) => b && !b.owner) as Blueprint[]
  const page = repoPage(s)
  return (
    <>
      <div className="fx-tools">
        {page && <RepoTool href={page} />}
        <CheckTool key={id} id={id} local={s.kind === 'local'} />
        {id !== OFFICIAL_SOURCE && (
          <DeleteTool what={tr('來源')} disabled={users.length > 0} why={tr('還有 {length} 個藍圖或員工使用這個來源，無法刪除', { length: users.length })}
            onConfirm={() => { onGoneSource(); act((x) => void deleteSource(x, id)) }} />
        )}
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
              {changes.addedBlueprints.length + changes.removedBlueprints.length > 0 && (
                <><h4>{tr('員工藍圖')}</h4><NameChips added={changes.addedBlueprints} removed={changes.removedBlueprints} /></>
              )}
              {changes.addedWorkflows.length + changes.removedWorkflows.length > 0 && (
                <><h4>{tr('任務藍圖')}</h4><NameChips added={changes.addedWorkflows} removed={changes.removedWorkflows} /></>
              )}
              {touched.length > 0 && (
                <>
                  <h4>{tr('受影響的員工藍圖')}</h4>
                  <ul className="fx-list">
                    {touched.map((b) => (
                      <li key={b.id} className="fx-row">
                        <span aria-hidden="true"><BlueprintIcon look={b.look} name={b.name} size={26} /></span>
                        <span className="fx-row-main"><b>{b.name}</b></span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {crew.length > 0 && (
                <>
                  <h4>{tr('受影響的員工')}</h4>
                  <ul className="fx-list">
                    {crewOrder(w, crew).map((r) => <li key={r} className="fx-row"><CrewRow r={w.replicas[r]} /></li>)}
                  </ul>
                </>
              )}
              {kept.length > 0 && (
                <>
                  <h4>{tr('改用自訂設定')}</h4>
                  <ul className="fx-list">
                    {crewOrder(w, kept).map((r) => <li key={r} className="fx-row"><CrewRow r={w.replicas[r]} /></li>)}
                  </ul>
                </>
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
              <ItemChips items={list} open={open} onOpen={onSkill} />
            </div>
          ))
        )}
      </Section>
      <Brought name={tr('員工藍圖')} kind="blueprint" items={blueprints} open={openItem} onOpen={onItem} />
      <Brought name={tr('任務藍圖')} kind="flow" items={flows} open={openItem} onOpen={onItem} />
      <Problems list={problems} />
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
  const preview = shown?.preview
  const items = preview?.items
  const empty = !!preview && preview.items.length + preview.blueprints.length + preview.workflows.length === 0
  const ready = kind === 'local' ? place !== '' : !!preview && !empty
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
        <div aria-live="polite">
          {shown?.error ? <p role="alert" className="fx-field-error">{shown.error}</p>
            : !items ? <p className="fx-d-muted">{tr('讀取中…')}</p>
              : empty ? <p className="fx-field-error">{tr('這個來源沒有技能、員工藍圖或任務藍圖')}</p>
                : (
                  <>
                    {items.length > 0 && (
                      <Section name={tr('技能')}>
                        {[...byCategory(items)].map(([category, list]) => (
                          <div key={category} className="fx-skill-group">
                            <h4>{category || tr('最上層')}</h4>
                            <ItemChips items={list} />
                          </div>
                        ))}
                      </Section>
                    )}
                    {preview!.blueprints.length > 0 && <Section name={tr('員工藍圖')}><NameChips added={preview!.blueprints} /></Section>}
                    {preview!.workflows.length > 0 && <Section name={tr('任務藍圖')}><NameChips added={preview!.workflows} /></Section>}
                    <Problems list={preview!.problems} />
                  </>
                )}
        </div>
      )}
      {error && <p role="alert" className="fx-field-error">{error}</p>}
      <button type="submit" className="fx-save" disabled={busy || !ready}>{busy ? tr('讀取中…') : tr('新增')}</button>
    </form>
  )
}
