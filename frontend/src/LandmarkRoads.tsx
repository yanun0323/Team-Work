// The island's landmarks on the user's profile, each on its road: a stop for each stage, a little picture and its name
// once reached, a question mark before. Pointing at a stop, or moving the focus to it, floats a note over the page
// saying what grows it and how far there is to go; a stop reached shows its landmark on the map.

import { useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { colon, tr } from './core/i18n'
import type { LandmarkRoad } from './core/landmarks'
import type { LandmarkKind } from './core/domain/types'
import { fmtCount } from './Stats'

/** Each landmark's road in words and pictures: its name, each stage's, and what each stage's milestone asks for. */
const ROADS: Record<LandmarkKind, { name: () => string; stages: Array<{ name: () => string; icon: ReactNode }>; goal: (n: string) => string }> = {
  park: {
    name: () => tr('公園'),
    stages: [
      { name: () => tr('小型公園'), icon: <SmallPark /> },
      { name: () => tr('中型公園'), icon: <MediumPark /> },
      { name: () => tr('大型公園'), icon: <LargePark /> },
    ],
    goal: (n) => tr('完成 {n} 個任務', { n }),
  },
  hill: {
    name: () => tr('山丘'),
    stages: [
      { name: () => tr('小山丘'), icon: <Hill /> },
      { name: () => tr('觀景台'), icon: <Lookout /> },
    ],
    goal: (n) => tr('使用 {n} 天', { n }),
  },
  pond: {
    name: () => tr('噴水池'),
    stages: [
      { name: () => tr('噴水池'), icon: <Fountain /> },
      { name: () => tr('木橋湖泊'), icon: <Lake /> },
    ],
    goal: (n) => tr('開 {n} 個對話', { n }),
  },
  dock: {
    name: () => tr('碼頭'),
    stages: [
      { name: () => tr('碼頭'), icon: <Pier /> },
      { name: () => tr('碼頭與小船'), icon: <Boats /> },
    ],
    goal: (n) => tr('開 {n} 間公司', { n }),
  },
  clock: {
    name: () => tr('鐘塔'),
    stages: [{ name: () => tr('鐘塔'), icon: <ClockTower /> }],
    goal: (n) => tr('使用 {n} 天', { n }),
  },
}

/** A landmark's name as grown to `stage`: the small park, the lookout. */
export const landmarkName = (kind: LandmarkKind, stage: number) => {
  const road = ROADS[kind]
  return road.stages[Math.min(stage, road.stages.length) - 1]?.name() ?? road.name()
}

/** The roads of the landmarks the island knows. `shown` is the one on the map now, if any; `onShow` shows one there. */
export function LandmarkRoads({ roads, shown = null, onShow }: {
  roads: LandmarkRoad[]
  shown?: LandmarkKind | null
  onShow?: (kind: LandmarkKind | null) => void
}) {
  const known = roads.filter((r) => ROADS[r.kind])
  if (!known.length) return null
  // every road's stops in columns as wide as the longest road's, so they line up from the left
  const stops = Math.max(...known.map((r) => Math.min(r.steps.length, ROADS[r.kind].stages.length)))
  return (
    <section className="fx-d-group" aria-labelledby="fx-profile-roads" style={{ '--stops': stops } as CSSProperties}>
      <h4 id="fx-profile-roads">{tr('島上建設')}</h4>
      {known.map((road) => {
        const words = ROADS[road.kind]
        return (
          <ol key={road.kind} className="fx-road" aria-label={words.name()}>
            {road.steps.map((step, i) => {
              const stage = words.stages[i]
              if (!stage) return null
              const reached = road.stage > i
              return (
                <RoadStop
                  key={i} reached={reached} name={stage.name()} icon={stage.icon} goal={words.goal(fmtCount(step))}
                  value={road.value} step={step} pressed={reached && shown === road.kind}
                  onShow={reached && onShow ? () => onShow(shown === road.kind ? null : road.kind) : undefined}
                />
              )
            })}
          </ol>
        )
      })}
    </section>
  )
}

/** Room kept between a stop and its note, and between the note and the window's edge, in pixels. */
const GAP = 8

function RoadStop({ reached, name, icon, goal, value, step, pressed, onShow }: {
  reached: boolean; name: string; icon: ReactNode; goal: string; value: number; step: number; pressed: boolean
  onShow?: () => void
}) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [place, setPlace] = useState<CSSProperties | null>(null)
  const stop = useRef<HTMLButtonElement>(null)
  const note = useRef<HTMLDivElement>(null)
  const status = reached ? tr('已解鎖') : `${fmtCount(Math.min(value, step))} / ${fmtCount(step)}`

  // over the page, above the stop, or under it where there is no room above; kept inside the window
  useLayoutEffect(() => {
    const slip = note.current
    const at = stop.current?.getBoundingClientRect()
    if (!open || !slip || !at) return
    slip.showPopover?.()
    const up = at.top >= slip.offsetHeight + GAP * 2
    const left = at.left + at.width / 2 - slip.offsetWidth / 2
    setPlace({
      left: Math.min(Math.max(GAP, left), window.innerWidth - slip.offsetWidth - GAP),
      top: up ? at.top - slip.offsetHeight - GAP : at.bottom + GAP,
    })
  }, [open])
  // a note left floating while the profile scrolls under it would point at nothing
  useLayoutEffect(() => {
    if (!open) return
    const shut = () => setOpen(false)
    document.addEventListener('scroll', shut, true)
    window.addEventListener('resize', shut)
    return () => {
      document.removeEventListener('scroll', shut, true)
      window.removeEventListener('resize', shut)
    }
  }, [open])
  const show = () => { setPlace(null); setOpen(true) }

  return (
    <li className={reached ? 'fx-road-stop fx-road-reached' : 'fx-road-stop'}>
      <button
        ref={stop} type="button" className="fx-road-node" aria-label={reached ? name : tr('未解鎖')} aria-describedby={`${id}-goal`}
        aria-pressed={onShow ? pressed : undefined} aria-disabled={onShow ? undefined : true}
        // while the note is up, Esc puts it away rather than the profile
        data-esc={open ? 'box' : undefined}
        onPointerEnter={show} onPointerLeave={() => setOpen(false)} onFocus={show} onBlur={() => setOpen(false)}
        onKeyDown={(e) => { if (e.key === 'Escape' && open) setOpen(false) }}
        onClick={onShow}>
        {reached ? icon : <span className="fx-road-unknown" aria-hidden="true">?</span>}
      </button>
      {reached && <span className="fx-road-name" aria-hidden="true">{name}</span>}
      <span id={`${id}-goal`} className="fx-sr">{`${goal}${colon()}${status}`}</span>
      {open && (
        // a manual popover sits above the page, out of reach of the drawer's scrolling and tilt
        <div ref={note} popover="manual" className={place ? 'fx-road-note' : 'fx-road-note fx-road-placing'} style={place ?? undefined} aria-hidden="true">
          <b>{goal}</b>
          {reached ? <span>{status}</span> : (
            <>
              <span className="fx-road-bar"><span style={{ width: `${Math.min(1, value / step) * 100}%` }} /></span>
              <span>{status}</span>
            </>
          )}
        </div>
      )}
    </li>
  )
}

// ---------------------------------------------------------------- pictures, 16 × 16 pixels

const GRASS = '#7cc46b'
const LEAVES = '#3f9a4a'
const LEAVES_LIGHT = '#5fb85a'
const TRUNK = '#8a5a36'
const BENCH = '#a8774e'
const GRAVEL = '#e3d9c3'
const ROOF = '#c4574a'
const PAINT = '#f4f1ea'
const HILL = '#5fae4c'
const HILL_TOP = '#7cc46b'
const STONE = '#c9bfae'
const WATER = '#4b9fd6'
const SPRAY = '#cdeefc'
const WOOD = '#a8774e'
const DARK = '#2f3445'
const BRICK = '#c9785a'
const TEAL = '#3f6f6a'

function Pixels({ children }: { children: ReactNode }) {
  return <svg viewBox="0 0 16 16" width="32" height="32" shapeRendering="crispEdges" aria-hidden="true">{children}</svg>
}

/** A tree whose crown's top left is at (x, y): four pixels wide, a trunk under it. */
function Tree({ x, y }: { x: number; y: number }) {
  return <>
    <rect x={x} y={y} width="4" height="4" fill={LEAVES} />
    <rect x={x + 1} y={y} width="2" height="2" fill={LEAVES_LIGHT} />
    <rect x={x + 1} y={y + 4} width="2" height="2" fill={TRUNK} />
  </>
}

function SmallPark() {
  return <Pixels>
    <rect x="1" y="11" width="14" height="4" fill={GRASS} />
    <Tree x={3} y={5} />
    <rect x="9" y="10" width="5" height="1" fill={BENCH} />
    <rect x="9" y="8" width="5" height="1" fill={BENCH} />
    <rect x="9" y="11" width="1" height="2" fill={TRUNK} />
    <rect x="13" y="11" width="1" height="2" fill={TRUNK} />
  </Pixels>
}

function MediumPark() {
  return <Pixels>
    <rect x="0" y="11" width="16" height="5" fill={GRASS} />
    <rect x="5" y="12" width="6" height="2" fill={GRAVEL} />
    <Tree x={1} y={4} />
    <Tree x={11} y={3} />
    <rect x="6" y="9" width="4" height="1" fill={BENCH} />
    <rect x="6" y="7" width="4" height="1" fill={BENCH} />
  </Pixels>
}

function Hill() {
  return <Pixels>
    <rect x="1" y="10" width="14" height="5" fill={HILL} />
    <rect x="4" y="6" width="8" height="4" fill={HILL_TOP} />
    <rect x="7" y="10" width="2" height="5" fill={STONE} />
    <rect x="7" y="7" width="2" height="3" fill={STONE} />
    <Tree x={1} y={4} />
  </Pixels>
}

function Lookout() {
  return <Pixels>
    <rect x="1" y="11" width="14" height="4" fill={HILL} />
    <rect x="3" y="8" width="10" height="3" fill={HILL_TOP} />
    <rect x="3" y="7" width="10" height="1" fill={WOOD} />
    <rect x="3" y="2" width="1" height="5" fill={TRUNK} />
    <rect x="12" y="2" width="1" height="5" fill={TRUNK} />
    <rect x="2" y="1" width="12" height="1" fill={WOOD} />
    <rect x="7" y="4" width="4" height="1" fill="#c8a04a" />
    <rect x="8" y="5" width="1" height="2" fill={DARK} />
  </Pixels>
}

function Fountain() {
  return <Pixels>
    <rect x="1" y="11" width="14" height="3" fill={STONE} />
    <rect x="2" y="11" width="12" height="1" fill={WATER} />
    <rect x="7" y="6" width="2" height="5" fill={STONE} />
    <rect x="5" y="6" width="6" height="1" fill={STONE} />
    <rect x="7" y="2" width="2" height="4" fill={SPRAY} />
    <rect x="4" y="4" width="1" height="1" fill={SPRAY} />
    <rect x="11" y="4" width="1" height="1" fill={SPRAY} />
    <rect x="3" y="7" width="1" height="2" fill={SPRAY} />
    <rect x="12" y="7" width="1" height="2" fill={SPRAY} />
  </Pixels>
}

function Lake() {
  return <Pixels>
    <rect x="0" y="9" width="16" height="6" fill={WATER} />
    <rect x="0" y="9" width="16" height="1" fill={GRASS} />
    <rect x="2" y="8" width="12" height="1" fill={WOOD} />
    <rect x="4" y="7" width="8" height="1" fill={WOOD} />
    <rect x="4" y="5" width="1" height="2" fill={TRUNK} />
    <rect x="11" y="5" width="1" height="2" fill={TRUNK} />
    <rect x="4" y="5" width="8" height="1" fill={TRUNK} />
    <rect x="3" y="12" width="2" height="1" fill={LEAVES_LIGHT} />
    <rect x="11" y="13" width="2" height="1" fill={LEAVES_LIGHT} />
  </Pixels>
}

function Pier() {
  return <Pixels>
    <rect x="0" y="10" width="16" height="6" fill={WATER} />
    <rect x="0" y="8" width="16" height="2" fill={STONE} />
    <rect x="6" y="10" width="4" height="2" fill={WOOD} />
    <rect x="6" y="12" width="1" height="3" fill={TRUNK} />
    <rect x="9" y="12" width="1" height="3" fill={TRUNK} />
    <rect x="11" y="3" width="4" height="5" fill="#8fb7d4" />
    <rect x="10" y="2" width="6" height="1" fill={ROOF} />
    <rect x="2" y="6" width="1" height="2" fill={DARK} />
  </Pixels>
}

function Boats() {
  return <Pixels>
    <rect x="0" y="10" width="16" height="6" fill={WATER} />
    <rect x="0" y="8" width="16" height="2" fill={STONE} />
    <rect x="6" y="10" width="3" height="2" fill={WOOD} />
    <rect x="10" y="12" width="5" height="2" fill={ROOF} />
    <rect x="12" y="5" width="1" height="7" fill={TRUNK} />
    <rect x="10" y="6" width="2" height="5" fill={PAINT} />
    <rect x="9" y="9" width="1" height="2" fill={PAINT} />
    <rect x="1" y="12" width="4" height="2" fill={PAINT} />
  </Pixels>
}

function ClockTower() {
  return <Pixels>
    <rect x="5" y="6" width="6" height="9" fill={BRICK} />
    <rect x="5" y="5" width="6" height="1" fill={PAINT} />
    <rect x="6" y="6" width="4" height="4" fill={PAINT} />
    <rect x="7" y="7" width="1" height="2" fill={DARK} />
    <rect x="8" y="8" width="1" height="1" fill={DARK} />
    <rect x="4" y="4" width="8" height="1" fill={TEAL} />
    <rect x="5" y="3" width="6" height="1" fill={TEAL} />
    <rect x="6" y="2" width="4" height="1" fill={TEAL} />
    <rect x="7" y="1" width="2" height="1" fill={TEAL} />
    <rect x="7" y="12" width="2" height="3" fill={TRUNK} />
    <rect x="2" y="15" width="12" height="1" fill={STONE} />
  </Pixels>
}

function LargePark() {
  return <Pixels>
    <rect x="0" y="12" width="16" height="4" fill={GRASS} />
    <rect x="4" y="3" width="8" height="2" fill={ROOF} />
    <rect x="5" y="2" width="6" height="1" fill={ROOF} />
    <rect x="7" y="1" width="2" height="1" fill={PAINT} />
    <rect x="5" y="5" width="1" height="6" fill={PAINT} />
    <rect x="10" y="5" width="1" height="6" fill={PAINT} />
    <rect x="4" y="11" width="8" height="1" fill={BENCH} />
    <Tree x={0} y={6} />
    <Tree x={12} y={5} />
  </Pixels>
}
