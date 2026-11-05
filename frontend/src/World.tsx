// The main Fusion game view: a pixel-art island town in the sea. One building per company.
// Clicking a building flies the camera to it, opens it up and shows the company file in a drawer.

import { tr } from './core/i18n'
import { LanguageMenu } from './LanguageMenu'
import { MapControls } from '@react-three/drei'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type SetStateAction } from 'react'
import { guardUnload, leaveTeam } from './fileDrafts'
import * as THREE from 'three'
import { inTerminal, teamAlerts, teamReplicas, teamWork } from './core/model'
import { useStore } from './core/store'
import { LabelLayer, LabelProjector, type LabelSpec } from './core/voxel/labels'
import { Airport } from './Airport'
import { Ambient, shadowHalf } from './Ambient'
import { Building, BuildingPreview, CUT, FLOOR, ROOF_TOP } from './Building'
import { CAMERA_DISTANCE, drawerWidth, focusTarget, focusView, islandView, ISO_DIR, MAX_ZOOM, MIN_ZOOM, seaCoverZoom, shotAt, type FocusBox, type Shot } from './camera'
import { Drawer } from './Drawer'
import { Settings } from './Settings'
import { Help } from './Help'
import { Fade, FADE_SECONDS } from './Fade'
import { Island, useLand } from './Island'
import { MapGrid } from './MapGrid'
import { canMove, CELL, cellCenter, layoutTown, sameSpot, PLOT_CELLS, REACH_CELLS, randomLook, HALL_LIFT, TERMINAL, rectCenter, spotCenter, TREE_CELLS, type BuildingLook, type Spot, type Town } from './layout'
import { NewCompanySheet, Placer } from './NewCompany'
import { request } from './core/backend'
import { createTeam } from './core/domain/sim'
import type { Team } from './core/domain/types'
import { MOCK } from './core/mode'
import { attempt } from './core/ops'
import { Ocean } from './Ocean'
import { Strollers } from './People'
import { NO_OUTLINE_LAYER, PixelPass } from './PixelPass'
import { toonInstanced } from './toon'
import { usePrefs } from './prefs'
import { debugDaylight, glowing, light, lightAt, MIN_SUN_ELEVATION, phaseOf } from './daylight'
import { DaylightDebug } from './DaylightDebug'
import { CleanMacDebug } from './CleanMacDebug'
import { IndoorLights } from './IndoorLight'
import { LANTERN, propBoxes, type Box } from './streetProps'
import { playSound, useSound } from './sound'
import { Brand, useQuotaPolling } from './Brand'
import { TutorialList } from './TutorialList'
import { askTab, lastTeam, learn, rememberTeam, type TutorialGoal } from './tutorial'
import { nextIntro, revealBoot, skipBoot, type Intro } from './boot'

const calm = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/** Keyboard panning speed in screen pixels per second (Shift doubles it). */
const KEY_PAN_PX = 700
/** Key code → [screen right, screen up]. */
const PAN_KEYS: Record<string, [number, number]> = {
  KeyW: [0, 1], KeyS: [0, -1], KeyA: [-1, 0], KeyD: [1, 0],
  ArrowUp: [0, 1], ArrowDown: [0, -1], ArrowLeft: [-1, 0], ArrowRight: [1, 0],
}
/** A press that moved further than this, in pixels, was a pan, not a click. */
const CLICK_SLOP = 5


/** Finished tasks per company. */
const doneOf = (w: ReturnType<typeof useStore.getState>['world'], teamId: string) =>
  Object.values(w.tasks).filter((t) => t.teamId === teamId && t.stage === 'done').length

/** Only what decides the town's shape: companies in order, their names, and the employees and finished tasks that grow their buildings. */
function townKey(s: ReturnType<typeof useStore.getState>) {
  const w = s.world
  return Object.values(w.teams)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((t) => `${t.id}\t${t.name}\t${Object.values(w.replicas).filter((r) => r.teamId === t.id).length}\t${doneOf(w, t.id)}\t${JSON.stringify(t.plot)}`)
    .join('\n')
}

const count = (n: number) => (n > 99 ? '99+' : n)

/** Goes up each time `n` does, so a badge keyed by it replays its entrance; going down changes nothing. */
function useRises(n: number) {
  const [last, setLast] = useState({ n, rises: 0 })
  if (n !== last.n) setLast({ n, rises: last.rises + (n > last.n ? 1 : 0) })
  return last.rises + (n > last.n ? 1 : 0)
}

/** Before a company's name, clear of the alerts on its corner: a grey ring spinning round how many chats and tasks it has under way; nothing while idle. */
export function TagWork({ chats, tasks }: ReturnType<typeof teamWork>) {
  const n = chats + tasks
  if (!n) return null
  const label = tr('{n} 件工作進行中', { n })
  return (
    <span className="fx-tag-work" title={label}>
      <span aria-hidden="true">{n > 9 ? '9+' : n}</span>
      <span className="fx-sr">{label}</span>
    </span>
  )
}

/** On a company's tag: its unread chats and the tasks waiting for a reply, apart. */
export function TagAlerts({ waitingChats, waitingTasks }: ReturnType<typeof teamAlerts>) {
  const chatRises = useRises(waitingChats), taskRises = useRises(waitingTasks)
  if (!waitingChats && !waitingTasks) return null
  return (
    <span className="fx-tag-alerts">
      {waitingChats > 0 && (
        <span key={`chat-${chatRises}`} className="fx-badge fx-tag-alert fx-tag-alert-chat" title={tr('{n} 則對話待處理', { n: waitingChats })}>
          <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M1.5 2h9v6.5H5L2.5 10.8V8.5h-1z" fill="currentColor" /></svg>
          <span aria-hidden="true">{count(waitingChats)}</span>
          <span className="fx-sr">{tr('{n} 則對話待處理', { n: waitingChats })}</span>
        </span>
      )}
      {waitingTasks > 0 && (
        <span key={`task-${taskRises}`} className="fx-badge fx-tag-alert" title={tr('{n} 個任務待回覆', { n: waitingTasks })}>
          <span aria-hidden="true">{count(waitingTasks)}</span>
          <span className="fx-sr">{tr('{n} 個任務待回覆', { n: waitingTasks })}</span>
        </span>
      )}
    </span>
  )
}

export function World() {
  useSound()
  useQuotaPolling()
  const { crowd, planes, clouds, autoView, zoomSensitivity } = usePrefs()
  // the simulation changes the world ten times a second; rebuild the town only when its shape changes
  const key = useStore(townKey)
  const town = useMemo(() => {
    void key
    const w = useStore.getState().world
    const list = Object.values(w.teams).sort((a, b) => a.createdAt - b.createdAt)
    const members = (id: string) => Object.values(w.replicas).filter((r) => r.teamId === id).length
    const lots = list.map((t) => ({ id: t.id, name: t.name, members: members(t.id), done: doneOf(w, t.id), ...t.plot }))
    // closed companies leave their land behind
    return layoutTown(lots)
  }, [key])
  const land = useLand(town)

  // founding a company: first put its plot anywhere on the map, then fill in the company on a sheet
  const [placing, setPlacing] = useState(false)
  const [spot, setSpot] = useState<Spot | null>(null)
  // the new company's building, rolled when its plot is picked and again with the die on its sheet
  const [look, setLook] = useState<BuildingLook>(randomLook)
  const pickSpot = (s: Spot) => {
    setLook(randomLook())
    setSpot(s)
  }
  const act = useStore((s) => s.act)
  // editing the map: pick a company, then put its plot somewhere else
  const [editing, setEditing] = useState(false)
  const [moving, setMoving] = useState<string | null>(null)

  // a drawer over the right half that belongs to no company: the settings
  const [panel, setPanel] = useState<'settings' | null>(null)
  const settingsOpen = panel !== null
  // settings opened by clicking the airport, not the plane button: the camera goes to the airport
  const [byAirport, setByAirport] = useState(false)
  useEffect(() => {
    if (panel !== 'settings') setByAirport(false)
  }, [panel])
  const [helpOpen, setHelpOpen] = useState(false)
  // the help button is gone while the help is open; once it is back, focus returns to it
  const helpClosed = useRef(false)
  const helpButton = useCallback((el: HTMLButtonElement | null) => {
    if (el && helpClosed.current) el.focus({ preventScroll: true })
    helpClosed.current = false
  }, [])
  // the gear is gone while settings are open; once it is back, focus returns to it
  const settingsClosed = useRef(false)
  const settingsButton = useCallback((el: HTMLButtonElement | null) => {
    if (el && settingsClosed.current) el.focus({ preventScroll: true })
    settingsClosed.current = false
  }, [])
  // the same goes for the new-company button once the sheet for a picked plot goes
  const sheetClosed = useRef(false)
  const newButton = useCallback((el: HTMLButtonElement | null) => {
    if (el && sheetClosed.current) el.focus({ preventScroll: true })
    sheetClosed.current = false
  }, [])
  const [selected, setSelectedNow] = useState<string | null>(null)
  // leaving a company whose files have unsaved changes first asks (the file browser's drafts)
  const selectedNow = useRef(selected)
  selectedNow.current = selected
  const setSelected = useCallback((next: SetStateAction<string | null>) => {
    const cur = selectedNow.current
    const want = typeof next === 'function' ? next(cur) : next
    if (want !== cur) leaveTeam(cur, () => setSelectedNow(want))
  }, [])
  useEffect(guardUnload, [])
  // the building under the pointer: it darkens and its name tag lifts
  const [hovered, setHovered] = useState<string | null>(null)
  const hover = useCallback((id: string, on: boolean) => setHovered((cur) => (on ? id : cur === id ? null : cur)), [])
  const open = selected ? town.lots.find((l) => l.id === selected) : undefined
  // the settings drawer is closed the same ways as a company's; the new company's sheet goes back to
  // picking a plot, and picking stops only on Esc or its own button, since the map is still being explored
  const close = useCallback((key = false) => {
    if (helpOpen) {
      setHelpOpen(false)
      helpClosed.current = true
      return
    }
    if (moving) {
      setMoving(null)
      return
    }
    if (editing) {
      if (key) setEditing(false)
      return
    }
    if (spot) {
      setSpot(null)
      sheetClosed.current = true
      return
    }
    if (placing) {
      if (key) setPlacing(false)
      return
    }
    setSelected(null)
    if (panel === 'settings') settingsClosed.current = true
    setPanel(null)
  }, [panel, spot, placing, editing, moving, helpOpen])
  useEffect(() => {
    if (!open && !settingsOpen && !placing && !editing && !helpOpen) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !inTerminal(e) && close(true)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, settingsOpen, placing, editing, helpOpen, close])
  // a company closed while it was being moved is let go
  useEffect(() => {
    if (moving && !useStore.getState().world.teams[moving]) setMoving(null)
  }, [moving, key])
  // a company that was closed puts its file away
  useEffect(() => {
    if (selected && !useStore.getState().world.teams[selected]) setSelectedNow(null)
  }, [selected, key])
  // The simulator pins its generated layout in memory; real positions arrive in team records.
  useEffect(() => {
    if (!MOCK) return
    const missing = town.lots.filter((lot) => !useStore.getState().world.teams[lot.id]?.plot)
    if (missing.length) useStore.setState((s) => {
      for (const lot of missing) s.world.teams[lot.id].plot = { at: lot.at, style: lot.style, seed: lot.seed }
    })
  }, [town])
  // the company moves with its look; the land it leaves goes back to the sea. Put back where it was,
  // nothing changes
  const moveTo = (at: Spot) => {
    const lot = town.lots.find((l) => l.id === moving)
    setMoving(null)
    if (!lot || sameSpot(lot.at, at)) return
    const plot = { at, style: lot.style, seed: lot.seed }
    if (MOCK) useStore.setState((s) => { s.world.teams[lot.id].plot = plot })
    else void attempt(() => request('PATCH', `/teams/${lot.id}`, { plot }))
  }
  const pickMoving = (id: string) => setMoving((cur) => (cur === id ? null : id))
  const found = (input: Parameters<typeof createTeam>[1]) => {
    if (!spot) return
    // the town's shape is settled as it is now, with the new company on its plot
    const settle = (id: string) => {
      if (MOCK) useStore.setState((s) => { s.world.teams[id].plot = { at: spot, ...look } })
      setSpot(null)
      setPlacing(false)
      setSelected(id)
    }
    if (MOCK) {
      let id = ''
      act((w) => void (id = createTeam(w, input).id))
      return settle(id)
    }
    // the sheet stays open if the backend turns it down, so nothing typed is lost
    void attempt(() => request<Team>('POST', '/teams', { ...input, plot: { at: spot, ...look } })).then((team) => {
      if (!team) return
      useStore.setState((s) => { s.world.teams[team.id] = team })
      settle(team.id)
    })
  }

  const airportShown = byAirport && panel === 'settings'
  const focus = useMemo<FocusBox | null>(() => {
    if (autoView === 'off') return null
    if (airportShown) {
      const [x, z] = rectCenter(town, town.airport)
      // the terminal alone, as it stands cut away, from corner to corner of the free area
      const { x0, x1, z0, z1 } = TERMINAL
      return { x: x + (x0 + x1) / 2, z: z + (z0 + z1) / 2, w: x1 - x0, d: z1 - z0, height: CUT + HALL_LIFT }
    }
    if (spot) {
      const [x, z] = spotCenter(spot)
      return { x, z, w: PLOT_CELLS * CELL, d: PLOT_CELLS * CELL, height: 2 }
    }
    if (!open) return null
    const [x, z] = rectCenter(town, open.building)
    // the cut-away ground floor, with room above for the name tags
    return { x, z, w: open.building.w * CELL, d: open.building.d * CELL, height: CUT + 1.2 }
  }, [open, spot, town, airportShown, autoView])

  // one `id<TAB>name` line per employee of the open company
  // the empty id is the airport's chats
  const alerts = useStore((s) => ['', ...Object.keys(s.world.teams)].map((id) => {
    const a = teamAlerts(s.world, id), b = teamWork(s.world, id)
    return `${id}\t${a.waitingChats}\t${a.waitingTasks}\t${b.chats}\t${b.tasks}`
  }).join('\n'))
  const crewNames = useStore((s) => (selected ? teamReplicas(s.world, selected).map((r) => `${r.id}\t${r.name}`).join('\n') : ''))
  // the airport's tag is in words, so it changes with the language
  const language = useStore((s) => s.world.language)
  const labels = useMemo(() => {
    // People move about, so each tag follows the point its person writes every frame
    const crew = crewNames.split('\n').filter(Boolean).map((line): LabelSpec => {
      const [id, name] = line.split('\t')
      return { id: `fusion-crew-${id}`, tone: 'fusion-crew', text: name }
    })
    const [ax, az] = rectCenter(town, town.airport)
    const airport: LabelSpec = {
      id: 'fusion-airport', at: [ax + AIRPORT_TAG[0], AIRPORT_TAG[1], az + AIRPORT_TAG[2]],
      tone: hovered === AIRPORT_ID && !open && !settingsOpen && !placing && !editing ? 'fusion lifted' : 'fusion',
      text: <span className="fx-tag"><TagWork {...teamWork(useStore.getState().world, '')} />{tr('機場')}<TagAlerts {...teamAlerts(useStore.getState().world, '')} /></span>,
      onClick: selectAirport,
    }
    const tags = town.lots.map((l, i): LabelSpec => {
      const [x, z] = rectCenter(town, l.building)
      return {
        id: `fusion-${l.id}`, at: [x, l.floors * FLOOR + ROOF_TOP + 0.8, z], tone: (hovered === l.id && !open && !settingsOpen && !placing) || moving === l.id ? 'fusion lifted' : 'fusion',
        // the slip is an inner element: tilting the button itself would swing it round the screen corner,
        // because its tilt applies after the transform that places it. The tilt goes by the company's place
        // in town, so it doesn't change when the open company's tag leaves
        text: <span className={i % 2 ? 'fx-tag' : 'fx-tag fx-tag-right'}><TagWork {...teamWork(useStore.getState().world, l.id)} />{l.name}<TagAlerts {...teamAlerts(useStore.getState().world, l.id)} /></span>,
        // with a company open, another company's tag goes straight to that company
        onClick: () => (helpOpen ? close() : editing ? pickMoving(l.id) : placing ? close() : settingsOpen ? close() : setSelected(l.id)),
      }
    })
    // the open company's own name is in the drawer, and its roof is cut away
    return [...(panel === 'settings' ? [] : [airport]), ...tags.filter((t) => t.id !== `fusion-${open?.id}`), ...crew]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [town, open, crewNames, hovered, hover, settingsOpen, panel, placing, editing, moving, helpOpen, close, language, alerts])

  const shownLabels = useFadingLabels(labels)
  const help = useLingering(helpOpen ? 'help' : null)
  // the drawer stays a moment after closing, to fade out
  const drawer = useLingering(selected)
  const settings = useLingering(panel)
  const sheet = useLingering(spot ? 'new' : null)

  // while one company is open, a click anywhere else on the map closes it
  // while one is open, a click on any building, its own office included, closes it as the land and sea do
  // and while the settings are open, the click only puts them away
  const select = useCallback((id: string) => (helpOpen || settingsOpen || placing ? close() : editing ? pickMoving(id) : setSelected((cur) => (cur ? null : id))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [settingsOpen, placing, editing, helpOpen, close])

  // the tutorial counts opening the help; the company used last is where its steps go
  useEffect(() => { if (helpOpen) learn('help') }, [helpOpen])
  useEffect(() => { if (selected) rememberTeam(selected) }, [selected])
  // a company's file whooshes open, also when going straight from one company to the next; the airport announces itself
  useEffect(() => { if (selected) playSound('soundOpenTeam') }, [selected])
  useEffect(() => { if (panel === 'settings') playSound('soundOpenAirport') }, [panel])
  function goTutorial(goal: TutorialGoal) {
    if (goal.kind === 'help') return setHelpOpen(true)
    if (goal.kind === 'newCompany') return setPlacing(true)
    askTab(goal)
    if (goal.kind === 'airport') return setPanel('settings')
    const id = lastTeam(useStore.getState().world)
    if (id) setSelected(id)
  }

  // the airport opens the settings; it can't be moved, so while editing the map it does nothing
  function selectAirport() {
    if (helpOpen || settingsOpen || placing || selected) close()
    else if (!editing) {
      setByAirport(true)
      setPanel('settings')
    }
  }

  // clicks on empty land or sea close the drawer; a drag that pans the map doesn't
  const down = useRef<[number, number]>([0, 0])
  const span = town.span
  return (
    <div className="fusion-stage" onPointerDownCapture={(e) => void (down.current = [e.clientX, e.clientY])}>
    {/* pixel art: PixelPass scales the low-res picture up with hard edges, and `image-rendering: pixelated` keeps
        them sharp on Retina, so dpr 1 is enough. PixelPass draws into its own targets with their own depth, so the
        canvas needs none. It also paces the frames, hence demand. */}
    <Canvas className="fusion-canvas" shadows="basic" dpr={1} frameloop="demand" orthographic
      gl={{ antialias: false, depth: false, stencil: false }}
      camera={{ position: ISO_DIR.clone().multiplyScalar(CAMERA_DISTANCE).toArray(), zoom: 20, near: 1, far: 600 }}
      onPointerMissed={(e) => {
        if (e.type === 'click' && Math.hypot(e.clientX - down.current[0], e.clientY - down.current[1]) <= CLICK_SLOP) close()
      }}
      onCreated={({ gl, raycaster }) => {
        gl.toneMapping = THREE.NoToneMapping
        // the open building's see-through shell is on this layer and should still take clicks
        raycaster.layers.enable(NO_OUTLINE_LAYER)
      }}>
      <Sun reach={span} />
      <IndoorLights />
      <Ocean map={land.sea} calm={calm} />
      <Island town={town} land={land} />
      <Pavement town={town} />
      {(placing || editing) && <MapGrid town={town} moved={moving ?? undefined} />}
      <StreetProps town={town} />
      {crowd && <Fade show><Strollers town={town} /></Fade>}
      <Trees town={town} />
      {town.lots.map((lot) => (
        <Building key={lot.id} lot={lot} town={town} open={lot.id === selected} another={!!open && lot !== open}
          hover={!selected && !settingsOpen && !placing && (hovered === lot.id || moving === lot.id)} onHover={hover} onSelect={select} />
      ))}
      <Airport town={town} open={panel === 'settings'} calm={calm || !planes} still={editing} onSelect={selectAirport} onHover={(on) => hover(AIRPORT_ID, on)}
        hover={hovered === AIRPORT_ID && !selected && !settingsOpen && !placing && !editing && !helpOpen} />
      {placing && <Placer town={town} picked={spot} onPick={pickSpot} />}
      {spot && <BuildingPreview look={look} at={spot} />}
      {moving && <Placer key={moving} town={town} picked={null} onPick={moveTo} moved={moving} can={(s) => canMove(town, moving, s)} />}
      <Ambient town={town} calm={calm} clouds={clouds} planes={planes} />
      <MapControls makeDefault enableRotate={false} enableDamping dampingFactor={0.12} screenSpacePanning={false}
        minZoom={MIN_ZOOM} maxZoom={MAX_ZOOM} zoomSpeed={ZOOM_SPEED * zoomSensitivity / 100} />
      <CameraRig town={town} radius={town.radius} span={span} top={town.top} focus={focus} focusKey={!focus ? null : airportShown ? 'airport' : selected ?? (spot ? `spot:${spot}` : null)}
        panOnly={autoView === 'pan'} blocked={(settingsOpen && (autoView === 'panZoom' || !airportShown)) || helpOpen} wide={(placing || editing) && !selected ? town.middle : null} />
      <LabelProjector />
      <PixelPass pixel={2} />
    </Canvas>
    <LabelLayer labels={shownLabels} />
    {!drawer.value && !settings.value && !sheet.value && !help.value && (
      <div className="fx-top-left">
        <Brand />
        {!placing && !editing && <TutorialList onGo={goTutorial} />}
      </div>
    )}
    {import.meta.env.DEV && (
      <div className="fx-debug">
        {MOCK && <CleanMacDebug />}
        <DaylightDebug />
      </div>
    )}
    {!drawer.value && !settings.value && !sheet.value && !help.value && (
      <>
      {(placing || editing) && (
        <div className="fx-map-tip">
          <p className="fx-corner-note fx-tag" role="status">
            {placing ? tr('挑選建立公司的地點') : moving ? tr('選取公司新地點') : tr('選取想要移動的公司')}
          </p>
        </div>
      )}
      <div className="fx-corner">
      {!editing && <button ref={newButton} type="button" className="fx-corner-text fx-tag"
        onClick={() => setPlacing(!placing)}>
        {placing ? tr('取消') : tr('＋ 新公司')}
      </button>}
      {!placing && <button type="button" className="fx-corner-text fx-tag" aria-pressed={editing}
        onClick={() => { setEditing(!editing); setMoving(null) }}>
        {editing ? tr('完成#button') : tr('編輯地圖')}
      </button>}
      {!placing && !editing && <LanguageMenu />}
      {!placing && !editing && <button ref={helpButton} type="button" className="fx-settings-trigger fx-tag" aria-label={tr('說明')}
        onClick={() => setHelpOpen(true)}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10" />
          <path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3" />
          <path d="M12 17h.01" />
        </svg>
      </button>}
      {!placing && !editing && <button ref={settingsButton} type="button" className="fx-settings-trigger fx-tag" aria-label={tr('設定')}
        onClick={() => setPanel('settings')}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {/* a plane seen from above, nose to the top right */}
          <path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z" />
        </svg>
      </button>}
      </div>
      </>
    )}
    {sheet.value && <NewCompanySheet leaving={sheet.leaving} onGone={sheet.gone} onCreate={found} look={look} onReroll={() => setLook(randomLook())} />}
    {help.value && <Help leaving={help.leaving} onGone={help.gone} />}
    {settings.value === 'settings' && <Settings leaving={settings.leaving} onGone={settings.gone} />}
    {drawer.value && (
      <Drawer teamId={drawer.value} look={town.lots.find((l) => l.id === drawer.value) ?? { style: 'tower', seed: 0 }}
        leaving={drawer.leaving} onGone={drawer.gone} />
    )}
    </div>
  )
}

/** The airport's id among hovered things, and where its name tag sits: above the middle of the terminal roof. */
const AIRPORT_ID = 'airport'
const AIRPORT_TAG: [number, number, number] = [(TERMINAL.x0 + TERMINAL.x1) / 2, TERMINAL.h + 2.5, (TERMINAL.z0 + TERMINAL.z1) / 2]

/** Wheel zoom speed; three.js's default of 1 jumps too far per notch. */
const ZOOM_SPEED = 0.45

/** CSS fades, matching the 3D ones. */
const FADE_MS = FADE_SECONDS * 1000

/**
 * Keeps the last non-null value after it turns null, flagged as leaving, until `gone` is called (when its
 * fade-out ends). With reduced motion there is no fade, so it goes at once.
 */
function useLingering(value: string | null): { value: string | null; leaving: boolean; gone: () => void } {
  const [kept, setKept] = useState(value)
  if (value !== null && value !== kept) setKept(value)
  if (value === null && kept !== null && calm) setKept(null)
  const gone = useCallback(() => setKept(null), [])
  return { value: value ?? kept, leaving: value === null && kept !== null, gone }
}

/**
 * Labels fade in through CSS when they mount; a label that goes away is kept for one fade with a `leaving`
 * class (and no click) so it can fade out where it was.
 */
function useFadingLabels(labels: LabelSpec[]): LabelSpec[] {
  const [leaving, setLeaving] = useState<LabelSpec[]>([])
  const last = useRef(labels)
  useEffect(() => {
    const now = new Set(labels.map((l) => l.id))
    const gone = last.current.filter((l) => !now.has(l.id))
    last.current = labels
    if (!gone.length) return
    const goneIds = new Set(gone.map((l) => l.id))
    setLeaving((cur) => [
      ...cur.filter((l) => !now.has(l.id) && !goneIds.has(l.id)),
      ...gone.map((l) => ({ ...l, tone: `${l.tone} leaving`, onClick: l.onClick && (() => {}) })),
    ])
    // not cleared when labels change again: each batch removes itself
    // with room to spare: a busy frame can start the CSS fade late
    setTimeout(() => setLeaving((cur) => cur.filter((l) => !goneIds.has(l.id))), calm ? 0 : FADE_MS + 300)
  }, [labels])
  return useMemo(() => {
    const now = new Set(labels.map((l) => l.id))
    return [...labels, ...leaving.filter((l) => !now.has(l.id))]
  }, [labels, leaving])
}

/** Side of the sun's shadow map, in texels. */
const SHADOW_MAP = 2048

/**
 * The sun's normal bias: about one shadow-map texel, so a surface doesn't shadow itself (shadow acne). The shadow box
 * grows with the town, and so do its texels, so a fixed bias lets the acne back in once the town is big enough.
 */
export const sunNormalBias = (half: number) => Math.max(0.06, (half * 2) / SHADOW_MAP)

/**
 * The sky, the light from it and the sun (the moon by night), at the time of day the preferences follow. The sun's
 * shadow box covers the town and the clouds passing over it, from wherever the sun stands.
 */
function Sun({ reach }: { reach: number }) {
  const half = shadowHalf(reach)
  // off in the preferences: no shadow map is drawn at all
  const shadows = usePrefs((s) => s.shadows)
  const daylight = usePrefs((s) => s.daylight)
  const sun = useRef<THREE.DirectionalLight>(null)
  const sky = useRef<THREE.HemisphereLight>(null)
  const background = useRef<THREE.Color>(null)
  // how deep the town and its clouds reach along the sunlight, even with the sun at its lowest
  const depth = half * Math.SQRT2 * Math.cos(THREE.MathUtils.degToRad(MIN_SUN_ELEVATION)) + 12
  const distance = depth + 30
  // the frames run all the time anyway (PixelPass), so this costs no extra ones
  useFrame(() => {
    lightAt(debugDaylight.phase ?? phaseOf(daylight, new Date()), light)
    background.current?.copy(light.sky)
    if (sky.current) {
      sky.current.color.copy(light.above)
      sky.current.groundColor.copy(light.below)
      sky.current.intensity = light.fill
    }
    if (sun.current) {
      sun.current.color.copy(light.sun)
      sun.current.intensity = light.strength
      sun.current.position.copy(light.toSun).multiplyScalar(distance)
    }
    for (const m of glowing) m.emissiveIntensity = light.glow
  })
  return (
    <>
      <color ref={background} attach="background" args={[light.sky]} />
      <hemisphereLight ref={sky} args={[light.above, light.below, light.fill]} />
      <directionalLight ref={sun} position={light.toSun.clone().multiplyScalar(distance).toArray()} intensity={light.strength} color={light.sun} castShadow={shadows}
        shadow-mapSize={[SHADOW_MAP, SHADOW_MAP]} shadow-bias={-0.0007} shadow-normalBias={sunNormalBias(half)}
        shadow-camera-left={-half} shadow-camera-right={half} shadow-camera-top={half} shadow-camera-bottom={-half}
        shadow-camera-near={1} shadow-camera-far={distance + depth} />
    </>
  )
}

/**
 * Fits the island on first load, pans with WASD / arrow keys, and keeps the view over the island. Opening a
 * building flies to it and locks the view; closing it flies back to where the player was and unlocks. With
 * the auto view preference at pan, it goes there at the player's zoom and only panning locks; at off there is
 * no `focus`, so the camera neither moves nor locks.
 */
/** How long the camera takes to fly to a building and back, in seconds. */
const FLY_SECONDS = 0.9

/** An open office fills a bit more than the free area: its empty outer floor corners may be cut off. */
const OFFICE_ZOOM = 1.14


function CameraRig({ town, radius, span, top, focus, focusKey, panOnly, blocked, wide }: {
  town: Town; radius: number; span: number; top: number; focus: FocusBox | null; focusKey: string | null; panOnly: boolean; blocked: boolean
  /** Placing a new company: the middle of the town, which is shown with the sea a new plot may go on. */
  wide: [number, number] | null
}) {
  const controls = useThree((s) => s.controls) as unknown as (THREE.EventDispatcher<{ start: object }> & { target: THREE.Vector3; update: () => void; enabled: boolean; enablePan: boolean; zoomToCursor: boolean; minZoom: number }) | null
  const gl = useThree((s) => s.gl)
  const camera = useThree((s) => s.camera) as THREE.OrthographicCamera
  const size = useThree((s) => s.size)
  const fitted = useRef(false)
  const keys = useRef(new Set<string>())
  const bootKind = useRef<Intro['kind'] | undefined>(undefined)
  const bootFrames = useRef(0)

  // the zoom that fits a grid `reach` wide, with its tallest building, in view
  const fit = (reach: number) => {
    // seen from the corner, the grid's screen width is its diagonal; its height is that, foreshortened by the tilt
    const across = (reach * 2) / Math.SQRT2
    // plus the tallest building, which stands up out of the grid on screen
    const tall = across * ISO_DIR.y + top * Math.sqrt(1 - ISO_DIR.y ** 2)
    return THREE.MathUtils.clamp(Math.min((size.width * 0.85) / across, (size.height * 0.8) / tall), MIN_ZOOM, MAX_ZOOM)
  }
  useEffect(() => {
    if (fitted.current || !size.width || !size.height || !controls) return
    fitted.current = true
    const shot = islandView(town, size)
    controls.minZoom = Math.min(MIN_ZOOM, shot.zoom)
    controls.target.copy(shot.target)
    const distance = Math.max(CAMERA_DISTANCE, town.radius * 3)
    camera.position.copy(shot.target).addScaledVector(ISO_DIR, distance)
    camera.far = distance * 3
    camera.lookAt(shot.target)
    const intro = nextIntro(localStorage, calm)
    bootKind.current = intro?.kind
    // never so far out that the edge of the sea shows
    camera.zoom = intro ? Math.min(shot.zoom, Math.max(shot.zoom * intro.zoomFrom, seaCoverZoom(shot.target, size))) : shot.zoom
    camera.updateProjectionMatrix()
    if (intro) {
      controls.minZoom = Math.min(controls.minZoom, camera.zoom)
      const landing = { from: { target: shot.target, zoom: camera.zoom }, to: shot, time: -intro.hold, seconds: intro.seconds, intro: true }
      fly.current = landing
      // any input skips the landing and goes through to the map
      const inputs = new AbortController()
      const skip = () => {
        inputs.abort()
        skipBoot()
        if (fly.current === landing) landing.time = landing.seconds
      }
      for (const type of ['pointerdown', 'wheel', 'keydown']) window.addEventListener(type, skip, { capture: true, signal: inputs.signal })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    controls.update()
  }, [camera, controls, size, town])
  // the sea all round where a new plot may go
  const around = (REACH_CELLS + PLOT_CELLS) * CELL

  // where the camera is flying to, and the view to go back to when the building closes
  const fly = useRef<{ from: Shot; to: Shot; time: number; seconds?: number; intro?: boolean } | null>(null)
  const home = useRef<Shot | null>(null)
  /** Starts a flight from wherever the camera is now. */
  const flyTo = (to: Shot) => {
    if (controls) fly.current = { from: { target: controls.target.clone(), zoom: camera.zoom }, to, time: 0 }
  }
  const locked = useRef(false)
  // panning to a building and staying on it, while the player zooms: `aim` is where to look at a given zoom
  const pan = useRef<{ from: THREE.Vector3; aim: (zoom: number) => THREE.Vector3; time: number } | null>(null)
  const panLocked = useRef(false)
  // whether the view left `home` zoomed in by us, so going back should undo the zoom too
  const zoomed = useRef(false)
  useEffect(() => {
    if (!wide || !controls) return
    // pull back over the middle of the town, if not already far enough out
    flyTo({ target: new THREE.Vector3(wide[0], 0, wide[1]), zoom: Math.min(camera.zoom, fit(span + around)) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!wide, controls])
  useEffect(() => {
    if (!controls) return
    if (focus) {
      // remember the player's view only when coming from the map, not when switching companies
      if (!home.current) home.current = { target: controls.target.clone(), zoom: camera.zoom }
      const view = { width: size.width, height: size.height, coverRight: drawerWidth(size.width) }
      if (panOnly) {
        fly.current = null
        pan.current = { from: controls.target.clone(), aim: (zoom) => focusTarget(focus, view, zoom), time: 0 }
      } else {
        pan.current = null
        zoomed.current = true
        flyTo(focusView(focus, view, focusKey === 'airport' || focusKey?.startsWith('spot:') ? 1 : OFFICE_ZOOM, focusKey === 'airport'))
      }
    } else {
      pan.current = null
      if (home.current) flyTo(zoomed.current ? home.current : { target: home.current.target, zoom: camera.zoom })
      home.current = null
      zoomed.current = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey, panOnly, controls])
  useEffect(() => {
    locked.current = !!focus || blocked
    panLocked.current = !!focus && panOnly && !blocked
    if (controls) {
      controls.enabled = !locked.current || panLocked.current
      controls.enablePan = !panLocked.current
    }
    if (locked.current) keys.current.clear()
  }, [focus, panOnly, blocked, controls])
  useEffect(() => {
    if (!controls) return
    const cancel = () => void (fly.current = null)
    controls.addEventListener('start', cancel)
    return () => controls.removeEventListener('start', cancel)
  }, [controls])
  // the wheel zooms in towards the pointer, but out about the middle of the screen: decided for each wheel
  // step just before the controls see it (they listen on the canvas; this listens on its parent, capturing)
  useEffect(() => {
    const host = gl.domElement.parentElement
    if (!controls || !host) return
    // zooming towards the pointer would pan, which is locked while panned to a building
    const pick = (e: WheelEvent) => void (controls.zoomToCursor = e.deltaY < 0 && !panLocked.current)
    host.addEventListener('wheel', pick, { capture: true, passive: true })
    return () => host.removeEventListener('wheel', pick, { capture: true })
  }, [controls, gl])

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (e.ctrlKey || e.metaKey || e.altKey || !(e.code in PAN_KEYS || e.key === 'Shift')) return
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return
      // keys pressed inside the drawer scroll the drawer, and an open building holds the view still
      if (el?.closest?.('.fx-drawer') || locked.current) return
      keys.current.add(e.code)
      if (PAN_KEYS[e.code]) fly.current = null
      if (e.code.startsWith('Arrow')) e.preventDefault()
    }
    const up = (e: KeyboardEvent) => void keys.current.delete(e.code)
    const clear = () => keys.current.clear()
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', clear)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', clear)
    }
  }, [])

  useFrame((_, delta) => {
    if (!controls) return
    // the second frame with the camera in place: the first has compiled and drawn the scene
    if (fitted.current && bootFrames.current < 2 && ++bootFrames.current === 2) revealBoot(bootKind.current)
    const t = controls.target
    let ax = 0
    let az = 0
    for (const k of keys.current) {
      ax += PAN_KEYS[k]?.[0] ?? 0
      az += PAN_KEYS[k]?.[1] ?? 0
    }
    if (ax || az) {
      // screen directions flattened onto the ground; same on-screen speed at any zoom
      const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).setY(0).normalize()
      const fwd = new THREE.Vector3(right.z, 0, -right.x)
      const fast = keys.current.has('ShiftLeft') || keys.current.has('ShiftRight') ? 2 : 1
      const step = (KEY_PAN_PX * fast * Math.min(delta, 0.05)) / camera.zoom
      const move = right.multiplyScalar(ax).add(fwd.multiplyScalar(az)).normalize().multiplyScalar(step)
      t.add(move)
      camera.position.add(move)
    }
    if (pan.current) {
      // the zoom stays the player's, even mid-way; the building stays centred as it changes
      const f = pan.current
      f.time += Math.min(delta, 0.05)
      const p = calm ? 1 : Math.min(1, f.time / FLY_SECONDS)
      const goal = f.aim(camera.zoom)
      const offset = camera.position.clone().sub(t)
      t.copy(p === 1 ? goal : f.from.clone().lerp(goal, 1 - (1 - p) ** 3))
      camera.position.copy(t).add(offset)
    }
    if (fly.current) {
      const f = fly.current
      // fast at first, settling gently; straight there when motion is reduced
      f.time += Math.min(delta, 0.05)
      const p = calm ? 1 : THREE.MathUtils.clamp(f.time / (f.seconds ?? FLY_SECONDS), 0, 1)
      const shot = shotAt(f.from, f.to, 1 - (1 - p) ** 3)
      // the camera keeps its offset from what it looks at; it lands exactly on the goal, so closing a
      // building returns to the very same view
      const offset = camera.position.clone().sub(t)
      t.copy(p === 1 ? f.to.target : shot.target)
      camera.position.copy(t).add(offset)
      camera.zoom = p === 1 ? f.to.zoom : shot.zoom
      camera.updateProjectionMatrix()
      if (p === 1) {
        fly.current = null
        if (f.intro && controls) controls.minZoom = Math.min(MIN_ZOOM, f.to.zoom)
      }
    }
    // the view's center stays over the island, so it can't be lost at sea; not while flying or with a
    // building open, whose view may sit a little past it (pulling it back would bend the flight)
    const lim = radius + 6 + (wide ? around : 0)
    const cx = THREE.MathUtils.clamp(t.x, -lim, lim)
    const cz = THREE.MathUtils.clamp(t.z, -lim, lim)
    if (!fly.current && !locked.current && (cx !== t.x || cz !== t.z)) {
      camera.position.x += cx - t.x
      camera.position.z += cz - t.z
      t.x = cx
      t.z = cz
    }
    controls.update()
  })
  return null
}


const UNIT = new THREE.BoxGeometry(1, 1, 1)

/** Many static boxes in one draw call, toon-lit. Build `boxes` in a useMemo. */
function Batch({ boxes, glow }: { boxes: Box[]; glow?: string }) {
  const ref = useRef<THREE.InstancedMesh>(null)
  const material = useMemo(() => toonInstanced(glow), [glow])
  useEffect(() => () => {
    glowing.delete(material)
    material.dispose()
  }, [material])
  useLayoutEffect(() => {
    const mesh = ref.current
    if (!mesh) return
    const o = new THREE.Object3D()
    const c = new THREE.Color()
    boxes.forEach((b, i) => {
      o.position.set(...b.p)
      o.scale.set(...b.s)
      o.updateMatrix()
      mesh.setMatrixAt(i, o.matrix)
      mesh.setColorAt(i, c.set(b.c))
    })
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    mesh.computeBoundingSphere()
  }, [boxes])
  if (!boxes.length) return null
  return <instancedMesh key={boxes.length} ref={ref} args={[UNIT, material, boxes.length]} castShadow receiveShadow />
}

/** Paved plot cells, a touch above the grass, in a checker of their own. */
function Pavement({ town }: { town: Town }) {
  const boxes = useMemo(() => {
    const out: Box[] = []
    for (const l of town.lots) for (let z = l.plot.z; z < l.plot.z + l.plot.d; z++) for (let x = l.plot.x; x < l.plot.x + l.plot.w; x++) {
      const [cx, cz] = cellCenter(town, x, z)
      out.push({ p: [cx, 0.04, cz], s: [CELL, 0.08, CELL], c: (x + z) % 2 ? '#c9c4d6' : '#d3cfdf' })
    }
    return out
  }, [town])
  return <Batch boxes={boxes} />
}

/** Lamp posts, planters and benches on the paved rings round the buildings; less detail drops the lamps and the flowers. */
function StreetProps({ town }: { town: Town }) {
  const detail = usePrefs((s) => s.detail)
  const boxes = useMemo(() => town.lots.flatMap((l) => propBoxes(town, l, detail)), [town, detail])
  // the lamps' lanterns shine after dark
  const [lit, rest] = useMemo(() => [boxes.filter((b) => b.glow), boxes.filter((b) => !b.glow)], [boxes])
  return <>
    <Batch boxes={rest} />
    <Batch boxes={lit} glow={LANTERN} />
  </>
}

const LEAVES = [['#4fa848', '#62b955'], ['#3e8f55', '#4c9f62'], ['#e5883a', '#f0a04a']]

/** Blocky trees, each centred on its own TREE_CELLS × TREE_CELLS patch, 2 to 4 cells tall. */
function Trees({ town }: { town: Town }) {
  const boxes = useMemo(() => {
    const out: Box[] = []
    for (const t of town.trees) {
      const [cx, cz] = cellCenter(town, t.x, t.z)
      const x = cx + ((TREE_CELLS - 1) * CELL) / 2
      const z = cz + ((TREE_CELLS - 1) * CELL) / 2
      const h = t.height * CELL
      // taller trees are slimmer: a 2-cell tree is the bushiest
      const wide = TREE_CELLS * CELL * (t.height === 2 ? 0.62 : t.height === 3 ? 0.56 : 0.5)
      // a trunk that shows below the leaves, a big crown and a smaller top
      const trunk = h * 0.42
      const [a, b] = LEAVES[t.variant]
      out.push({ p: [x, trunk / 2, z], s: [0.25 * CELL, trunk, 0.25 * CELL], c: '#8a5a36' })
      out.push({ p: [x, trunk + h * 0.2, z], s: [wide, h * 0.4, wide], c: a })
      out.push({ p: [x, trunk + h * 0.49, z], s: [wide * 0.6, h * 0.18, wide * 0.6], c: b })
    }
    return out
  }, [town])
  return <Batch boxes={boxes} />
}
