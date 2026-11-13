// The staffing agency's file (移民署): a drawer over the right half of the map, like a company's, holding only its
// employees, whom every company on the island can pick to work. They are hired here, and moved in from a company or
// out to one from each one's sheet. It has no folder, tasks or settings: it is the island's own, not a company.

import { useEffect, useRef } from 'react'
import { tr } from './core/i18n'
import { useStore } from './core/store'
import { STAFFING_ID } from './core/domain/types'
import { itemKey } from './DrawerDetail'
import { TabBody } from './DrawerTabs'
import { SheetStack, useMapClickSheets, useSheets } from './Drawer'

/** The rotunda's stamp: a dome on columns, front on. */
export function StaffingIcon() {
  return (
    <svg className="fx-icon" viewBox="0 0 16 16" aria-hidden="true" shapeRendering="crispEdges">
      <rect x={5} y={1} width={6} height={1} fill="#4a8a78" />
      <rect x={3} y={2} width={10} height={2} fill="#5fa491" />
      <rect x={2} y={4} width={12} height={1} fill="#e0b545" />
      <rect x={1} y={5} width={14} height={1} fill="#e3dccd" />
      {[2, 5, 9, 12].map((x) => <rect key={x} x={x} y={6} width={2} height={7} fill="#e3dccd" />)}
      <rect x={4} y={6} width={1} height={7} fill="#f3ead6" />
      <rect x={11} y={6} width={1} height={7} fill="#f3ead6" />
      <rect x={7} y={9} width={2} height={4} fill="#5a4636" />
      <rect x={0} y={13} width={16} height={2} fill="#c8bfae" />
    </svg>
  )
}

export function StaffingPanel({ leaving, onGone }: {
  leaving: boolean
  /** Called when the page has turned away. */
  onGone: () => void
}) {
  const title = useRef<HTMLHeadingElement>(null)
  const loaded = useStore((s) => s.loaded)
  const sheets = useSheets()
  useMapClickSheets(sheets, leaving)
  useEffect(() => title.current?.focus({ preventScroll: true }), [])
  const base = sheets.layers[0]
  return (
    <>
      <aside id="fx-staffing" className={leaving ? 'fx-drawer leaving' : 'fx-drawer'} aria-labelledby="fx-staffing-title"
        aria-hidden={leaving || undefined} inert={leaving || undefined}
        onAnimationEnd={(e) => { if (leaving && e.target === e.currentTarget) onGone() }}>
        <span className="fx-tape fx-tape-l" aria-hidden="true" />
        <span className="fx-tape fx-tape-r" aria-hidden="true" />
        <div className="fx-sheet">
          <header className="fx-head fx-head-rule">
            <div className="fx-title">
              <StaffingIcon />
              <div className="fx-title-text">
                <h1 id="fx-staffing-title" ref={title} tabIndex={-1}>{tr('移民署')}</h1>
              </div>
            </div>
          </header>
          <section className="fx-page" aria-labelledby="fx-staffing-title">
            {loaded
              ? <TabBody tab="crew" teamId={STAFFING_ID} open={base && !base.leaving ? itemKey(base.item) : null} onOpen={sheets.open} />
              : <p className="fx-empty" role="status">{tr('載入中…')}</p>}
          </section>
        </div>
      </aside>
      <SheetStack sheets={sheets} teamId={STAFFING_ID} leaving={leaving} />
    </>
  )
}
