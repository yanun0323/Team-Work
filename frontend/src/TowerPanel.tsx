// The power tower's panel: a drawer over the right half of the map, like the airport's. The computers this one is
// paired with, each with whether it may work this island and a way to go to its island; below, pairing a new one,
// either by waiting with an address to hand over, or by entering the address another computer shows.
// Everything here is this computer's own, whichever island the map shows.

import { colon, tr } from './core/i18n'
import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { MOCK } from './core/mode'
import { useIsland } from './core/island'
import {
  allowPeer, approvePairing, clearOutgoing, goTo, leftPeer, pairWith, readTowers, rejectPairing, startPairing, stopPairing, unpairPeer,
  type Outgoing, type Pairing, type Peer, type PeerStatus, type Towers,
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
              <h1 id="fx-tower-title" ref={title} tabIndex={-1}>{tr('電塔')}</h1>
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

/** The panel's page: the paired computers, then pairing. Apart from the drawer so tests can render it on its own. */
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
      <section className="fx-d-group" aria-labelledby="fx-tower-peers">
        <h4 id="fx-tower-peers">{tr('已配對的電腦')}</h4>
        {towers.peers.length ? (
          <ul className="fx-list fx-tower-peers">
            {towers.peers.map((p) => <PeerRow key={p.id} peer={p} me={towers.me.protocol} here={p.id === here} refresh={refresh} />)}
          </ul>
        ) : (
          <p className="fx-tower-empty">{tr('還沒有配對的電腦。在要被操作的那台按「等待配對」，再把位址貼到這台的「連到別台」。')}</p>
        )}
      </section>
      <WaitSection pairing={towers.pairing} me={towers.me.protocol} refresh={refresh} />
      <ConnectSection outgoing={towers.outgoing} refresh={refresh} />
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
      <div className="fx-tower-acts">
        <label className="fx-tower-allow">
          <input type="checkbox" className="fx-tick" checked={peer.allowInbound} disabled={busy || MOCK} aria-describedby={nameId}
            onChange={(e) => { const on = e.target.checked; void run(() => allowPeer(peer.id, on)) }} />
          {tr('允許它操作我')}
        </label>
        {here
          ? <span className="fx-pill fx-tower-here">{tr('目前所在')}</span>
          : <button type="button" className="fx-save" disabled={going || MOCK} aria-describedby={nameId} onClick={() => void go()}>
            {going ? tr('檢查中…') : tr('前往')}
          </button>}
        <button type="button" className={asking ? 'fx-tool fx-tool-ask fx-hit' : 'fx-tool fx-hit fx-tower-unpair'} disabled={busy}
          aria-describedby={nameId} onClick={unpair} onBlur={() => setAsking(false)}>
          {asking ? tr('確定解除配對') : tr('解除配對')}
        </button>
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

/** Waiting for another computer to pair: the address to hand over, how long it lasts, and the request when one comes. */
function WaitSection({ pairing, me, refresh }: { pairing: Pairing | null; me: number; refresh: () => Promise<void> }) {
  const { busy, error, run } = useAction(refresh)
  const left = useSecondsLeft(pairing?.expiresAt)
  const [copied, setCopied] = useState(false)
  const box = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (!copied) return
    const t = window.setTimeout(() => setCopied(false), 2000)
    return () => window.clearTimeout(t)
  }, [copied])
  const copy = async () => {
    if (!pairing) return
    try {
      await navigator.clipboard.writeText(pairing.address)
      setCopied(true)
    } catch {
      // no clipboard: leave it selected to copy by hand
      box.current?.select()
    }
  }
  const asked = pairing?.request
  return (
    <section className="fx-d-group" aria-labelledby="fx-tower-wait">
      <h4 id="fx-tower-wait">{tr('等待配對')}</h4>
      {!pairing ? (
        <div className="fx-settings-file-acts">
          <button type="button" className="fx-save" disabled={busy || MOCK} onClick={() => void run(startPairing)}>{busy ? tr('準備中…') : tr('等待配對')}</button>
        </div>
      ) : (
        <div className="fx-tower-box">
          <label className="fx-tower-address">
            <span>{tr('把這串位址貼到要操作這台的電腦')}</span>
            <textarea ref={box} className="fx-control" readOnly rows={3} value={pairing.address} spellCheck={false} onFocus={(e) => e.target.select()} />
          </label>
          <div className="fx-settings-file-acts">
            <button type="button" className="fx-save" onClick={() => void copy()}>{copied ? tr('已複製') : tr('複製')}</button>
            <button type="button" className="fx-save fx-save-quiet" disabled={busy} onClick={() => void run(stopPairing)}>{tr('停止等待')}</button>
            <span className="fx-tower-left" role="timer" aria-live="off">{tr('剩下 {time}', { time: clockOf(left) })}</span>
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
        </div>
      )}
      {error && <p className="fx-tower-error" role="alert">{error}</p>}
    </section>
  )
}

/** Entering the address another computer shows, and how that goes. */
function ConnectSection({ outgoing, refresh }: { outgoing: Outgoing | null; refresh: () => Promise<void> }) {
  const { busy, error, setError, run } = useAction(refresh)
  const [address, setAddress] = useState('')
  const fieldId = useId()
  const submit = (e?: FormEvent) => {
    e?.preventDefault()
    const typed = address.trim()
    if (!typed) return setError(tr('請貼上對方的配對位址'))
    void run(async () => {
      await pairWith(typed)
      setAddress('')
    })
  }
  const going = outgoing && (outgoing.state === 'connecting' || outgoing.state === 'waiting')
  return (
    <section className="fx-d-group" aria-labelledby="fx-tower-connect">
      <h4 id="fx-tower-connect">{tr('連到別台')}</h4>
      {going ? (
        <div className="fx-tower-box" role="status">
          <p>{outgoing.state === 'connecting' ? tr('正在連線…')
            : outgoing.name ? tr('等待 {name} 同意…', { name: outgoing.name }) : tr('等待對方同意…')}</p>
          <div className="fx-settings-file-acts">
            <button type="button" className="fx-save fx-save-quiet" disabled={busy} onClick={() => void run(clearOutgoing)}>{tr('取消')}</button>
          </div>
        </div>
      ) : outgoing ? (
        <div className="fx-tower-box">
          {outgoing.state === 'paired'
            ? <p role="status">{tr('已和 {name} 配對', { name: outgoing.name ?? '' })}</p>
            : <p className="fx-tower-error" role="alert">{outgoing.message || tr('配對沒有完成')}</p>}
          <div className="fx-settings-file-acts">
            <button type="button" className="fx-save" disabled={busy} onClick={() => void run(clearOutgoing)}>{tr('關閉')}</button>
          </div>
        </div>
      ) : (
        <form className="fx-tower-form" onSubmit={submit} noValidate>
          <label htmlFor={fieldId} className="fx-sr">{tr('對方的配對位址')}</label>
          <textarea id={fieldId} className="fx-control" rows={2} value={address} spellCheck={false} autoComplete="off" autoCapitalize="off"
            placeholder={tr('貼上對方的配對位址')} disabled={MOCK} aria-invalid={!!error || undefined}
            onChange={(e) => { setAddress(e.target.value); if (error) setError('') }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit() } }} />
          <button type="submit" className="fx-save" disabled={busy || MOCK}>{busy ? tr('連線中…') : tr('連線#button')}</button>
        </form>
      )}
      {error && <p className="fx-tower-error" role="alert">{error}</p>}
    </section>
  )
}
