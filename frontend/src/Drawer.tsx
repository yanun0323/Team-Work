// The company file: a newspaper sheet taped over the right half of the map. It is pasted on when a company
// opens and turned away like a page when it closes. The head names the company, its folder and target
// branch; the tabs below hold its tasks, flows, employees (grouped under their blueprints) and settings. Anything in them that
// opens shows its detail on a sheet over the upper left of the map (DrawerDetail). There is no close
// button: a click on the map puts everything away.

import { tr } from './core/i18n'
import { openFolder } from './core/ops'
import { MOCK } from './core/mode'
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { inTerminal, waitingTab } from './core/model'
import { Prereqs, usePrereqs } from './PrereqStamps'
import { useStore } from './core/store'
import { paletteOf } from './Building'
import { BranchIcon, Detail, itemKey, type Item } from './DrawerDetail'
import { TabBody, TABS, tabOr, type Tab } from './DrawerTabs'
import { usePrefs } from './prefs'
import type { BuildingLook } from './layout'
import type { Team } from './core/domain/types'
import { takeCompanyTab } from './tutorial'
import { NotesPin } from './Notes'
import { answerLeaving, unsavedIn, useFileDrafts } from './fileDrafts'

const Terminal = lazy(() => import('./Terminal'))
const FileBrowser = lazy(() => import('./FileBrowser'))

/** Asks before leaving this company while files in it have unsaved changes (see leaveTeam). */
function LeaveAsk({ teamId }: { teamId: string }) {
  const asking = useFileDrafts((s) => s.leaving?.teamId === teamId)
  const count = useFileDrafts((s) => unsavedIn(s.drafts, teamId).length)
  if (!asking) return null
  return <LeavePrompt count={count} onAnswer={answerLeaving} />
}

/** Whether to leave a company whose files have unsaved changes; Esc stays. The drafts stay either way. */
export function LeavePrompt({ count, onAnswer }: { count: number; onAnswer: (leave: boolean) => void }) {
  return (
    <div className="fx-files-ask fx-files-leave" role="alertdialog" aria-labelledby="fx-files-leave"
      onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onAnswer(false) } }}>
      <span id="fx-files-leave">{tr('{count} 個檔案還沒儲存', { count })}</span>
      <button type="button" className="fx-tool fx-tool-text fx-hit" autoFocus onClick={() => onAnswer(false)}>{tr('留下')}</button>
      <button type="button" className="fx-tool fx-tool-ask fx-hit" onClick={() => onAnswer(true)}>{tr('離開')}</button>
    </div>
  )
}

type Rect = [number, number, number, number, string]

/** The top of a building's stamp: its roof, as on the map, in a few pixels. */
function crownOf(style: BuildingLook['style'], p: ReturnType<typeof paletteOf>): Rect[] {
  const pyramid = (c: string): Rect[] => [[6, 0, 4, 1, c], [4, 1, 8, 1, c], [2, 2, 12, 1, c], [0, 3, 16, 1, c]]
  switch (style) {
    case 'tower': return [[12, 0, 1, 1, '#ff5a4a']]
    case 'brick': return [[3, 0, 3, 1, '#9a6a44']]
    case 'studio': return [[2, 0, 5, 1, '#62b955'], [9, 0, 4, 1, '#33507a']]
    case 'loft': return [[2, 0, 2, 1, p.wall], [6, 0, 2, 1, p.wall], [10, 0, 2, 1, p.wall]]
    case 'timber': return [...pyramid(p.roof), [10, 0, 2, 2, p.trim]]
    case 'classic': return [[6, 0, 4, 1, p.roof], [5, 1, 6, 1, p.roof]]
    case 'tech': return [[3, 0, 1, 1, p.sign]]
    case 'pagoda': return [[7, 0, 2, 1, p.sign], [4, 1, 8, 1, p.roof], [0, 2, 16, 1, p.roof]]
    case 'deco': return [[7, 0, 2, 1, p.sign], [5, 1, 6, 1, p.wall], [5, 2, 6, 1, p.sign]]
    case 'eco': return [[1, 0, 3, 1, '#4fa848'], [6, 0, 2, 1, '#62b955'], [11, 0, 3, 1, '#4fa848']]
    case 'villa': return pyramid(p.roof)
  }
}

/** The company's building, front on, in its own colours, under its style's roof. */
export function BuildingIcon({ look }: { look: BuildingLook }) {
  const p = paletteOf(look)
  const windows = []
  for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) {
    windows.push(<rect key={`${x}${y}`} x={3 + x * 3.5} y={4 + y * 3} width={2} height={2} fill={(x + y * 2) % 5 === 1 ? '#ffe08a' : p.glass} />)
  }
  return (
    <svg className="fx-icon" viewBox="0 0 16 16" aria-hidden="true" shapeRendering="crispEdges">
      <rect x={1} y={2} width={14} height={13} fill={p.wall} />
      <rect x={1} y={1} width={14} height={2} fill={p.trim} />
      <rect x={1} y={13} width={14} height={2} fill={p.trim} />
      {windows}
      <rect x={6.5} y={12} width={3} height={3} fill="#2c3f52" />
      <rect x={5.5} y={11} width={5} height={1} fill={p.awning} />
      {crownOf(look.style, p).map(([x, y, w, h, c], i) => <rect key={`c${i}`} x={x} y={y} width={w} height={h} fill={c} />)}
    </svg>
  )
}

/** A company's stamp, name, folder and target branch: the head of its file, and of its block on the board. */
export function CompanyTitle({ team, look, canOpenFolder, children }: { team: Team; look: BuildingLook; canOpenFolder?: boolean; children: ReactNode }) {
  return (
    <div className="fx-title">
      <BuildingIcon look={look} />
      <div className="fx-title-text">
        {children}
        <p className="fx-where">
          <span className="fx-folder">
            <code title={tr('專案位置')}>{team.folder}</code>
            {canOpenFolder && !MOCK && (
              <button type="button" className="fx-tool fx-hit fx-folder-open" aria-label={tr('在 Finder 打開')} title={tr('在 Finder 打開')} onClick={() => openFolder(team.id)}>
                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                  <path d="M1.75 12.5v-9h4.2l1.5 1.75h6.8v7.25z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
                </svg>
              </button>
            )}
          </span>
          <span className="fx-branch" title={tr('目標分支')}>
            <BranchIcon />
            <span className="fx-sr">{tr('目標分支 ')}</span>
            <code>{team.targetBranch}</code>
          </span>
        </p>
      </div>
    </div>
  )
}

function TerminalPrereqs({ teamId }: { teamId: string }) {
  return <Prereqs list={usePrereqs(teamId, 'terminal')} />
}

export function Drawer({ teamId, look, leaving, onGone }: {
  teamId: string
  look: BuildingLook
  leaving: boolean
  /** Called when the page has turned away. */
  onGone: () => void
}) {
  // a company that was just closed stays on the page while it turns away
  const live = useStore((s) => s.world.teams[teamId])
  const last = useRef(live)
  if (live) last.current = live
  const team = live ?? (last.current?.id === teamId ? last.current : undefined)
  // the tab a tutorial step asked for, kept until the opening effect below has used it
  const [askedTab] = useState(takeCompanyTab)
  const asked = useRef(askedTab)
  const startTab = () => {
    const { autoTab, defaultTab } = usePrefs.getState()
    if (asked.current) return asked.current
    return tabOr((autoTab !== 'off' && waitingTab(useStore.getState().world, teamId, autoTab)) || defaultTab)
  }
  const [tab, setTab] = useState<Tab>(startTab)
  // the company whose terminal has been opened: its shell then runs until the file closes or changes company
  const [terminalTeam, setTerminalTeam] = useState<string | null>(tab === 'terminal' ? teamId : null)
  const [terminalFocus, setTerminalFocus] = useState(0)
  const title = useRef<HTMLHeadingElement>(null)
  const tabs = useRef<Array<HTMLButtonElement | null>>([])
  const sheets = useSheets()
  const { back } = sheets
  // a new company: move focus to its name, and put away the last company's sheet
  useEffect(() => {
    title.current?.focus({ preventScroll: true })
    back(-1, false)
    const start = startTab()
    asked.current = null
    setTab(start)
    if (start === 'terminal') {
      setTerminalTeam(teamId)
      setTerminalFocus((n) => n + 1)
    }
  }, [teamId, back])
  if (!team) return null
  const base = sheets.layers[0]

  // arrow keys move between tabs, as in any tab list
  const onTabKey = (e: KeyboardEvent) => {
    const i = TABS.findIndex((x) => x.id === tab)
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TABS.length - 1 }[e.key]
    if (next === undefined) return
    e.preventDefault()
    const j = (next + TABS.length) % TABS.length
    pick(TABS[j].id)
    tabs.current[j]?.focus()
  }
  // the sheet belongs to the tab it was opened from; the notes belong to none
  const pick = (next: Tab) => {
    if (next !== tab && base?.item.kind !== 'notes') back(-1, false)
    if (next === 'terminal') setTerminalTeam(teamId)
    setTab(next)
  }

  return (
    <>
    {/* while turning away it is already closed: hidden from assistive tech and from the pointer */}
    <aside className={leaving ? 'fx-drawer leaving' : 'fx-drawer'} aria-labelledby="fx-drawer-title"
      aria-hidden={leaving || undefined} inert={leaving || undefined}
      onAnimationEnd={(e) => { if (leaving && e.target === e.currentTarget) onGone() }}>
      <span className="fx-tape fx-tape-l" aria-hidden="true" />
      <span className="fx-tape fx-tape-r" aria-hidden="true" />
      <NotesPin teamId={teamId} open={base?.item.kind === 'notes' && !base.leaving} onOpen={() => sheets.open({ kind: 'notes' })} />
      <div className="fx-sheet">
        <header className="fx-head">
          <CompanyTitle team={team} look={look} canOpenFolder>
            <h1 id="fx-drawer-title" ref={title} tabIndex={-1}>{team.name}</h1>
          </CompanyTitle>
          <div className="fx-tabs" role="tablist" aria-label={tr('公司檔案')} onKeyDown={onTabKey}>
            {TABS.map((x, i) => (
              <button key={x.id} ref={(el) => void (tabs.current[i] = el)} type="button" role="tab"
                id={`fx-tab-${x.id}`} aria-controls="fx-panel" aria-selected={tab === x.id} tabIndex={tab === x.id ? 0 : -1}
                onClick={() => {
                  pick(x.id)
                  if (x.id === 'terminal') setTerminalFocus((n) => n + 1)
                }}>
                {tr(x.label)}
              </button>
            ))}
          </div>
        </header>
        {/* keyed, so each tab turns in like a fresh page */}
        <LeaveAsk teamId={teamId} />
        {tab === 'files' && (
          <section key={tab} id="fx-panel" className="fx-page fx-page-files" role="tabpanel" aria-labelledby="fx-tab-files">
            <Suspense fallback={<p className="fx-files-note">{tr('讀取中…')}</p>}>
              <FileBrowser key={teamId} teamId={teamId} />
            </Suspense>
          </section>
        )}
        {tab !== 'terminal' && tab !== 'files' && (
          <section key={tab} id="fx-panel" className="fx-page" role="tabpanel" aria-labelledby={`fx-tab-${tab}`}>
            <TabBody tab={tab} teamId={teamId} open={base && !base.leaving ? itemKey(base.item) : null} onOpen={sheets.open} />
          </section>
        )}
        {terminalTeam === teamId && (
          <section id={tab === 'terminal' ? 'fx-panel' : undefined} className="fx-page fx-page-terminal" role="tabpanel"
            aria-labelledby="fx-tab-terminal" hidden={tab !== 'terminal'}>
            <TerminalPrereqs teamId={teamId} />
            <Suspense fallback={null}>
              <Terminal key={teamId} teamId={teamId} focusRequest={terminalFocus}
                onLeave={() => tabs.current[TABS.findIndex((x) => x.id === 'terminal')]?.focus()} />
            </Suspense>
          </section>
        )}
      </div>
    </aside>
    <SheetStack sheets={sheets} teamId={teamId} leaving={leaving} />
    </>
  )
}

const calm = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/** A sheet in the stack, and what had focus when it was taped on (focus goes back there when it goes). */
type Layer = { item: Item; leaving: boolean; from: HTMLElement | null }

/**
 * The stack of detail sheets. Opening from the company file starts a fresh stack, and opening its bottom
 * item again puts the stack away; `push` tapes a sheet on top, or swaps the top one once there are
 * `MAX_SHEETS`; `back(d)` puts away every sheet above depth
 * d (-1: all of them). A sheet put away stays for its fade-out (`leaving`) until `gone`; with reduced
 * motion there is none, so it goes at once.
 */
const MAX_SHEETS = 4

export type Sheets = ReturnType<typeof useSheets>

export function useSheets() {
  const [layers, setLayers] = useState<Layer[]>([])
  // focus to restore once the sheet under it is no longer covered (inert) and can take it
  const refocus = useRef<HTMLElement | null>(null)
  useEffect(() => {
    refocus.current?.focus({ preventScroll: true })
    refocus.current = null
  }, [layers])
  const drop = (ls: Layer[], from: number) => (calm ? ls.slice(0, from) : ls.map((l, i) => (i >= from ? { ...l, leaving: true } : l)))
  const open = useCallback((x: Item) => {
    const from = document.activeElement as HTMLElement | null
    setLayers((ls) => (ls[0] && !ls[0].leaving && itemKey(ls[0].item) === itemKey(x) ? drop(ls, 0)
      : [{ item: x, leaving: false, from }]))
  }, [])
  const push = useCallback((x: Item) => {
    const from = document.activeElement as HTMLElement | null
    setLayers((ls) => {
      const live = ls.filter((l) => !l.leaving)
      if (live.length < MAX_SHEETS) return [...live, { item: x, leaving: false, from }]
      return [...live.slice(0, MAX_SHEETS - 1), { item: x, leaving: false, from: live[MAX_SHEETS - 1].from }]
    })
  }, [])
  const back = useCallback((depth: number, restore = true) => {
    setLayers((ls) => {
      if (restore) refocus.current = ls[depth + 1]?.from ?? document.getElementById(`fx-detail-title-${depth}`)
      return drop(ls, depth + 1)
    })
  }, [])
  const gone = useCallback((depth: number) => setLayers((ls) => (ls[depth]?.leaving ? ls.slice(0, depth) : ls)), [])
  // for the keyboard, Esc puts away the top sheet, then the drawer; this runs before the map's own Esc handler
  const top = layers.filter((l) => !l.leaving).length - 1
  useEffect(() => {
    if (top < 0) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || inTerminal(e)) return
      // an open drop-down list takes Esc for itself
      if ((e.target as HTMLElement | null)?.closest?.('[aria-expanded="true"][aria-haspopup="listbox"]')) return
      e.stopPropagation()
      back(top - 1)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [top, back])
  return { layers, top, open, push, back, gone }
}

/** The detail sheets opened from a drawer, over the upper left of the map. */
export function SheetStack({ sheets, teamId, leaving }: { sheets: Sheets; teamId: string; leaving: boolean }) {
  const { layers, top, back } = sheets
  return layers.map((l, i) => (
    <Detail key={`${i}:${itemKey(l.item)}`} item={l.item} teamId={teamId} depth={i}
      covered={i < top} above={i < top ? layers[i + 1]?.item : undefined} leaving={leaving || l.leaving}
      onGone={() => sheets.gone(i)} onBack={() => back(i)} onDone={() => back(i - 1)} onClear={() => back(i - 2)} onPush={sheets.push} />
  ))
}
