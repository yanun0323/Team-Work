// The notice board: every company's tasks on one drawer over the right half of the map. It scrolls through
// one block per company, each the head of that company's file over its task columns; only the columns scroll
// sideways. It has no title of its own. Tasks and new tasks
// open on the same stack of detail sheets as in a company file. There is no close button: a click on the
// map puts everything away.

import { useEffect, useRef, useState } from 'react'
import { useStore } from './core/store'
import { CompanyTitle, SheetStack, useSheets } from './Drawer'
import { itemKey, type Item } from './DrawerDetail'
import { Tasks } from './DrawerTabs'
import type { BuildingLook } from './layout'

export function Board({ lookOf, leaving, onGone }: {
  lookOf: (teamId: string) => BuildingLook
  leaving: boolean
  /** Called when the page has turned away. */
  onGone: () => void
}) {
  const teams = useStore((s) => s.world.teams)
  const page = useRef<HTMLDivElement>(null)
  const sheets = useSheets()
  // the company the open sheets belong to
  const [teamId, setTeamId] = useState('')
  useEffect(() => page.current?.focus({ preventScroll: true }), [])
  const base = sheets.layers[0]
  const open = base && !base.leaving ? itemKey(base.item) : null
  const opener = (id: string) => (x: Item) => {
    setTeamId(id)
    sheets.open(x)
  }

  return (
    <>
    <aside id="fx-board" className={leaving ? 'fx-drawer leaving' : 'fx-drawer'} aria-label="所有任務"
      aria-hidden={leaving || undefined} inert={leaving || undefined}
      onAnimationEnd={(e) => { if (leaving && e.target === e.currentTarget) onGone() }}>
      <span className="fx-tape fx-tape-l" aria-hidden="true" />
      <span className="fx-tape fx-tape-r" aria-hidden="true" />
      <div className="fx-sheet">
        <div ref={page} className="fx-page fx-board-all" tabIndex={-1}>
          {Object.values(teams).map((team) => (
            <section key={team.id} className="fx-board-co" aria-labelledby={`fx-board-${team.id}`}>
              <CompanyTitle team={team} look={lookOf(team.id)}>
                <h2 id={`fx-board-${team.id}`}>{team.name}</h2>
              </CompanyTitle>
              <div className="fx-board-scroll">
                <Tasks teamId={team.id} open={teamId === team.id ? open : null} onOpen={opener(team.id)} />
              </div>
            </section>
          ))}
        </div>
      </div>
    </aside>
    <SheetStack sheets={sheets} teamId={teamId} leaving={leaving} />
    </>
  )
}
