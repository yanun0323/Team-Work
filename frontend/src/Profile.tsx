// The user's own profile: a drawer like the airport's, opened from their face at the top right, with their
// milestones on this island. Its edit button tapes the look editor (LookEditor.tsx) beside it, as a detail sheet, to
// dress their figure part by part and name them; the name is also this computer's on other towers. All of it is this
// computer's own, whichever island the map shows.

import { useEffect, useRef, useState } from 'react'
import { tr } from './core/i18n'
import { lookOf, readProfileStats, type ProfileStats } from './core/profile'
import { loadMe, useMe } from './core/towers'
import { PixelFace } from './core/voxel/PixelFace'
import { SheetStack, useMapClickSheets, useSheets } from './Drawer'
import { fmtCount, fmtUsd } from './Stats'

/** The user's face, for the button at the top right: opens their profile. */
export function ProfileButton({ onClick, buttonRef }: { onClick: () => void; buttonRef?: React.Ref<HTMLButtonElement> }) {
  const me = useMe((s) => s.me)
  useEffect(() => { if (!useMe.getState().me) void loadMe() }, [])
  return (
    <button ref={buttonRef} type="button" className="fx-settings-trigger fx-tag fx-profile-trigger" aria-label={tr('個人檔案')} title={me?.name} onClick={onClick}>
      {me ? <PixelFace look={lookOf(me)} name={me.name} size={22} /> : <span className="fx-profile-blank" aria-hidden="true" />}
    </button>
  )
}

export function Profile({ leaving, onGone }: {
  leaving: boolean
  /** Called when the page has turned away. */
  onGone: () => void
}) {
  const title = useRef<HTMLHeadingElement>(null)
  const me = useMe((s) => s.me)
  const [error, setError] = useState('')
  const sheets = useSheets()
  useMapClickSheets(sheets, leaving)
  useEffect(() => title.current?.focus({ preventScroll: true }), [])
  useEffect(() => {
    if (me) return
    readMe(setError)
  }, [me])
  const base = sheets.layers[0]
  const editing = !!base && !base.leaving && base.item.kind === 'look'
  return (
    <>
    <aside id="fx-profile" className={leaving ? 'fx-drawer leaving' : 'fx-drawer'} aria-labelledby="fx-profile-title"
      aria-hidden={leaving || undefined} inert={leaving || undefined}
      onAnimationEnd={(e) => { if (leaving && e.target === e.currentTarget) onGone() }}>
      <span className="fx-tape fx-tape-l" aria-hidden="true" />
      <span className="fx-tape fx-tape-r" aria-hidden="true" />
      <div className="fx-sheet">
        <header className="fx-head fx-head-rule">
          <div className="fx-title fx-profile-title">
            {me && <PixelFace look={lookOf(me)} name={me.name} size={44} />}
            <div className="fx-title-text">
              <h1 id="fx-profile-title" ref={title} tabIndex={-1}>{me?.name ?? tr('個人檔案')}</h1>
            </div>
            {me && <div className="fx-head-tools">
              <button type="button" className="fx-save" aria-expanded={editing} aria-controls="fx-detail"
                onClick={() => sheets.open({ kind: 'look' })}>{tr('編輯')}</button>
            </div>}
          </div>
        </header>
        <section className="fx-page" aria-label={tr('成就')}>
          {!me && error
            ? <div className="fx-d-groups"><p className="fx-tower-error" role="alert">{error}</p>
              <button type="button" className="fx-save" onClick={() => { setError(''); readMe(setError) }}>{tr('重試')}</button></div>
            : <Milestones />}
        </section>
      </div>
    </aside>
    <SheetStack sheets={sheets} teamId="" leaving={leaving} />
    </>
  )
}

function readMe(onError: (message: string) => void) {
  void loadMe().then((message) => { if (message) onError(message) })
}

/** A few big numbers: since when, what got done, who with most, and what it cost. */
function Milestones() {
  const [stats, setStats] = useState<ProfileStats | null>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const ctrl = new AbortController()
    readProfileStats(ctrl.signal).then(
      (s) => { setStats(s); setError('') },
      (e: Error) => { if (e.name !== 'AbortError') setError(e.message) },
    )
    return () => ctrl.abort()
  }, [attempt])
  if (error) {
    return <div className="fx-d-groups"><p className="fx-tower-error" role="alert">{error}</p>
      <button type="button" className="fx-save" onClick={() => setAttempt((n) => n + 1)}>{tr('重試')}</button></div>
  }
  if (!stats) return <p className="fx-empty" role="status">{tr('載入中…')}</p>
  return <MilestoneList stats={stats} />
}

/** Whole days from `since` to `now`, both in Unix seconds, counting the first day. */
export const daysSince = (since: number, now = Date.now() / 1000) => (since > 0 ? Math.max(1, Math.floor((now - since) / 86400) + 1) : 0)

export function MilestoneList({ stats, now }: { stats: ProfileStats; now?: number }) {
  if (!stats.since && !stats.chats && !stats.tasksDone && !stats.usage.calls) return <p className="fx-empty">{tr('還沒有使用紀錄')}</p>
  const p = stats.partner
  return (
    <div className="fx-stats">
      <dl className="fx-stats-sum fx-profile-sum">
        <div><dt>{tr('使用天數')}</dt><dd>{fmtCount(daysSince(stats.since, now))}</dd></div>
        <div><dt>{tr('完成任務')}</dt><dd>{fmtCount(stats.tasksDone)}</dd></div>
        <div><dt>{tr('對話')}</dt><dd>{fmtCount(stats.chats)}</dd></div>
        <div><dt>{tr('你說的話')}</dt><dd>{fmtCount(stats.messages)}</dd></div>
        <div><dt>{tr('Token')}</dt><dd>{fmtCount(stats.usage.tokens)}</dd></div>
        <div><dt>{tr('費用')}</dt><dd>{fmtUsd(stats.usage)}</dd></div>
      </dl>
      {p && (
        <section className="fx-d-group" aria-labelledby="fx-profile-partner">
          <h4 id="fx-profile-partner">{tr('最常合作')}</h4>
          <p className="fx-profile-partner">
            <PixelFace look={p.look} name={p.name} size={36} />
            <b>{p.name}</b>
            <span>{tr('一起 {n} 次', { n: fmtCount(p.count) })}</span>
          </p>
        </section>
      )}
    </div>
  )
}
