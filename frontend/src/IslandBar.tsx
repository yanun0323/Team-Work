// Which computer's island the screen shows, whenever it is another's: a slip in the map's lower corner, over the
// drawers too, with the way home. Back home on its own (the other computer no longer allows it, say), it says why
// once. On this computer's own island, with nothing to say, it shows nothing. While a sheet is open it folds to a
// small square with an arrow, and a red warning while the connection is lost (fusion.css); it slides open again
// under the pointer or the keyboard.

import { tr } from './core/i18n'
import { useIsland, type Island } from './core/island'
import { useStore } from './core/store'
import { goHome } from './core/towers'

export function IslandBar() {
  const island = useIsland((s) => s.island)
  const notice = useIsland((s) => s.notice)
  const arriving = useStore((s) => s.arriving)
  const offline = useStore((s) => s.offline)
  return <IslandSlip island={island} notice={notice} arriving={arriving} offline={offline} />
}

/** The slip itself, from what it says. */
export function IslandSlip({ island, notice, arriving, offline }: { island: Island | null; notice: string; arriving: boolean; offline: boolean }) {
  if (!island) {
    if (!notice) return null
    return (
      <div className="fx-island fx-tag" role="alert">
        <span className="fx-island-text">{notice}</span>
        <button type="button" className="fx-tool fx-hit" aria-label={tr('關閉')} title={tr('關閉')} onClick={() => useIsland.setState({ notice: '' })}>✕</button>
      </div>
    )
  }
  const state = arriving ? tr('載入中…') : offline ? tr('和 {name} 的連線中斷，正在重新連線', { name: island.name }) : ''
  return (
    <div className="fx-island fx-tag" role="region" aria-label={tr('目前所在的島')}>
      <span className="fx-island-fold" aria-hidden="true">
        {offline && !arriving && (
          <svg className="fx-island-alert" viewBox="0 0 16 16" width="16" height="16">
            <circle cx="8" cy="8" r="6.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <path d="M8 4.6v4.2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            <circle cx="8" cy="11.2" r="1.05" fill="currentColor" />
          </svg>
        )}
        <svg className="fx-island-arrow" viewBox="0 0 16 16" width="16" height="16">
          <path d="M3 8h9M8.5 4.5 12 8l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <span className="fx-island-text">
        <span className="fx-island-where">{tr('正在操作：{name}', { name: island.name })}</span>
        <span className="fx-island-state" role="status">{state}</span>
      </span>
      <button type="button" className="fx-save" onClick={() => goHome()}>{tr('回到自己的島')}</button>
    </div>
  )
}
