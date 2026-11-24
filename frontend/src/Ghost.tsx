// What a ghost company shows beyond the usual company file: whose it is, the sheet for one that can't be worked
// from here (its computer out of reach, no longer letting this one in, or the company closed there), and taking it
// off this island, which leaves the company itself as it is.

import { useEffect, useRef, useState } from 'react'
import { tr } from './core/i18n'
import { ghostState, removeGhost, useFeeds } from './core/ghosts'
import type { Ghost } from './core/domain/types'
import { usePeers } from './core/towers'
import { useStore } from './core/store'
import { BuildingIcon } from './Drawer'
import { PeerFace } from './TowerPanel'
import { usePaste } from './paste'
import type { BuildingLook } from './layout'

/** The friend a ghost company belongs to, face and name, in its file's head. */
export function GhostOwner({ peerId }: { peerId: string }) {
  const peer = usePeers((s) => s.peers?.find((p) => p.id === peerId))
  if (!peer) return null
  return (
    <span className="fx-ghost-owner" title={tr('{name} 的公司', { name: peer.name })}>
      <PeerFace look={peer.look} name={peer.name} size={16} />
      <span>{peer.name}</span>
    </span>
  )
}

/** Takes a ghost company off this island, on a second press; the company on its own computer stays. */
export function RemoveGhost({ id }: { id: string }) {
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const remove = async () => {
    if (!asking) return setAsking(true)
    setBusy(true)
    try {
      await removeGhost(id)
      // the map lets the file go once the ghost company is gone from it
      useStore.setState((s) => {
        const w = s.home ?? s.world
        if (w.ghosts) w.ghosts = Object.fromEntries(Object.entries(w.ghosts).filter(([g]) => g !== id))
      })
    } catch (e) {
      useStore.getState().setFailure((e as Error).message)
      setBusy(false)
      setAsking(false)
    }
  }
  return (
    <button type="button" className={asking ? 'fx-save fx-danger fx-tool-ask' : 'fx-save fx-danger'} disabled={busy}
      onClick={() => void remove()} onBlur={() => setAsking(false)}>
      {asking ? tr('確定移除投影') : tr('移除投影')}
    </button>
  )
}

/** Why a ghost company can't be worked from here, ready to show. */
export function whyNot(state: ReturnType<typeof ghostState>, peer: { name: string; message?: string } | undefined) {
  if (!peer) return tr('已經和這座好友小島解除配對')
  if (state === 'gone') return tr('{name} 已經關閉這間公司', { name: peer.name })
  if (state === 'lost') return peer.message || tr('{name} 沒有對你開放小島', { name: peer.name })
  return tr('連不上 {name}，對方打開 Team Work 後就會恢復', { name: peer.name })
}

/** The sheet of a ghost company that can't be worked from here: whose it is, why, and taking it off the island. */
export function GhostDrawer({ ghost, look, leaving, onGone }: { ghost: Ghost; look: BuildingLook; leaving: boolean; onGone: () => void }) {
  const paste = usePaste(leaving, onGone)
  const title = useRef<HTMLHeadingElement>(null)
  useEffect(() => title.current?.focus({ preventScroll: true }), [ghost.id])
  const peers = usePeers((s) => s.peers)
  const feed = useFeeds((f) => f[ghost.peerId])
  const state = ghostState(ghost, peers, feed)
  const peer = peers?.find((p) => p.id === ghost.peerId)
  return (
    <aside className={leaving ? 'fx-drawer leaving' : 'fx-drawer'} aria-labelledby="fx-ghost-title"
      aria-hidden={leaving || undefined} inert={leaving || undefined} {...paste}>
      <span className="fx-tape fx-tape-l" aria-hidden="true" />
      <span className="fx-tape fx-tape-r" aria-hidden="true" />
      <div className="fx-sheet">
        <header className="fx-head fx-head-rule">
          <div className="fx-title">
            <BuildingIcon look={look} />
            <div className="fx-title-text">
              <h1 id="fx-ghost-title" ref={title} tabIndex={-1}>{ghost.name}</h1>
              <p className="fx-where"><GhostOwner peerId={ghost.peerId} /></p>
            </div>
          </div>
        </header>
        <div className="fx-page fx-d-form">
          <p className="fx-empty" role="status">{whyNot(state, peer)}</p>
          <div className="fx-fields">
            <RemoveGhost id={ghost.id} />
          </div>
        </div>
      </div>
    </aside>
  )
}
