// The power tower's panel: a drawer over the right half of the map, like the airport's. The computers this one is
// paired with, each with a way to go to its island and whether it may work this one; below, pairing a new one: pick
// which side this computer takes, then wait with an address to hand over, or enter the address another one shows.
// Everything here is this computer's own, whichever island the map shows.

import { colon, tr } from './core/i18n'
import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type FormEvent } from 'react'
import { MOCK } from './core/mode'
import { useIsland } from './core/island'
import { useStore } from './core/store'
import {
  allowPeer, approvePairing, blockPeer, clearOutgoing, goTo, isBlocked, kickPeer, leftPeer, pairWith, readTowers, rejectPairing, setPeerAccess, setProfile,
  startPairing, stopPairing, unblockPeer, unpairPeer,
  type Outgoing, type Pairing, type Peer, type PeerAccess, type PeerStatus, type Towers, type Visitor,
} from './core/towers'

/** How often the open panel reads the tower again, in milliseconds. */
export const TOWER_POLL_MS = 3000

const STATUS = {
  checking: '檢查中…', online: '在線', offline: '離線', denied: '對方沒有允許', unpaired: '對方已解除配對', incompatible: '版本不相容',
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
  return mine < theirs ? tr('這台的 Team Work 太舊，請更新這台') : tr('{name} 的 Team Work 太舊，請更新那台', { name })
}

export function TowerPanel({ leaving, onGone }: {
  leaving: boolean
  /** Called when the page has turned away. */
  onGone: () => void
}) {
  const title = useRef<HTMLHeadingElement>(null)
  useEffect(() => title.current?.focus({ preventScroll: true }), [])
  const { towers, error, refresh } = useTowers()
  const here = useIsland((s) => s.island?.id ?? null)
  return (
    <aside id="fx-tower" className={leaving ? 'fx-drawer leaving' : 'fx-drawer'} aria-labelledby="fx-tower-title"
      aria-hidden={leaving || undefined} inert={leaving || undefined}
      onAnimationEnd={(e) => { if (leaving && e.target === e.currentTarget) onGone() }}>
      <span className="fx-tape fx-tape-l" aria-hidden="true" />
      <span className="fx-tape fx-tape-r" aria-hidden="true" />
      <div className="fx-sheet">
        <header className="fx-head fx-head-rule">
          <div className="fx-title fx-title-plain">
            <div className="fx-title-text">
              <h1 id="fx-tower-title" ref={title} tabIndex={-1}>{tr('基地台')}</h1>
              {towers && <p className="fx-where">{towers.me.name}</p>}
            </div>
          </div>
        </header>
        <div className="fx-page">
          <TowerBody towers={towers} error={error} refresh={refresh} here={here} />
        </div>
      </div>
    </aside>
  )
}

/** The panel's page: the paired computers, then pairing a new one. Apart from the drawer so tests can render it on its own. */
export function TowerBody({ towers, error, refresh, here = null }: {
  towers: Towers | null
  error: string
  refresh: () => Promise<void>
  /** The computer whose island is shown, if not this one's. */
  here?: string | null
}) {
  if (!towers) {
    return error
      ? <div className="fx-d-groups"><p className="fx-tower-error" role="alert">{error}</p>
        <button type="button" className="fx-save" onClick={() => void refresh()}>{tr('重試')}</button></div>
      : <p className="fx-empty" role="status">{tr('載入中…')}</p>
  }
  return (
    <div className="fx-d-groups fx-tower">
      {MOCK && <p className="fx-pill fx-prereq">{tr('模擬模式不能配對')}</p>}
      {error && <p className="fx-tower-error" role="alert">{error}</p>}
      <ProfileSection name={towers.me.name} protocol={towers.me.protocol} refresh={refresh} />
      <VisitorsSection visitors={towers.visitors} home={here === null} refresh={refresh} />
      <section className="fx-d-group" aria-labelledby="fx-tower-peers">
        <h4 id="fx-tower-peers">{tr('已配對的電腦')}</h4>
        {towers.peers.length ? (
          <ul className="fx-list fx-tower-peers">
            {towers.peers.map((p) => <PeerRow key={p.id} peer={p} me={towers.me.protocol} here={p.id === here} refresh={refresh} />)}
          </ul>
        ) : (
          <p className="fx-tower-empty">{tr('還沒有配對的電腦')}</p>
        )}
      </section>
      <PairSection towers={towers} refresh={refresh} />
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
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
      await refresh()
    }
  }
  return { busy, error, setError, run }
}

/**
 * A paired computer: its name and how it is on the first line, with Go at the end, the way it is used most; the switch
 * that lets it work this one and unpairing on the second. Go is the page's dark button only while it can be gone to.
 */
function PeerRow({ peer, me, here, refresh }: { peer: Peer; me: number; here: boolean; refresh: () => Promise<void> }) {
  const nameId = useId()
  const { busy, error, setError, run } = useAction(refresh)
  const [going, setGoing] = useState(false)
  const [asking, setAsking] = useState(false)
  const status = peer.status === 'online' ? tr(STATUS.online)
    : peer.message || (peer.status === 'incompatible' && peer.protocol !== undefined ? `${tr(STATUS.incompatible)}${colon()}${updateWhich(me, peer.protocol, peer.name)}` : tr(STATUS[peer.status]))
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
  const unpair = () => {
    if (!asking) return setAsking(true)
    setAsking(false)
    void run(async () => {
      await unpairPeer(peer.id)
      leftPeer(peer.id)
    })
  }
  return (
    <li className="fx-tower-peer">
      <div className="fx-row-main">
        <b id={nameId}>{peer.name}</b>
        <span className="fx-tower-status" data-status={peer.status}>
          <span className="fx-tower-dot" aria-hidden="true" />{status}
        </span>
      </div>
      {here
        ? <span className="fx-pill fx-tower-here">{tr('目前所在')}</span>
        // not online may be stale: Go checks again before it gives up, so it stays pressable, only quieter
        : <button type="button" className={peer.status === 'online' ? 'fx-save fx-tower-go' : 'fx-save fx-save-quiet fx-tower-go'}
          disabled={going || MOCK} aria-describedby={nameId} onClick={() => void go()}>
          {going ? tr('檢查中…') : tr('前往')}
        </button>}
      <div className="fx-tower-acts">
        <label className="fx-tower-allow">
          <input type="checkbox" className="fx-tick" checked={peer.allowInbound} disabled={busy || MOCK} aria-describedby={nameId}
            onChange={(e) => { const on = e.target.checked; void run(() => allowPeer(peer.id, on)) }} />
          {tr('允許它操作我')}
        </label>
        {peer.allowInbound && <AccessSwitch access={peer.access} disabled={busy || MOCK} label={nameId}
          onChange={(a) => void run(() => setPeerAccess(peer.id, a))} />}
        <button type="button" className={asking ? 'fx-tool fx-tool-ask fx-hit' : 'fx-tool fx-hit fx-tower-unpair'} disabled={busy}
          aria-describedby={nameId} onClick={unpair} onBlur={() => setAsking(false)}>
          {asking ? tr('確定解除配對') : tr('解除配對')}
        </button>
      </div>
      {isBlocked(peer) && (
        <div className="fx-tower-acts">
          <span className="fx-pill">{peer.blockedUntil === -1 ? tr('已封鎖') : tr('封鎖到 {time}', { time: timeOf(peer.blockedUntil ?? 0) })}</span>
          <button type="button" className="fx-tool fx-hit fx-tool-text" disabled={busy || MOCK} aria-describedby={nameId}
            onClick={() => void run(() => unblockPeer(peer.id))}>{tr('解除封鎖')}</button>
        </div>
      )}
      {error && <p className="fx-tower-error" role="alert">{error}</p>}
    </li>
  )
}

/** A clock time, for when a block ends. */
const timeOf = (unix: number) => new Date(unix * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

const ACCESS: readonly PeerAccess[] = ['view', 'operate']
const ACCESS_LABELS = { view: '檢視', operate: '操作#access' } as const satisfies Record<PeerAccess, string>

/** Whether a computer let in may only look, or work this island too. */
function AccessSwitch({ access, disabled, label, onChange }: { access: PeerAccess; disabled: boolean; label: string; onChange: (a: PeerAccess) => void }) {
  const name = useId()
  return (
    <div className="fx-switcher fx-tower-access" role="radiogroup" aria-labelledby={label}
      style={{ '--count': ACCESS.length, '--at': Math.max(0, ACCESS.indexOf(access)) } as CSSProperties}>
      <span className="fx-switcher-thumb" aria-hidden="true" />
      {ACCESS.map((a) => (
        <label key={a} className="fx-switcher-option">
          <input type="radio" name={name} checked={a === access} disabled={disabled} onChange={() => onChange(a)} />
          <span>{tr(ACCESS_LABELS[a])}</span>
        </label>
      ))}
    </div>
  )
}

/** This computer's name, as other towers show it. */
function ProfileSection({ name, protocol, refresh }: { name: string; protocol: number; refresh: () => Promise<void> }) {
  const { busy, error, setError, run } = useAction(refresh)
  const [draft, setDraft] = useState(name)
  const fieldId = useId()
  // a rename saved elsewhere shows once nothing is being typed over it
  const [shown, setShown] = useState(name)
  if (name !== shown) {
    setShown(name)
    if (draft === shown) setDraft(name)
  }
  const typed = draft.trim()
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!typed) return setError(tr('請輸入名稱'))
    void run(() => setProfile(typed))
  }
  return (
    <section className="fx-d-group" aria-labelledby="fx-tower-me">
      <h4 id="fx-tower-me"><label htmlFor={fieldId}>{tr('這台的名稱')}</label></h4>
      <form className="fx-tower-line" onSubmit={submit} noValidate>
        <input id={fieldId} className="fx-control" value={draft} maxLength={40} autoComplete="off" disabled={MOCK}
          aria-invalid={!!error || undefined} onChange={(e) => { setDraft(e.target.value); if (error) setError('') }} />
        <button type="submit" className="fx-save" disabled={busy || MOCK || typed === name}>{busy ? tr('儲存中…') : tr('儲存')}</button>
      </form>
      {/* only computers on the same link version can go to each other's islands */}
      <p className="fx-tower-hint">{tr('連線版本 {n}', { n: protocol })}</p>
      {error && <p className="fx-tower-error" role="alert">{error}</p>}
    </section>
  )
}

/** The paired computers on this island now: where each is, and sending it away. */
function VisitorsSection({ visitors, home, refresh }: { visitors: Visitor[]; home: boolean; refresh: () => Promise<void> }) {
  return (
    <section className="fx-d-group" aria-labelledby="fx-tower-visitors">
      <h4 id="fx-tower-visitors">{tr('正在這座島上')}</h4>
      {visitors.length
        ? <ul className="fx-list fx-tower-peers">{visitors.map((v) => <VisitorRow key={v.id} visitor={v} home={home} refresh={refresh} />)}</ul>
        : <p className="fx-tower-empty">{tr('目前沒有其他電腦')}</p>}
    </section>
  )
}

function VisitorRow({ visitor, home, refresh }: { visitor: Visitor; home: boolean; refresh: () => Promise<void> }) {
  const nameId = useId()
  const { busy, error, run } = useAction(refresh)
  const teams = useStore((s) => s.world.teams)
  // the places are this island's: named only while it is the one shown
  const places = home ? visitor.places.map((p) => (p === 'airport' ? tr('機場') : teams[p.slice(5)]?.name)).filter(Boolean).join(', ') : ''
  return (
    <li className="fx-tower-peer">
      <div className="fx-row-main">
        <b id={nameId}>{visitor.name}</b>
        {places && <span className="fx-tower-status">{places}</span>}
      </div>
      <div className="fx-tower-acts">
        <button type="button" className="fx-tool fx-hit fx-tool-text" disabled={busy || MOCK} aria-describedby={nameId}
          onClick={() => void run(() => kickPeer(visitor.id))}>{tr('踢出')}</button>
        <button type="button" className="fx-tool fx-hit fx-tool-text" disabled={busy || MOCK} aria-describedby={nameId}
          onClick={() => void run(() => blockPeer(visitor.id, 'hour'))}>{tr('封鎖 1 小時')}</button>
        <button type="button" className="fx-tool fx-hit fx-tool-text" disabled={busy || MOCK} aria-describedby={nameId}
          onClick={() => void run(() => blockPeer(visitor.id, 'manual'))}>{tr('封鎖')}</button>
      </div>
      {error && <p className="fx-tower-error" role="alert">{error}</p>}
    </li>
  )
}

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

/** Which side of a new pairing this computer takes: worked by the other, or working it. */
export type PairRole = 'wait' | 'connect'
const ROLES: readonly PairRole[] = ['wait', 'connect']
const ROLE_LABELS = { wait: '讓別台操作這台', connect: '操作別台' } as const satisfies Record<PairRole, string>

/**
 * Pairing a new computer. While nothing is under way: which side this computer takes, then the one action for it.
 * Once waiting or connecting, how that goes, whichever side is picked, so a request that comes is never out of sight;
 * stopping or closing brings the choice back.
 */
function PairSection({ towers, refresh }: { towers: Towers; refresh: () => Promise<void> }) {
  const { pairing, outgoing } = towers
  const [role, setRole] = useState<PairRole>(outgoing ? 'connect' : 'wait')
  const roleName = useId()
  return (
    <section className="fx-d-group" aria-labelledby="fx-tower-pair">
      <h4 id="fx-tower-pair">{tr('配對新電腦')}</h4>
      {pairing || outgoing ? (
        <div className="fx-tower-under-way">
          {pairing && <Waiting pairing={pairing} me={towers.me.protocol} refresh={refresh} />}
          {outgoing && <Connecting outgoing={outgoing} refresh={refresh} />}
        </div>
      ) : (
        <div className="fx-tower-start">
          <div className="fx-switcher fx-tower-roles" role="radiogroup" aria-labelledby="fx-tower-pair"
            style={{ '--count': ROLES.length, '--at': ROLES.indexOf(role) } as CSSProperties}>
            <span className="fx-switcher-thumb" aria-hidden="true" />
            {ROLES.map((r) => (
              <label key={r} className="fx-switcher-option">
                <input type="radio" name={roleName} checked={r === role} onChange={() => setRole(r)} />
                <span>{tr(ROLE_LABELS[r])}</span>
              </label>
            ))}
          </div>
          {role === 'wait' ? <StartWaiting refresh={refresh} /> : <ConnectForm refresh={refresh} />}
        </div>
      )}
    </section>
  )
}

function StartWaiting({ refresh }: { refresh: () => Promise<void> }) {
  const { busy, error, run } = useAction(refresh)
  return (
    <>
      <button type="button" className="fx-save" disabled={busy || MOCK} onClick={() => void run(startPairing)}>{busy ? tr('準備中…') : tr('等待配對')}</button>
      {error && <p className="fx-tower-error" role="alert">{error}</p>}
    </>
  )
}

/**
 * Waiting for another computer to pair: the address to hand over, kept to one line since it is copied rather than
 * read, how long it lasts, and the request when one comes.
 */
function Waiting({ pairing, me, refresh }: { pairing: Pairing; me: number; refresh: () => Promise<void> }) {
  const { busy, error, run } = useAction(refresh)
  const left = useSecondsLeft(pairing.expiresAt)
  const [copied, setCopied] = useState(false)
  const box = useRef<HTMLInputElement>(null)
  const boxId = useId()
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
  return (
    <div className="fx-tower-box">
      <label htmlFor={boxId} className="fx-tower-hint">{tr('在另一台選「操作別台」，貼上這串位址')}</label>
      <div className="fx-tower-line">
        <input id={boxId} ref={box} className="fx-control fx-tower-code" readOnly value={pairing.address} spellCheck={false}
          onFocus={(e) => e.target.select()} />
        <button type="button" className="fx-save" onClick={() => void copy()}>{copied ? tr('已複製') : tr('複製')}</button>
      </div>
      <div className="fx-tower-meta">
        <span className="fx-tower-left" role="timer" aria-live="off">{tr('剩下 {time}', { time: clockOf(left) })}</span>
        <button type="button" className="fx-tool fx-hit fx-tool-text" disabled={busy} onClick={() => void run(stopPairing)}>{tr('停止等待')}</button>
      </div>
      {asked && (
        <div className="fx-tower-ask" role="alert">
          <p><b>{tr('{name} 想要配對', { name: asked.name })}</b></p>
          {!asked.compatible && <p className="fx-tower-error">{tr('版本不相容')}{colon()}{updateWhich(me, asked.protocol, asked.name)}</p>}
          <div className="fx-settings-file-acts">
            {asked.compatible && <button type="button" className="fx-save" disabled={busy} onClick={() => void run(() => approvePairing(asked.id))}>{tr('同意')}</button>}
            <button type="button" className="fx-save fx-save-quiet" disabled={busy} onClick={() => void run(() => rejectPairing(asked.id))}>{tr('拒絕')}</button>
          </div>
        </div>
      )}
      {error && <p className="fx-tower-error" role="alert">{error}</p>}
    </div>
  )
}

/** Entering the address another computer shows. */
function ConnectForm({ refresh }: { refresh: () => Promise<void> }) {
  const { busy, error, setError, run } = useAction(refresh)
  const [address, setAddress] = useState('')
  const fieldId = useId()
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const typed = address.trim()
    if (!typed) return setError(tr('請貼上對方的配對位址'))
    void run(async () => {
      await pairWith(typed)
      setAddress('')
    })
  }
  return (
    <>
      <form className="fx-tower-line" onSubmit={submit} noValidate>
        <label htmlFor={fieldId} className="fx-sr">{tr('對方的配對位址')}</label>
        <input id={fieldId} className="fx-control fx-tower-code" value={address} spellCheck={false} autoComplete="off" autoCapitalize="off"
          placeholder={tr('貼上對方的配對位址')} disabled={MOCK} aria-invalid={!!error || undefined}
          onChange={(e) => { setAddress(e.target.value); if (error) setError('') }} />
        <button type="submit" className="fx-save" disabled={busy || MOCK}>{busy ? tr('連線中…') : tr('連線#button')}</button>
      </form>
      {error && <p className="fx-tower-error" role="alert">{error}</p>}
    </>
  )
}

/** A pairing this computer asked for: connecting, waiting for the other to agree, then how it ended. */
function Connecting({ outgoing, refresh }: { outgoing: Outgoing; refresh: () => Promise<void> }) {
  const { busy, error, run } = useAction(refresh)
  const going = outgoing.state === 'connecting' || outgoing.state === 'waiting'
  return (
    <div className="fx-tower-box">
      {going
        ? <p role="status">{outgoing.state === 'connecting' ? tr('正在連線…')
          : outgoing.name ? tr('等待 {name} 同意…', { name: outgoing.name }) : tr('等待對方同意…')}</p>
        : outgoing.state === 'paired'
          ? <p role="status">{tr('已和 {name} 配對', { name: outgoing.name ?? '' })}</p>
          : <p className="fx-tower-error" role="alert">{outgoing.message || tr('配對沒有完成')}</p>}
      <button type="button" className={going ? 'fx-save fx-save-quiet' : 'fx-save'} disabled={busy} onClick={() => void run(clearOutgoing)}>
        {going ? tr('取消') : tr('關閉')}
      </button>
      {error && <p className="fx-tower-error" role="alert">{error}</p>}
    </div>
  )
}
