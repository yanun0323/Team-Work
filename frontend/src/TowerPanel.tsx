// The power tower's panel: a drawer over the right half of the map, like the airport's. Adding a friend island first,
// then the friend islands, those on this island now first, each with how it is and a way to go to it. Pressing one opens
// its sheet over the upper left of the map, with what it may do on this island and removing it; adding one opens a
// sheet that shows this island's pairing code at once, and takes the other's. Everything here is this computer's own,
// whichever island the map shows.

import { colon, tr } from './core/i18n'
import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type FormEvent, type ReactNode, type RefObject } from 'react'
import { MOCK } from './core/mode'
import { fmtClock, fmtDateTime, keepsEscape } from './core/model'
import { PixelFace } from './core/voxel/PixelFace'
import { lookOf } from './core/profile'
import type { Look } from './core/domain/types'
import { useIsland } from './core/island'
import { holdSheets, useCoversLeft } from './Drawer'
import { BinIcon } from './DrawerDetail'
import {
  approvePairing, clearOutgoing, goTo, inboundOf, isBlocked, leftPeer, pairWith, readTowers, rejectPairing, setPeerInbound,
  startPairing, stopPairing, unblockPeer, unpairPeer,
  type Outgoing, type Pairing, type Peer, type PeerInbound, type PeerStatus, type PeerVisit, type Towers, type Visitor,
} from './core/towers'

/** How often the open panel reads the tower again, in milliseconds. */
export const TOWER_POLL_MS = 3000

const STATUS = {
  checking: '檢查中…', online: '在線', offline: '離線', denied: '對方沒有開放', unpaired: '對方已移除好友', incompatible: '版本不相容',
} as const satisfies Record<PeerStatus, string>

/** The tower as last read, read again every few seconds while the panel is open; `refresh` reads it now. */
export function useTowers(every = TOWER_POLL_MS) {
  const [towers, setTowers] = useState<Towers | null>(null)
  const [error, setError] = useState('')
  const live = useRef(true)
  const refresh = useCallback(async () => {
    try {
      const t = await readTowers()
      if (!live.current) return
      setTowers(t)
      setError('')
    } catch (e) {
      if (live.current) setError((e as Error).message)
    }
  }, [])
  useEffect(() => {
    live.current = true
    void refresh()
    const timer = window.setInterval(() => void refresh(), every)
    return () => {
      live.current = false
      window.clearInterval(timer)
    }
  }, [refresh, every])
  return { towers, error, refresh }
}

/** Which computer to update when two are not compatible: the one with the lower number. */
export function updateWhich(mine: number, theirs: number, name: string) {
  return mine < theirs ? tr('這座島的 Team Work 太舊，請更新') : tr('{name} 的 Team Work 太舊，請對方更新', { name })
}

/** What the sheet over the map shows: a friend island's, or adding one. */
export type TowerSheet = { kind: 'peer'; id: string } | { kind: 'add' }
const sheetKey = (s: TowerSheet | null) => (!s ? '' : s.kind === 'add' ? 'add' : `peer:${s.id}`)

const calm = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

export function TowerPanel({ leaving, onGone, onProfile }: {
  leaving: boolean
  /** Called when the page has turned away. */
  onGone: () => void
  /** Opens the user's profile, where this computer's name is set. */
  onProfile?: () => void
}) {
  const title = useRef<HTMLHeadingElement>(null)
  useEffect(() => title.current?.focus({ preventScroll: true }), [])
  const { towers, error, refresh } = useTowers()
  const here = useIsland((s) => s.island?.id ?? null)

  // the sheet stays for its fade-out once put away; with reduced motion there is none, so it goes at once. Focus goes
  // back to what opened it.
  const [sheet, setSheet] = useState<(TowerSheet & { leaving: boolean }) | null>(null)
  const opener = useRef<HTMLElement | null>(null)
  const putAway = useCallback(() => {
    setSheet((s) => (!s ? s : calm ? null : { ...s, leaving: true }))
    opener.current?.focus({ preventScroll: true })
  }, [])
  const open = (next: TowerSheet) => {
    if (sheet && !sheet.leaving && sheetKey(sheet) === sheetKey(next)) return putAway()
    opener.current = document.activeElement as HTMLElement | null
    setSheet({ ...next, leaving: false })
  }
  const shown = sheet && !sheet.leaving ? sheet : null
  const peer = sheet?.kind === 'peer' ? towers?.peers.find((p) => p.id === sheet.id) : undefined
  // a friend island removed, here or by a refresh, takes its sheet with it
  useEffect(() => {
    if (shown?.kind === 'peer' && towers && !peer) putAway()
  }, [shown, towers, peer, putAway])

  return (
    <>
    <aside id="fx-tower" className={leaving ? 'fx-drawer leaving' : 'fx-drawer'} aria-labelledby="fx-tower-title"
      aria-hidden={leaving || undefined} inert={leaving || undefined}
      onAnimationEnd={(e) => { if (leaving && e.target === e.currentTarget) onGone() }}>
      <span className="fx-tape fx-tape-l" aria-hidden="true" />
      <span className="fx-tape fx-tape-r" aria-hidden="true" />
      <div className="fx-sheet">
        <header className="fx-head fx-head-rule">
          <TowerTitle me={towers?.me ?? null} titleRef={title} onProfile={onProfile} />
        </header>
        <div className="fx-page">
          <TowerBody towers={towers} error={error} refresh={refresh} here={here} open={shown} onOpen={open} />
        </div>
      </div>
    </aside>
    {sheet && towers && (sheet.kind === 'add' || peer) && (
      <SheetFrame key={sheetKey(sheet)} leaving={leaving || sheet.leaving} onBack={putAway}
        onGone={() => setSheet((s) => (s?.leaving ? null : s))}>
        {sheet.kind === 'add'
          ? <AddFriend towers={towers} refresh={refresh} />
          : peer && <PeerSheet peer={peer} visit={towers.visitors.find((v) => v.id === peer.id)} me={towers.me.protocol} refresh={refresh} />}
      </SheetFrame>
    )}
    </>
  )
}

/**
 * The sheet a friend island or adding one opens on, over the upper left of the map like a company's detail sheets: Esc
 * or a click on the map puts it away, and the main screen's top left gives way to it.
 */
function SheetFrame({ leaving, onBack, onGone, children }: { leaving: boolean; onBack: () => void; onGone: () => void; children: ReactNode }) {
  const body = useRef<HTMLDivElement>(null)
  useEffect(() => body.current?.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true }), [])
  useCoversLeft(!leaving)
  useEffect(() => {
    if (leaving) return
    // this runs before the map's own Esc handler, which would close the whole panel
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || keepsEscape(e.target)) return
      e.stopPropagation()
      onBack()
    }
    window.addEventListener('keydown', onKey, true)
    const release = holdSheets(onBack)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      release()
    }
  }, [leaving, onBack])
  return (
    <aside className={`fx-detail${leaving ? ' leaving' : ''}`} role="dialog" aria-labelledby="fx-tower-sheet-title"
      aria-hidden={leaving || undefined} inert={leaving || undefined}
      onAnimationEnd={(e) => { if (leaving && e.target === e.currentTarget) onGone() }}>
      <span className="fx-tape fx-tape-l" aria-hidden="true" />
      <div className="fx-sheet">
        <div className="fx-detail-body" ref={body}>{children}</div>
      </div>
    </aside>
  )
}

/**
 * The panel's title, this computer's name under it, and on the right the link version it connects on: only computers
 * on the same link version can go to each other's islands. The name is the user's, so it opens their profile to change.
 */
export function TowerTitle({ me, titleRef, onProfile }: {
  me: Towers['me'] | null
  titleRef?: RefObject<HTMLHeadingElement | null>
  onProfile?: () => void
}) {
  return (
    <div className="fx-title fx-title-plain">
      <div className="fx-title-text">
        <h1 id="fx-tower-title" ref={titleRef} tabIndex={-1}>{tr('基地台')}</h1>
        {me && <p className="fx-where">{onProfile
          ? <button type="button" className="fx-tower-me" title={tr('在個人檔案修改')} onClick={onProfile}>
            <PixelFace look={lookOf(me)} name={me.name} size={18} />{me.name}
          </button>
          : me.name}</p>}
      </div>
      {me && <p className="fx-tower-version">{tr('連線版本 {n}', { n: me.protocol })}</p>}
    </div>
  )
}

/**
 * The panel's page: adding a friend island, then the friend islands, those on this island now first. Apart from the
 * drawer so tests can render it on its own.
 */
export function TowerBody({ towers, error, refresh, here = null, open = null, onOpen = () => {} }: {
  towers: Towers | null
  error: string
  refresh: () => Promise<void>
  /** The computer whose island is shown, if not this one's. */
  here?: string | null
  /** The sheet open over the map, if any. */
  open?: TowerSheet | null
  onOpen?: (sheet: TowerSheet) => void
}) {
  if (!towers) {
    return error
      ? <div className="fx-d-groups"><p className="fx-tower-error" role="alert">{error}</p>
        <button type="button" className="fx-save" onClick={() => void refresh()}>{tr('重試')}</button></div>
      : <p className="fx-empty" role="status">{tr('載入中…')}</p>
  }
  const visits = new Map(towers.visitors.map((v) => [v.id, v]))
  // sort is stable: otherwise as the backend lists them, by when they were paired
  const peers = [...towers.peers].sort((a, b) => Number(visits.has(b.id)) - Number(visits.has(a.id)))
  return (
    <div className="fx-d-groups fx-tower">
      {MOCK && <p className="fx-pill fx-prereq">{tr('模擬模式不能配對')}</p>}
      {error && <p className="fx-tower-error" role="alert">{error}</p>}
      <button type="button" className="fx-task fx-task-new fx-flow-new fx-hit" aria-expanded={open?.kind === 'add'}
        onClick={() => onOpen({ kind: 'add' })}>{tr('＋ 新增好友小島')}</button>
      {peers.length ? (
        <ul className="fx-list fx-tower-friends" aria-label={tr('好友小島')}>
          {peers.map((p) => (
            <PeerRow key={p.id} peer={p} visit={visits.get(p.id)} me={towers.me.protocol} here={p.id === here} refresh={refresh}
              open={open?.kind === 'peer' && open.id === p.id} onOpen={() => onOpen({ kind: 'peer', id: p.id })} />
          ))}
        </ul>
      ) : (
        <p className="fx-tower-empty">{tr('還沒有好友小島')}</p>
      )}
    </div>
  )
}

/** Runs an action of the tower's, then reads it again; what went wrong is kept to show. */
function useAction(refresh: () => Promise<void>) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await work()
      return true
    } catch (e) {
      setError((e as Error).message)
      return false
    } finally {
      setBusy(false)
      await refresh()
    }
  }
  return { busy, error, setError, run }
}

/** The face of the person at another computer, or a black block with a question mark until it has said how it looks. */
export function PeerFace({ look, name, size = 36 }: { look?: Look; name: string; size?: number }) {
  // hidden from readers: the name beside it says who it is
  return (
    <span className="fx-tower-face" aria-hidden="true">
      {look ? <PixelFace look={look} name={name} size={size} /> : (
        // a thin 5 × 7 question mark, its hook stepping down a pixel at a time, in the middle of an 11 × 11 block, on a soft black rather than pure
        <svg className="fx-tower-unknown" width={size} height={size} viewBox="0 0 11 11" shapeRendering="crispEdges">
          <rect width="11" height="11" fill="#34323d" />
          <path fill="#fff" d="M4 2h3v1H4zM3 3h1v1H3zM7 3h1v2H7zM6 5h1v1H6zM5 6h1v1H5zM5 8h1v1H5z" />
        </svg>
      )}
    </span>
  )
}

/** How a friend island is, in words: on this island since when, online, or why not. */
export function statusOf(peer: Peer, me: number, visit?: Visitor, now = Date.now() / 1000) {
  if (visit) {
    // the panel reads the tower every few seconds, so how long it has stayed keeps up without a clock of its own
    const since = visit.since ? [tr('{time} 登島', { time: timeOf(visit.since) }), stayOf(now - visit.since)] : []
    return [tr('正在我的小島'), ...since].join(' · ')
  }
  if (peer.status === 'online') return tr(STATUS.online)
  if (peer.message) return peer.message
  if (peer.status === 'incompatible' && peer.protocol !== undefined) return `${tr(STATUS.incompatible)}${colon()}${updateWhich(me, peer.protocol, peer.name)}`
  return tr(STATUS[peer.status])
}

function Status({ peer, visit, me }: { peer: Peer; visit?: Visitor; me: number }) {
  return (
    <span className="fx-tower-status" data-status={visit ? 'visiting' : peer.status}>
      <span className="fx-tower-dot" aria-hidden="true" />{statusOf(peer, me, visit)}
    </span>
  )
}

/**
 * A friend island: the row opens its sheet; Go sits at its end, the way it is used most. Go is the page's dark button
 * only while it can be gone to.
 */
function PeerRow({ peer, visit, me, here, refresh, open, onOpen }: {
  peer: Peer; visit?: Visitor; me: number; here: boolean; refresh: () => Promise<void>; open: boolean; onOpen: () => void
}) {
  const nameId = useId()
  const [going, setGoing] = useState(false)
  const [error, setError] = useState('')
  const go = async () => {
    setGoing(true)
    setError('')
    const r = await goTo(peer.id)
    setGoing(false)
    if (!r.ok) {
      setError(r.message || tr('現在不能前往 {name}', { name: peer.name }))
      await refresh()
    }
  }
  return (
    <li className="fx-tower-friend">
      <button type="button" className="fx-row fx-hit fx-tower-row" aria-expanded={open} onClick={onOpen}>
        <PeerFace look={peer.look} name={peer.name} />
        <span className="fx-row-main">
          <b id={nameId}>{peer.name}</b>
          <Status peer={peer} visit={visit} me={me} />
        </span>
      </button>
      {here
        ? <span className="fx-pill fx-tower-here">{tr('目前所在')}</span>
        // not online may be stale: Go checks again before it gives up, so it stays pressable, only quieter
        : <button type="button" className={peer.status === 'online' ? 'fx-save fx-tower-go' : 'fx-save fx-save-quiet fx-tower-go'}
          disabled={going || MOCK} aria-describedby={nameId} onClick={() => void go()}>
          {going ? tr('檢查中…') : tr('前往')}
        </button>}
      {error && <p className="fx-tower-error fx-tower-line-under" role="alert">{error}</p>}
    </li>
  )
}

/** A friend island's sheet: what it may do on this island, a block left from before, its latest visits, and removing it. */
export function PeerSheet({ peer, visit, me, refresh }: { peer: Peer; visit?: Visitor; me: number; refresh: () => Promise<void> }) {
  const { busy, error, run } = useAction(refresh)
  const [asking, setAsking] = useState(false)
  const accessId = useId()
  const remove = () => {
    if (!asking) return setAsking(true)
    setAsking(false)
    void run(async () => {
      await unpairPeer(peer.id)
      leftPeer(peer.id)
    })
  }
  return (
    <>
      <div className="fx-tools">
        <button type="button" className={asking ? 'fx-tool fx-tool-ask fx-hit' : 'fx-tool fx-hit'} disabled={busy}
          onClick={remove} onBlur={() => setAsking(false)} aria-label={asking ? undefined : tr('移除好友')} title={asking ? undefined : tr('移除好友')}>
          {asking ? tr('確定移除好友') : <BinIcon />}
        </button>
      </div>
      <header className="fx-d-head fx-d-who">
        <PeerFace look={peer.look} name={peer.name} size={48} />
        <div>
          <h2 id="fx-tower-sheet-title" tabIndex={-1}>{peer.name}</h2>
          <p className="fx-d-meta"><Status peer={peer} visit={visit} me={me} /></p>
        </div>
      </header>
      {/* one line that reads as a sentence: whether to open my island to it, then how far */}
      <div className="fx-tower-access-row">
        <span id={accessId} className="fx-tower-access-label">{tr('是否對 {name} 開放我的小島', { name: peer.name })}</span>
        <InboundSwitch inbound={inboundOf(peer)} disabled={busy || MOCK} label={accessId}
          onChange={(to) => void run(() => setPeerInbound(peer.id, to))} />
      </div>
      {isBlocked(peer) && (
        <div className="fx-tower-acts">
          <span className="fx-pill">{peer.blockedUntil === -1 ? tr('已封鎖') : tr('封鎖到 {time}', { time: timeOf(peer.blockedUntil ?? 0) })}</span>
          <button type="button" className="fx-tool fx-hit fx-tool-text" disabled={busy || MOCK}
            onClick={() => void run(() => unblockPeer(peer.id))}>{tr('解除封鎖')}</button>
        </div>
      )}
      <Visits visits={peer.visits ?? []} here={visit} />
      {error && <p className="fx-tower-error" role="alert">{error}</p>}
    </>
  )
}

/** A friend island's latest visits to this one: when each came and how long it stayed. */
function Visits({ visits, here }: { visits: PeerVisit[]; here?: Visitor }) {
  const id = useId()
  return (
    <section className="fx-d-group" aria-labelledby={id}>
      <h4 id={id}>{tr('最近登島')}</h4>
      {visits.length ? (
        <ol className="fx-tower-visits">
          {visits.map((v) => (
            <li key={v.since}>
              <time dateTime={new Date(v.since * 1000).toISOString()}>{fmtDateTime(v.since)}</time>
              <span>{visitLength(v, here)}</span>
            </li>
          ))}
        </ol>
      ) : <p className="fx-tower-empty">{tr('還沒有登島紀錄')}</p>}
    </section>
  )
}

/** How long a visit lasted, in words; the one under way says so, and one with no known end shows a dash. */
export function visitLength(v: PeerVisit, here?: Visitor) {
  if (!v.until) return here?.since === v.since ? tr('正在我的小島') : '—'
  const m = Math.floor((v.until - v.since) / 60)
  return m < 1 ? tr('不到 1 分鐘') : minutesOf(m)
}

/** A clock time, for when a block ends or a visitor came. */
const timeOf = fmtClock

const INBOUND: readonly PeerInbound[] = ['off', 'view', 'operate']
const INBOUND_LABELS = { off: '不開放', view: '僅檢視', operate: '可操作' } as const satisfies Record<PeerInbound, string>

/** Whether a friend island may come in at all, and if so only look or work this island too. */
function InboundSwitch({ inbound, disabled, label, onChange }: { inbound: PeerInbound; disabled: boolean; label: string; onChange: (to: PeerInbound) => void }) {
  const name = useId()
  return (
    <div className="fx-switcher fx-tower-access" role="radiogroup" aria-labelledby={label}
      style={{ '--count': INBOUND.length, '--at': INBOUND.indexOf(inbound) } as CSSProperties}>
      <span className="fx-switcher-thumb" aria-hidden="true" />
      {INBOUND.map((a) => (
        <label key={a} className="fx-switcher-option">
          <input type="radio" name={name} checked={a === inbound} disabled={disabled} onChange={() => onChange(a)} />
          <span>{tr(INBOUND_LABELS[a])}</span>
        </label>
      ))}
    </div>
  )
}

/** How long a visitor has been here, in words. */
export function stayOf(seconds: number) {
  const m = Math.floor(seconds / 60)
  return m < 1 ? tr('剛到') : tr('待了 {a}', { a: minutesOf(m) })
}

/** Whole minutes, in hours and minutes once there are an hour's worth. */
const minutesOf = (m: number) => (m < 60 ? tr('{a} 分鐘', { a: m })
  : m % 60 ? tr('{a} 小時 {b} 分鐘', { a: Math.floor(m / 60), b: m % 60 }) : tr('{a} 小時', { a: m / 60 }))

/** Seconds left as m:ss. */
export const clockOf = (seconds: number) => {
  const s = Math.max(0, Math.ceil(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function useSecondsLeft(until: number | undefined) {
  const [now, setNow] = useState(() => Date.now() / 1000)
  useEffect(() => {
    if (until === undefined) return
    const timer = window.setInterval(() => setNow(Date.now() / 1000), 1000)
    return () => window.clearInterval(timer)
  }, [until])
  return until === undefined ? 0 : until - now
}

/**
 * Adding a friend island, on its sheet. Opening it starts waiting with this island's code to hand over, and closing it
 * stops, along with a request this island sent; either side may hand over the code, so there is no side to pick.
 */
function AddFriend({ towers, refresh }: { towers: Towers; refresh: () => Promise<void> }) {
  useEffect(() => {
    if (MOCK) return
    void startPairing().catch(() => {}).finally(() => void refresh())
    return () => {
      void stopPairing().catch(() => {})
      void clearOutgoing().catch(() => {})
    }
  }, [refresh])
  return <AddFriendBody towers={towers} refresh={refresh} />
}

/** The add sheet's page: this island's code, then the other's. Apart from the effects so tests can render it. */
export function AddFriendBody({ towers, refresh }: { towers: Towers; refresh: () => Promise<void> }) {
  const { pairing, outgoing } = towers
  const [friend, setFriend] = useState('')
  const codeId = useId()
  return (
    <>
      <header className="fx-d-head">
        <h2 id="fx-tower-sheet-title" tabIndex={-1}>{tr('新增好友小島')}</h2>
      </header>
      {friend && <p className="fx-tower-done" role="status">{tr('已和 {name} 成為好友', { name: friend })}</p>}
      <section className="fx-d-group" aria-labelledby={codeId}>
        <h4 id={codeId}>{tr('我的配對碼')}</h4>
        {pairing
          ? <Waiting pairing={pairing} me={towers.me.protocol} label={codeId} refresh={refresh} onFriend={setFriend} />
          : <StartWaiting refresh={refresh} />}
      </section>
      <section className="fx-d-group" aria-labelledby="fx-tower-theirs">
        <h4 id="fx-tower-theirs">{tr('或貼上對方的配對碼')}</h4>
        {outgoing ? <Connecting outgoing={outgoing} refresh={refresh} /> : <ConnectForm refresh={refresh} />}
      </section>
    </>
  )
}

/** No code to hand over: before the first is ready, after it ran out or was used, or when making it failed. */
function StartWaiting({ refresh }: { refresh: () => Promise<void> }) {
  const { busy, error, run } = useAction(refresh)
  return (
    <div className="fx-tower-box">
      <button type="button" className="fx-save" disabled={busy || MOCK} onClick={() => void run(startPairing)}>{busy ? tr('準備中…') : tr('產生配對碼')}</button>
      {error && <p className="fx-tower-error" role="alert">{error}</p>}
    </div>
  )
}

/**
 * This island's code to hand over, kept to one line since it is copied rather than read, how long it lasts, and the
 * request when one comes.
 */
function Waiting({ pairing, me, label, refresh, onFriend }: {
  pairing: Pairing; me: number; label: string; refresh: () => Promise<void>; onFriend: (name: string) => void
}) {
  const { busy, error, run } = useAction(refresh)
  const left = useSecondsLeft(pairing.expiresAt)
  const [copied, setCopied] = useState(false)
  const box = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!copied) return
    const t = window.setTimeout(() => setCopied(false), 2000)
    return () => window.clearTimeout(t)
  }, [copied])
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(pairing.address)
      setCopied(true)
    } catch {
      // no clipboard: leave it selected to copy by hand
      box.current?.focus()
      box.current?.select()
    }
  }
  const asked = pairing.request
  const approve = async (id: string, name: string) => {
    if (await run(() => approvePairing(id))) onFriend(name)
  }
  return (
    <div className="fx-tower-box">
      <div className="fx-tower-line">
        <input ref={box} className="fx-control fx-tower-code" readOnly value={pairing.address} spellCheck={false}
          aria-labelledby={label} onFocus={(e) => e.target.select()} />
        <button type="button" className="fx-save" onClick={() => void copy()}>{copied ? tr('已複製') : tr('複製')}</button>
      </div>
      <span className="fx-tower-left" role="timer" aria-live="off">{tr('剩下 {time}', { time: clockOf(left) })}</span>
      {asked && (
        <div className="fx-tower-ask" role="alert">
          <p><b>{tr('{name} 想加你為好友', { name: asked.name })}</b></p>
          {!asked.compatible && <p className="fx-tower-error">{tr('版本不相容')}{colon()}{updateWhich(me, asked.protocol, asked.name)}</p>}
          <div className="fx-settings-file-acts">
            {asked.compatible && <button type="button" className="fx-save" disabled={busy} onClick={() => void approve(asked.id, asked.name)}>{tr('同意')}</button>}
            <button type="button" className="fx-save fx-save-quiet" disabled={busy} onClick={() => void run(() => rejectPairing(asked.id))}>{tr('拒絕')}</button>
          </div>
        </div>
      )}
      {error && <p className="fx-tower-error" role="alert">{error}</p>}
    </div>
  )
}

/** Entering the code another island shows. */
function ConnectForm({ refresh }: { refresh: () => Promise<void> }) {
  const { busy, error, setError, run } = useAction(refresh)
  const [address, setAddress] = useState('')
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const typed = address.trim()
    if (!typed) return setError(tr('請貼上對方的配對碼'))
    void run(async () => {
      await pairWith(typed)
      setAddress('')
    })
  }
  return (
    <div className="fx-tower-box">
      <form className="fx-tower-line" onSubmit={submit} noValidate>
        <input className="fx-control fx-tower-code" value={address} spellCheck={false} autoComplete="off" autoCapitalize="off"
          aria-labelledby="fx-tower-theirs" disabled={MOCK} aria-invalid={!!error || undefined}
          onChange={(e) => { setAddress(e.target.value); if (error) setError('') }} />
        <button type="submit" className="fx-save" disabled={busy || MOCK}>{busy ? tr('連線中…') : tr('加入#button')}</button>
      </form>
      {error && <p className="fx-tower-error" role="alert">{error}</p>}
    </div>
  )
}

/** A request this island sent: connecting, waiting for the other to agree, then how it ended. */
function Connecting({ outgoing, refresh }: { outgoing: Outgoing; refresh: () => Promise<void> }) {
  const { busy, error, run } = useAction(refresh)
  const going = outgoing.state === 'connecting' || outgoing.state === 'waiting'
  return (
    <div className="fx-tower-box">
      {going
        ? <p role="status">{outgoing.state === 'connecting' ? tr('正在連線…')
          : outgoing.name ? tr('等待 {name} 同意…', { name: outgoing.name }) : tr('等待對方同意…')}</p>
        : outgoing.state === 'paired'
          ? <p role="status">{tr('已和 {name} 成為好友', { name: outgoing.name ?? '' })}</p>
          : <p className="fx-tower-error" role="alert">{outgoing.message || tr('配對沒有完成')}</p>}
      <button type="button" className={going ? 'fx-save fx-save-quiet' : 'fx-save'} disabled={busy} onClick={() => void run(clearOutgoing)}>
        {going ? tr('取消') : tr('關閉')}
      </button>
      {error && <p className="fx-tower-error" role="alert">{error}</p>}
    </div>
  )
}
