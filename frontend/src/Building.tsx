// One company's building, 4 × 4 to 10 × 10 cells and one to ten storeys as the company grows. Seven looks,
// all built the same way: a recessed glass lobby, corner pillars running to the roof, upper floors with
// pixel window textures (some windows lit), a cornice and parapet, and a roof that differs by style: plant
// and an antenna, a water tank, a roof garden, a sawtooth roof, a hipped roof, a dome or a helipad.
//
// Each style comes in a few colourways; the company's seed picks one. The lit windows show the company at
// work: dark while nobody is working, more of them lit as more employees work (the seed picks which), and
// cartoon shout strokes flicker off both sides meanwhile.
//
// When the company is open the building is cut away to its ground floor: the two back walls stay solid,
// the two walls facing the camera are nearly clear, and one open-plan office floor shows inside: stone
// tiles, wood under the desks and the lounge, carpet under the meeting table, and every employee, who
// work at their desks and wander about when idle. The office is rolled from the company's seed and its
// head count: the layout (office.ts) and every colour in it, so it is rearranged whenever someone joins
// or leaves.

import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import * as THREE from 'three'
import { activity, teamBusy, teamReplicas } from './core/model'
import { useStore } from './core/store'
import { boxOnScreen, ISO_DIR, SCREEN_RIGHT, SCREEN_UP } from './camera'
import { CELL, FLOOR_CELLS, growth, hash, rectCenter, spotCenter, type BuildingLook, type BuildingStyle, type Lot, type Spot, type Town } from './layout'
import { Fade } from './Fade'
import { usePrefs } from './prefs'
import { NOOK_COUNTER, NOOK_D, NOOK_W, OFFICE_SCALE, officePlan, WALL, type Area, type OfficePlan } from './office'
import { OfficeCrew, type Amenities, type CrewMember } from './People'
import { headingOf } from './walk'
import { NO_OUTLINE_LAYER } from './PixelPass'
import { propBoxes } from './streetProps'
import { toon, toonMap } from './toon'

// Sizes are given in cells (CELL world units each), the same unit as the ground grid: a person is about one
// cell tall, a floor is two cells high, a window bay is one cell wide.

/** Floor height in world units: two cells. */
export const FLOOR = FLOOR_CELLS * CELL
/** Height of the walls left standing when the building is cut away. */
export const CUT = FLOOR
/** Top of the floor plate inside a cut-away building; above the plot's paving (0.08) so they never fight. */
export const FLOOR_TOP = 0.14
/** Texture pixels per window bay (one cell) and per floor (two cells): 8 per world unit, matched to the pixel-art render. */
const PX = 16
const PY = 32
/** How far the lobby sits back from the footprint edge, under the upper floors: half a cell. */
const LOBBY_INSET = 0.5 * CELL
const BODY_INSET = 0.12
const PILLAR = 0.25 * CELL
/** Parapet round the roof: a quarter of a cell high. */
const PARAPET = 0.25 * CELL
/** Roof equipment is modelled with one unit per cell. */
const KIT = CELL

interface Palette {
  wall: string
  trim: string
  glass: string
  roof: string
  awning: string
  sign: string
  /** Inside face of the walls. */
  inside: string
}

/** Colourways for each style; the first is the original. */
const PALETTES: Record<BuildingStyle, Palette[]> = {
  tower: [
    { wall: '#c9d3e0', trim: '#56637e', glass: '#5b8ab4', roof: '#8a93a6', awning: '#56637e', sign: '#ffcf5a', inside: '#e3e8ef' },
    { wall: '#d8d4cc', trim: '#3d4a4f', glass: '#4f8a8a', roof: '#8f8a80', awning: '#c8643f', sign: '#ffcf5a', inside: '#ece8e0' },
    { wall: '#bfc8d9', trim: '#2f3a5a', glass: '#7f9fd0', roof: '#7d859a', awning: '#d9a13b', sign: '#8fe3ff', inside: '#e4e8f2' },
    { wall: '#e0e0de', trim: '#7a2f3a', glass: '#5b7fa8', roof: '#9a9a96', awning: '#7a2f3a', sign: '#f1e8da', inside: '#efefec' },
  ],
  brick: [
    { wall: '#b5634a', trim: '#f1e8da', glass: '#4b6c8a', roof: '#7d6a62', awning: '#3f8a5a', sign: '#f1e8da', inside: '#efe4d4' },
    { wall: '#8f4a3c', trim: '#e8dcc4', glass: '#3f5f7a', roof: '#6b5a52', awning: '#2f4f7a', sign: '#ffcf5a', inside: '#ede0d0' },
    { wall: '#c98a5a', trim: '#f5efe2', glass: '#4f7090', roof: '#86705e', awning: '#a8402f', sign: '#f5efe2', inside: '#f2e6d6' },
    { wall: '#7d6a62', trim: '#efe6d6', glass: '#4b6c8a', roof: '#5e504a', awning: '#d9a13b', sign: '#efe6d6', inside: '#ebe4da' },
  ],
  studio: [
    { wall: '#efe5d0', trim: '#2f8f8a', glass: '#6b97b3', roof: '#c8bca6', awning: '#2f8f8a', sign: '#ff8a5c', inside: '#f3ecdd' },
    { wall: '#f2e9dc', trim: '#c8643f', glass: '#6b97b3', roof: '#cbbfa8', awning: '#c8643f', sign: '#3b6fb0', inside: '#f5eee2' },
    { wall: '#e4ead9', trim: '#3f6a4a', glass: '#7aa3b8', roof: '#b9c0a6', awning: '#3f6a4a', sign: '#ffcf5a', inside: '#eef2e6' },
    { wall: '#f0e2e0', trim: '#5b4a8a', glass: '#7f9fc0', roof: '#cdbcb8', awning: '#5b4a8a', sign: '#ff8a5c', inside: '#f6ecea' },
  ],
  loft: [
    { wall: '#8a9096', trim: '#2f3438', glass: '#6f93a8', roof: '#5e6468', awning: '#c8643f', sign: '#ffcf5a', inside: '#e6e4df' },
    { wall: '#6f8a7a', trim: '#26302b', glass: '#7fa3a0', roof: '#4f5e56', awning: '#d9a13b', sign: '#f1e8da', inside: '#e4e8e2' },
    { wall: '#a8604a', trim: '#2c2a2a', glass: '#6b8aa0', roof: '#6a5048', awning: '#3b6fb0', sign: '#f1e8da', inside: '#ece2da' },
  ],
  timber: [
    { wall: '#b98a5a', trim: '#f1e8da', glass: '#5b7fa0', roof: '#6b4a33', awning: '#3f8a5a', sign: '#ffcf5a', inside: '#f2e6d4' },
    { wall: '#7d5a3c', trim: '#e8dcc4', glass: '#4f7090', roof: '#4a3424', awning: '#c8643f', sign: '#f1e8da', inside: '#eee2d0' },
    { wall: '#c8b48e', trim: '#4a5a4a', glass: '#6b8aa0', roof: '#5a4a3a', awning: '#4a5a4a', sign: '#ff8a5c', inside: '#f4ecdc' },
  ],
  classic: [
    { wall: '#e2d8c4', trim: '#b8aa8c', glass: '#4f6f8f', roof: '#9aa8a0', awning: '#7a2f3a', sign: '#d9a13b', inside: '#f2ecdf' },
    { wall: '#c9c4bc', trim: '#8f8a80', glass: '#3f5f7a', roof: '#6f9a8a', awning: '#2f4f7a', sign: '#d9a13b', inside: '#eceae4' },
    { wall: '#e8cfc0', trim: '#c09a84', glass: '#4b6c8a', roof: '#a8b8c0', awning: '#3f6a4a', sign: '#f1e8da', inside: '#f5e9e0' },
  ],
  tech: [
    { wall: '#2f3a4a', trim: '#1c2430', glass: '#3f6f9a', roof: '#3a4452', awning: '#1c2430', sign: '#8fe3ff', inside: '#e3e8ef' },
    { wall: '#3a3048', trim: '#221c2c', glass: '#5a4f9a', roof: '#443a52', awning: '#221c2c', sign: '#ff7ad9', inside: '#ebe6f0' },
    { wall: '#e8ecf0', trim: '#9aa4b0', glass: '#2f5f7f', roof: '#c4ccd4', awning: '#2f5f7f', sign: '#7affb0', inside: '#f0f3f6' },
  ],
  // plaster between red posts, paper-lattice windows, a dark tiled roof
  pagoda: [
    { wall: '#efe4cc', trim: '#a8322a', glass: '#f3e6c4', roof: '#3a4048', awning: '#a8322a', sign: '#e5b33a', inside: '#f4ecdc' },
    { wall: '#e8dcc0', trim: '#5b3a26', glass: '#efe2c0', roof: '#2f4a3a', awning: '#5b3a26', sign: '#e5b33a', inside: '#f2eadb' },
    { wall: '#f2ece0', trim: '#2f3a4a', glass: '#f1e6cc', roof: '#4a3a5a', awning: '#c8643f', sign: '#ffcf5a', inside: '#f5f0e6' },
  ],
  // cream stone, gold lines, a stepped crown
  deco: [
    { wall: '#ead9b8', trim: '#3a4a5a', glass: '#4f6f8f', roof: '#c9b48e', awning: '#3a4a5a', sign: '#d9a13b', inside: '#f3ead8' },
    { wall: '#d8c8d8', trim: '#3a2f4a', glass: '#5a5f8f', roof: '#b8a8b8', awning: '#3a2f4a', sign: '#e5b33a', inside: '#efe8ef' },
    { wall: '#c8dcd4', trim: '#2a4a46', glass: '#3f6f7a', roof: '#a8c0b8', awning: '#2a4a46', sign: '#e5b33a', inside: '#e8f0ec' },
  ],
  // bare concrete, wide glass, a balcony of plants on every floor
  eco: [
    { wall: '#c4c2bc', trim: '#6b6a64', glass: '#6f97a8', roof: '#8f8d86', awning: '#3f8a5a', sign: '#b8e07a', inside: '#ecebe6' },
    { wall: '#d4cfc2', trim: '#5b5a50', glass: '#7fa3a0', roof: '#a09a8c', awning: '#5b7a3a', sign: '#ffcf5a', inside: '#f0ede4' },
    { wall: '#b0b4b8', trim: '#4a4f56', glass: '#5f8aa8', roof: '#82868c', awning: '#2f8f8a', sign: '#b8e07a', inside: '#e8eaec' },
  ],
  // white plaster, painted shutters, a terracotta roof
  villa: [
    { wall: '#f4f0e6', trim: '#2f6fb0', glass: '#4f7fa8', roof: '#c8643f', awning: '#2f6fb0', sign: '#ffcf5a', inside: '#f6f2ea' },
    { wall: '#f2e6d2', trim: '#2f8a7a', glass: '#4b7a8a', roof: '#b8583a', awning: '#2f8a7a', sign: '#f4f0e6', inside: '#f6eee2' },
    { wall: '#f6ecec', trim: '#a8402f', glass: '#5b7fa0', roof: '#d0784a', awning: '#d9a13b', sign: '#f6ecec', inside: '#f8f0f0' },
  ],
}

/** The colours of a building with this look. */
export function paletteOf({ style, seed }: BuildingLook): Palette {
  const all = PALETTES[style]
  return all[Math.floor(hash(seed, 5) * all.length)]
}

const LIT = ['#ffe08a', '#ffd06a']

type Paint = (g: CanvasRenderingContext2D, x: number, y: number, p: Palette, lit: boolean, seed: number) => void

/** One window bay × one floor of facade, drawn in a PX × PY tile (y down): windows about 0.75 × 1.4 cells. */
const TILES: Record<BuildingStyle, Paint> = {
  // ribbon windows: a glass band per floor with thin mullions and a transom
  tower: (g, x, y, p, lit) => {
    g.fillStyle = p.wall
    g.fillRect(x, y, PX, PY)
    g.fillStyle = lit ? LIT[0] : p.glass
    g.fillRect(x, y + 6, PX, 22)
    g.fillStyle = lit ? LIT[1] : '#7fa8cc'
    g.fillRect(x, y + 6, PX, 1)
    g.fillStyle = p.trim
    g.fillRect(x, y + 6, 1, 22)
    g.fillRect(x, y + 13, PX, 1)
  },
  // punched windows with white frames, a mullion and a sill, in brick
  brick: (g, x, y, p, lit, seed) => {
    g.fillStyle = p.wall
    g.fillRect(x, y, PX, PY)
    g.fillStyle = '#9c513c'
    for (let k = 0; k < 14; k++) g.fillRect(x + Math.floor(hash(seed, k) * PX), y + Math.floor(hash(seed, k, 1) * PY), 2, 1)
    g.fillStyle = p.trim
    g.fillRect(x + 2, y + 5, 12, 22)
    g.fillRect(x + 1, y + 27, 14, 1)
    g.fillStyle = lit ? LIT[0] : p.glass
    g.fillRect(x + 3, y + 6, 10, 20)
    g.fillStyle = p.trim
    g.fillRect(x + 7, y + 6, 2, 20)
    g.fillRect(x + 3, y + 13, 10, 1)
  },
  // big panes behind timber fins
  studio: (g, x, y, p, lit) => {
    g.fillStyle = p.wall
    g.fillRect(x, y, PX, PY)
    g.fillStyle = lit ? LIT[0] : p.glass
    g.fillRect(x + 1, y + 3, 14, 26)
    g.fillStyle = lit ? LIT[1] : '#8db5cc'
    g.fillRect(x + 1, y + 3, 14, 1)
    g.fillStyle = '#b07a48'
    g.fillRect(x + 5, y + 3, 1, 26)
    g.fillRect(x + 10, y + 3, 1, 26)
  },
  // corrugated siding round a big steel-framed window of small panes
  loft: (g, x, y, p, lit) => {
    g.fillStyle = p.wall
    g.fillRect(x, y, PX, PY)
    g.fillStyle = 'rgb(0 0 0 / 0.14)'
    for (let k = 0; k < PX; k += 2) g.fillRect(x + k, y, 1, PY)
    g.fillStyle = p.trim
    g.fillRect(x + 1, y + 5, 14, 22)
    g.fillStyle = lit ? LIT[0] : p.glass
    g.fillRect(x + 2, y + 6, 12, 20)
    g.fillStyle = p.trim
    g.fillRect(x + 6, y + 6, 1, 20)
    g.fillRect(x + 10, y + 6, 1, 20)
    g.fillRect(x + 2, y + 13, 12, 1)
    g.fillRect(x + 2, y + 20, 12, 1)
  },
  // boards, a small window with shutters either side
  timber: (g, x, y, p, lit) => {
    g.fillStyle = p.wall
    g.fillRect(x, y, PX, PY)
    g.fillStyle = 'rgb(0 0 0 / 0.16)'
    for (let k = 3; k < PY; k += 4) g.fillRect(x, y + k, PX, 1)
    g.fillStyle = p.awning
    g.fillRect(x + 1, y + 8, 3, 16)
    g.fillRect(x + 12, y + 8, 3, 16)
    g.fillStyle = p.trim
    g.fillRect(x + 4, y + 7, 8, 18)
    g.fillStyle = lit ? LIT[0] : p.glass
    g.fillRect(x + 5, y + 8, 6, 16)
    g.fillStyle = p.trim
    g.fillRect(x + 7.5, y + 8, 1, 16)
    g.fillRect(x + 5, y + 15, 6, 1)
  },
  // dressed stone, a tall arched window with a keystone and a sill
  classic: (g, x, y, p, lit) => {
    g.fillStyle = p.wall
    g.fillRect(x, y, PX, PY)
    g.fillStyle = p.trim
    for (let k = 0; k < PY; k += 6) g.fillRect(x, y + k, PX, 1)
    g.fillRect(x, y + 30, PX, 2)
    g.fillStyle = lit ? LIT[0] : p.glass
    g.fillRect(x + 4, y + 10, 8, 17)
    g.fillRect(x + 5, y + 8, 6, 2)
    g.fillRect(x + 6, y + 7, 4, 1)
    g.fillStyle = p.trim
    g.fillRect(x + 7, y + 5, 2, 2)
    g.fillRect(x + 3, y + 27, 10, 2)
    g.fillRect(x + 7.5, y + 10, 1, 17)
  },
  // a dark curtain wall: glass from slab to slab, a glowing strip along each floor
  tech: (g, x, y, p, lit) => {
    g.fillStyle = lit ? LIT[1] : p.glass
    g.fillRect(x, y, PX, PY)
    g.fillStyle = 'rgb(255 255 255 / 0.18)'
    g.fillRect(x + 2, y + 4, 1, 20)
    g.fillRect(x + 3, y + 4, 1, 10)
    g.fillStyle = p.wall
    g.fillRect(x, y + 27, PX, 5)
    g.fillStyle = p.sign
    g.fillRect(x, y + 28, PX, 1)
    g.fillStyle = p.trim
    g.fillRect(x, y, 1, PY)
  },
  // plaster between posts, a window of paper panes in a wooden lattice
  pagoda: (g, x, y, p, lit) => {
    g.fillStyle = p.wall
    g.fillRect(x, y, PX, PY)
    g.fillStyle = p.trim
    g.fillRect(x, y, 2, PY)
    g.fillRect(x + 2, y + 5, 12, 22)
    g.fillStyle = lit ? LIT[0] : p.glass
    g.fillRect(x + 3, y + 6, 10, 20)
    g.fillStyle = p.trim
    for (let k = 3; k < 13; k += 3) g.fillRect(x + 3 + k - 1, y + 6, 1, 20)
    for (let k = 4; k < 20; k += 4) g.fillRect(x + 3, y + 6 + k, 10, 1)
  },
  // stone pilasters with a gold line, a tall window under a chevron, a dark spandrel with a zigzag
  deco: (g, x, y, p, lit) => {
    g.fillStyle = p.wall
    g.fillRect(x, y, PX, PY)
    g.fillStyle = 'rgb(0 0 0 / 0.08)'
    g.fillRect(x, y, 3, PY)
    g.fillStyle = p.sign
    g.fillRect(x + 1, y, 1, PY)
    g.fillStyle = lit ? LIT[0] : p.glass
    g.fillRect(x + 5, y + 6, 8, 19)
    g.fillStyle = p.sign
    g.fillRect(x + 8, y + 2, 2, 1)
    g.fillRect(x + 7, y + 3, 4, 1)
    g.fillRect(x + 6, y + 4, 6, 1)
    g.fillStyle = p.trim
    g.fillRect(x + 4, y + 26, PX - 4, 6)
    g.fillStyle = p.sign
    for (let k = 0; k < 12; k += 2) g.fillRect(x + 4 + k, y + 28 + (k % 4 ? 1 : 0), 2, 1)
  },
  // wide glass, then a planter of leaves along the balcony, some hanging over
  eco: (g, x, y, p, lit, seed) => {
    g.fillStyle = p.wall
    g.fillRect(x, y, PX, PY)
    g.fillStyle = lit ? LIT[0] : p.glass
    g.fillRect(x + 1, y + 2, 14, 18)
    g.fillStyle = p.trim
    g.fillRect(x + 8, y + 2, 1, 18)
    g.fillRect(x, y + 20, PX, 1)
    for (let k = 0; k < PX; k++) {
      const v = hash(seed, k, 3)
      g.fillStyle = v < 0.5 ? '#4fa848' : '#62b955'
      g.fillRect(x + k, y + 21 - Math.floor(v * 3), 1, 6 + Math.floor(v * 3))
      if (v > 0.8) g.fillRect(x + k, y + 27, 1, 3)
    }
    g.fillStyle = '#3e8f55'
    g.fillRect(x, y + 26, PX, 1)
  },
  // white plaster with a little texture, an arched window between two shutters
  villa: (g, x, y, p, lit, seed) => {
    g.fillStyle = p.wall
    g.fillRect(x, y, PX, PY)
    g.fillStyle = 'rgb(0 0 0 / 0.05)'
    for (let k = 0; k < 10; k++) g.fillRect(x + Math.floor(hash(seed, k, 4) * PX), y + Math.floor(hash(seed, k, 5) * PY), 2, 1)
    g.fillStyle = p.trim
    g.fillRect(x + 1, y + 9, 3, 17)
    g.fillRect(x + 12, y + 9, 3, 17)
    g.fillStyle = 'rgb(0 0 0 / 0.18)'
    for (let k = 11; k < 26; k += 3) {
      g.fillRect(x + 1, y + k, 3, 1)
      g.fillRect(x + 12, y + k, 3, 1)
    }
    g.fillStyle = lit ? LIT[0] : p.glass
    g.fillRect(x + 5, y + 9, 6, 17)
    g.fillRect(x + 6, y + 8, 4, 1)
    g.fillStyle = p.trim
    g.fillRect(x + 4, y + 26, 8, 1)
    g.fillStyle = '#c8643f'
    g.fillRect(x + 5, y + 27, 6, 2)
    g.fillStyle = '#62b955'
    g.fillRect(x + 5, y + 26, 2, 1)
    g.fillRect(x + 9, y + 26, 2, 1)
  },
}

function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  draw(c.getContext('2d') as CanvasRenderingContext2D)
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.magFilter = THREE.NearestFilter
  t.minFilter = THREE.NearestFilter
  t.generateMipmaps = false
  return t
}

/** Facade for one side: `bays` wide, `floors` high; the share `lit` of its windows is lit. */
function facade(style: BuildingStyle, p: Palette, bays: number, floors: number, seed: number, lit: number) {
  return canvasTexture(bays * PX, floors * PY, (g) => {
    for (let f = 0; f < floors; f++) for (let c = 0; c < bays; c++) {
      TILES[style](g, c * PX, f * PY, p, hash(seed, c, f) < lit, seed + c * 13 + f * 7)
    }
  })
}

/** Ground-floor shopfront: glass panes, a header and kick plate in the trim colour, warm light inside the share `lit` of them. */
function lobby(p: Palette, bays: number, seed: number, lit: number) {
  return canvasTexture(bays * PX, PY, (g) => {
    g.fillStyle = '#3b5670'
    g.fillRect(0, 0, bays * PX, PY)
    for (let c = 0; c < bays; c++) {
      if (hash(seed, c, 9) < lit) {
        g.fillStyle = '#f2cf86'
        g.fillRect(c * PX + 3, 10, 10, 18)
      }
      g.fillStyle = p.trim
      g.fillRect(c * PX, 0, 1, PY)
    }
    g.fillStyle = p.trim
    g.fillRect(0, 0, bays * PX, 4)
    g.fillRect(0, PY - 3, bays * PX, 3)
  })
}

type V3 = [number, number, number]

function B({ p, s, c, r, shadow = true }: { p: V3; s: V3; c: string; r?: V3; shadow?: boolean }) {
  return (
    <mesh position={p} rotation={r} scale={s} material={toon(c)} castShadow={shadow} receiveShadow>
      <boxGeometry />
    </mesh>
  )
}

function Part({ p, c, children }: { p: V3; c: string; children: ReactNode }) {
  return <mesh position={p} material={toon(c)} castShadow receiveShadow>{children}</mesh>
}

export function Building({ lot, town, open, another, hover, onHover, onSelect }: {
  lot: Lot
  town: Town
  open: boolean
  /** Another company is open. This building then fades out once its plot leaves the screen, as it may still rise into view. */
  another: boolean
  /** Under the pointer while no company is open: shaded to show it can be clicked. */
  hover: boolean
  onHover: (id: string, on: boolean) => void
  onSelect: (id: string) => void
}) {
  const [x, z] = rectCenter(town, lot.building)
  const detail = usePrefs((s) => s.detail)
  const grounds = useMemo(() => plotBoxes(town, lot, detail), [town, lot, detail])
  const [hidden, setHidden] = useState(false)
  const busy = useStore((s) => teamBusy(s.world, lot.id))
  const size = useThree((s) => s.size)
  const plot = useMemo(() => {
    const [px, pz] = rectCenter(town, lot.plot)
    return { x: px, z: pz, w: lot.plot.w * CELL, d: lot.plot.d * CELL, height: 0 }
  }, [town, lot])
  // the camera moves every frame during a flight and on the player's zoom; React skips the render when nothing changed
  useFrame(({ camera }) => setHidden(another && !boxOnScreen(plot, camera.position, camera.zoom, size)))
  const click = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation()
    // a press that moved was a pan, not a click
    if (e.delta <= 5) onSelect(lot.id)
  }
  return (
    <group position={[x, 0, z]} onClick={click}
      onPointerOver={(e) => { e.stopPropagation(); onHover(lot.id, true); document.body.style.cursor = open ? '' : 'pointer' }}
      onPointerOut={() => { onHover(lot.id, false); document.body.style.cursor = '' }}>
      {/* the whole building fades out as the cut-away fades in, and back */}
      <Fade show={!open && !hidden}><Exterior look={lot} w={lot.building.w * CELL} d={lot.building.d * CELL} floors={lot.floors} busy={busy} /></Fade>
      {/* the paved plot and its street furniture count as the building too, for the pointer and the shade */}
      {!hidden && <PlotHit boxes={grounds} />}
      <Shade lot={lot} grounds={grounds} on={hover && !open && !hidden} />
      <Fade show={open}><CutAway lot={lot} /></Fade>
    </group>
  )
}

/** A new company's building as it will first stand, on the plot picked for it, while its sheet is open. */
export function BuildingPreview({ look, at }: { look: BuildingLook; at: Spot }) {
  const [x, z] = spotCenter(at)
  const { size, floors } = growth(0, 0)
  return (
    <group position={[x, 0, z]}>
      <Exterior look={look} w={size * CELL} d={size * CELL} floors={floors} />
    </group>
  )
}

/** Shares of lit upper windows and lobby panes for `busy` employees at work; none given is a building with no company yet. */
export function litShares(busy?: number): { windows: number; lobby: number } {
  if (busy === undefined) return { windows: 0.17, lobby: 0.6 }
  if (busy <= 0) return { windows: 0, lobby: 0 }
  return { windows: Math.min(0.12 + 0.12 * busy, 0.72), lobby: Math.min(0.4 + 0.2 * busy, 1) }
}

function Exterior({ look, w, d, floors, busy }: { look: BuildingLook; w: number; d: number; floors: number; busy?: number }) {
  const { style, seed } = look
  const pal = paletteOf(look)
  const h = floors * FLOOR
  const upper = floors - 1
  const lit = litShares(busy)

  // box faces: +x, -x, +y, -y, +z, -z
  const body = useMemo(() => {
    // a single storey has no upper floors to face
    if (!upper) return []
    const side = (len: number, k: number) => toonMap('#ffffff', facade(style, pal, len / CELL, upper, seed + k, lit.windows))
    return [side(d, 1), side(d, 2), toon(pal.wall), toon(pal.wall), side(w, 3), side(w, 4)]
  }, [style, pal, upper, seed, w, d, lit.windows])
  const shop = useMemo(() => {
    const side = (len: number, k: number) => toonMap('#ffffff', lobby(pal, len / CELL, seed + k, lit.lobby))
    return [side(d, 5), side(d, 6), toon(pal.trim), toon(pal.trim), side(w, 7), side(w, 8)]
  }, [pal, seed, w, d, lit.lobby])
  useEffect(() => () => {
    for (const m of [...body, ...shop]) if (m.map) {
      m.map.dispose()
      m.dispose()
    }
  }, [body, shop])

  const px = w / 2 - PILLAR / 2
  const pz = d / 2 - PILLAR / 2
  return (
    <>
      {/* ground floor, set back under the floors above */}
      <mesh position={[0, FLOOR / 2, 0]} material={shop} castShadow receiveShadow>
        <boxGeometry args={[w - LOBBY_INSET * 2, FLOOR, d - LOBBY_INSET * 2]} />
      </mesh>
      {/* upper floors */}
      {upper > 0 && (
        <mesh position={[0, FLOOR + (h - FLOOR) / 2, 0]} material={body} castShadow receiveShadow>
          <boxGeometry args={[w - BODY_INSET * 2, h - FLOOR, d - BODY_INSET * 2]} />
        </mesh>
      )}
      {/* corner pillars, ground to roof */}
      {[[px, pz], [-px, pz], [px, -pz], [-px, -pz]].map(([cx, cz], i) => (
        <B key={i} p={[cx, h / 2, cz]} s={[PILLAR, h, PILLAR]} c={pal.trim} />
      ))}
      {/* band over the lobby; brick buildings get a thin cornice on every floor */}
      <B p={[0, FLOOR + 0.08, 0]} s={[w, 0.16, d]} c={pal.trim} />
      {style === 'brick' && Array.from({ length: upper - 1 }, (_, f) => (
        <B key={f} p={[0, FLOOR * (f + 2), 0]} s={[w - 0.1, 0.08, d - 0.1]} c={pal.trim} />
      ))}
      {/* pagoda: a flared eave over every storey */}
      {style === 'pagoda' && Array.from({ length: upper }, (_, f) => (
        <group key={f} position={[0, FLOOR * (f + 2) - 0.02, 0]}>
          <B p={[0, 0, 0]} s={[w + 0.9, 0.1, d + 0.9]} c={pal.roof} />
          <B p={[0, -0.1, 0]} s={[w + 0.5, 0.1, d + 0.5]} c={pal.trim} />
        </group>
      ))}
      {/* deco: gold bands at the setbacks */}
      {style === 'deco' && Array.from({ length: upper - 1 }, (_, f) => (f + 2) % 3 === 0 && (
        <B key={f} p={[0, FLOOR * (f + 2), 0]} s={[w + 0.04, 0.1, d + 0.04]} c={pal.sign} />
      ))}
      {/* eco: a hedge along the balcony of every storey */}
      {style === 'eco' && Array.from({ length: upper }, (_, f) => (
        <group key={f} position={[0, FLOOR * (f + 1) + 0.05, 0]}>
          <B p={[0, 0, 0]} s={[w + 0.5, 0.1, d + 0.5]} c={pal.trim} />
          <B p={[0, 0.25, 0]} s={[w + 0.4, 0.4, d + 0.4]} c={f % 2 ? '#4fa848' : '#62b955'} />
        </group>
      ))}
      {/* villa: a balcony with railings on the front of the first floor */}
      {style === 'villa' && upper > 0 && (
        <group position={[0, FLOOR + 0.16, d / 2]}>
          <B p={[0, 0, 0.35]} s={[2.6 * CELL, 0.12, 0.7]} c={pal.wall} />
          <B p={[0, 0.4, 0.68]} s={[2.6 * CELL, 0.06, 0.06]} c={pal.trim} />
          {Array.from({ length: 11 }, (_, i) => <B key={i} p={[-1.3 * CELL + i * 0.26 * CELL, 0.2, 0.68]} s={[0.05, 0.4, 0.05]} c={pal.trim} />)}
        </group>
      )}
      {/* entrance on the side facing the camera */}
      {/* entrance: two cells wide, glass doors just under the lobby band */}
      <B p={[0, (2 * CELL - 0.3) / 2, d / 2 - LOBBY_INSET + 0.03]} s={[2 * CELL, 2 * CELL - 0.3, 0.06]} c="#2c3f52" />
      <B p={[0, (2 * CELL - 0.3) / 2, d / 2 - LOBBY_INSET + 0.07]} s={[0.12, 2 * CELL - 0.3, 0.04]} c={pal.trim} />
      <B p={[0, 2 * CELL - 0.3, d / 2 - LOBBY_INSET / 2]} s={[2.5 * CELL, 0.16, LOBBY_INSET]} c={pal.awning} />
      {/* sign over the lobby on the other visible side */}
      <B p={[w / 2 - 0.04, FLOOR + 0.5 * CELL, 0]} s={[0.06, 0.5 * CELL, 3 * CELL]} c={pal.sign} />
      {/* cornice, roof deck, parapet */}
      <B p={[0, h + 0.08, 0]} s={[w, 0.16, d]} c={pal.trim} />
      <B p={[0, h + 0.17, 0]} s={[w - 0.4, 0.02, d - 0.4]} c={pal.roof} />
      <B p={[0, h + 0.16 + PARAPET / 2, d / 2 - 0.1]} s={[w, PARAPET, 0.2]} c={pal.trim} />
      <B p={[0, h + 0.16 + PARAPET / 2, -d / 2 + 0.1]} s={[w, PARAPET, 0.2]} c={pal.trim} />
      <B p={[w / 2 - 0.1, h + 0.16 + PARAPET / 2, 0]} s={[0.2, PARAPET, d]} c={pal.trim} />
      <B p={[-w / 2 + 0.1, h + 0.16 + PARAPET / 2, 0]} s={[0.2, PARAPET, d]} c={pal.trim} />
      <group position={[0, h + 0.18, 0]} scale={KIT}>
        <Roof style={style} w={w / KIT} d={d / KIT} pal={pal} />
      </group>
      {!!busy && <Shout w={w} d={d} h={h} seed={seed} />}
    </>
  )
}

/** How dark the hover shade gets (blended in linear light, so this reads as about a quarter darker on screen), and how fast it comes and goes. */
const SHADE = 0.5
const SHADE_RATE = 8

/**
 * A building's plot, as boxes centred on the building: thin layers over the paving round it (not under it,
 * so nothing is shaded twice), and the lamps, planters and benches on it, part for part as `propBoxes` draws them.
 */
export function plotBoxes(town: Town, lot: Lot, detail: boolean): Array<[V3, V3]> {
  const [bx, bz] = rectCenter(town, lot.building)
  const { plot, building: b } = lot
  // the paving in four strips: in front of and behind the building across the plot, then either side of it
  const strips = [
    { x: plot.x, z: plot.z, w: plot.w, d: b.z - plot.z },
    { x: plot.x, z: b.z + b.d, w: plot.w, d: plot.z + plot.d - b.z - b.d },
    { x: plot.x, z: b.z, w: b.x - plot.x, d: b.d },
    { x: b.x + b.w, z: b.z, w: plot.x + plot.w - b.x - b.w, d: b.d },
  ].filter((r) => r.w > 0 && r.d > 0)
  const out: Array<[V3, V3]> = strips.map((r) => {
    const [x, z] = rectCenter(town, r)
    return [[x - bx, 0.06, z - bz], [r.w * CELL, 0.12, r.d * CELL]]
  })
  for (const p of propBoxes(town, lot, detail)) out.push([[p.p[0] - bx, p.p[1], p.p[2] - bz], [p.s[0] + 0.02, p.s[1] + 0.02, p.s[2] + 0.02]])
  return out
}

/** Neither seen nor shadowing, only there for the pointer. */
const unseen = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false })

function PlotHit({ boxes }: { boxes: Array<[V3, V3]> }) {
  return (
    <>
      {boxes.map(([p, s], i) => (
        <mesh key={i} position={p} scale={s} material={unseen}><boxGeometry /></mesh>
      ))}
    </>
  )
}

/** A see-through grey box over the building, and layers over its plot, while the pointer is on it: it can be clicked. */
function Shade({ lot, grounds, on }: { lot: Lot; grounds: Array<[V3, V3]>; on: boolean }) {
  const w = lot.building.w * CELL
  const d = lot.building.d * CELL
  const h = lot.floors * FLOOR + 0.16 + PARAPET
  const ref = useRef<THREE.Group>(null)
  const mat = useMemo(() => new THREE.MeshBasicMaterial({ color: '#1c1f2e', transparent: true, opacity: 0, depthWrite: false }), [])
  useEffect(() => () => mat.dispose(), [mat])
  useLayoutEffect(() => ref.current?.traverse((o) => o.layers.set(NO_OUTLINE_LAYER)), [grounds])
  useFrame((_, dt) => {
    const to = on ? SHADE : 0
    mat.opacity += Math.sign(to - mat.opacity) * Math.min(Math.abs(to - mat.opacity), SHADE * SHADE_RATE * dt)
    if (ref.current) ref.current.visible = mat.opacity > 0.001
  })
  const boxes: Array<[V3, V3]> = [[[0, h / 2, 0], [w + 0.06, h + 0.04, d + 0.06]], ...grounds]
  // drawn over the building and its plot, never picked by the pointer itself
  return (
    <group ref={ref}>
      {boxes.map(([p, s], i) => (
        <mesh key={i} position={p} scale={s} material={mat} raycast={() => null} renderOrder={2}><boxGeometry /></mesh>
      ))}
    </group>
  )
}

// ---------------------------------------------------------------- cut away

/** Walls facing the camera: nearly clear, never shadowing the room, and left out of the outline pass. */
const FRONT_OPACITY = 0.15
const fronts = new Map<string, THREE.Material>()
function frontWall(color: string) {
  let m = fronts.get(color)
  if (!m) {
    m = toon(color).clone()
    m.transparent = true
    m.opacity = FRONT_OPACITY
    m.depthWrite = false
    fronts.set(color, m)
  }
  return m
}

export function Clear({ p, s, c }: { p: V3; s: V3; c: string }) {
  const ref = useRef<THREE.Mesh>(null)
  useLayoutEffect(() => ref.current?.layers.set(NO_OUTLINE_LAYER), [])
  return (
    <mesh ref={ref} position={p} scale={s} material={frontWall(c)}>
      <boxGeometry />
    </mesh>
  )
}

/** The ground floor only: solid back walls, clear front walls, and the office inside. */
function CutAway({ lot }: { lot: Lot }) {
  const w = lot.building.w * CELL
  const d = lot.building.d * CELL
  const pal = paletteOf(lot)
  const hx = w / 2 - WALL / 2
  const hz = d / 2 - WALL / 2
  // the room is rolled again whenever the head count changes, and only then, so the walking grid isn't
  // rebuilt every update
  const people = useStore((s) => teamReplicas(s.world, lot.id).length)
  const seed = Math.floor(hash(lot.seed, people, 77) * 2 ** 31)
  const plan = useMemo(() => officePlan(people, w, CELL, seed), [people, w, seed])
  const decor = useMemo(() => decorOf(seed), [seed])
  // windows along the back wall stay clear of the bookshelf, on whichever side it is
  const shelfGap = plan.shelf ? 6.4 : 1.2
  const [wx0, wx1] = plan.mirror ? [-w / 2 + 1.2, w / 2 - shelfGap] : [-w / 2 + shelfGap, w / 2 - 1.2]
  return (
    <>
      <B p={[0, FLOOR_TOP / 2, 0]} s={[w - WALL, FLOOR_TOP, d - WALL]} c="#d9cdb6" />
      {/* stone tiles over the whole floor, one texture tile per cell so they line up with the ground grid */}
      <Floor kind="tile" variant={decor.tile} a={{ x: 0, z: 0, w: w - WALL, d: d - WALL }} y={FLOOR_TOP + 0.002} perUnit={1} />
      {/* back walls, 100%: painted inside, a skirting board and a row of windows */}
      <B p={[0, CUT / 2, -hz]} s={[w, CUT, WALL]} c={decor.paint ?? pal.inside} />
      <B p={[-hx, CUT / 2, 0]} s={[WALL, CUT, d]} c={decor.paint ?? pal.inside} />
      {/* wall caps cast no shadow: their thin lip over the inside face only drew a dotted line along its top */}
      <B p={[0, CUT + 0.06, -hz]} s={[w, 0.12, WALL + 0.04]} c={pal.trim} shadow={false} />
      <B p={[-hx, CUT + 0.06, 0]} s={[WALL + 0.04, 0.12, d]} c={pal.trim} shadow={false} />
      <B p={[0, FLOOR_TOP + 0.06, -hz + WALL / 2 + 0.02]} s={[w - WALL * 2, 0.12, 0.04]} c={pal.trim} shadow={false} />
      <B p={[-hx + WALL / 2 + 0.02, FLOOR_TOP + 0.06, 0]} s={[0.04, 0.12, d - WALL * 2]} c={pal.trim} shadow={false} />
      {/* a row of windows along each back wall, clear of the bookshelf if there is one */}
      {windowsAlong(wx0, wx1).map((x) => <B key={`z${x}`} p={[x, WINDOW_Y, -hz + WALL / 2 + 0.02]} s={[CELL, WINDOW_H, 0.04]} c={pal.glass} shadow={false} />)}
      {windowsAlong(-d / 2 + 1.2, d / 2 - 1.2).map((z) => <B key={`x${z}`} p={[-hx + WALL / 2 + 0.02, WINDOW_Y, z]} s={[0.04, WINDOW_H, CELL]} c={pal.glass} shadow={false} />)}
      {/* the two walls facing the camera, 15% */}
      <Clear p={[0, CUT / 2, hz]} s={[w, CUT, WALL]} c={pal.wall} />
      <Clear p={[hx, CUT / 2, 0]} s={[WALL, CUT, d - WALL * 2]} c={pal.wall} />
      <Office teamId={lot.id} plan={plan} decor={decor} trim={pal.trim} seed={seed} />
    </>
  )
}

/** Inside windows: one cell wide, 1.3 cells tall, sill 0.4 cell off the floor. */
const WINDOW_H = 1.3 * CELL
const WINDOW_Y = 0.4 * CELL + WINDOW_H / 2
/** Window centres spread evenly between two points on a wall, about one every two cells. */
function windowsAlong(from: number, to: number) {
  const n = Math.max(1, Math.round((to - from) / (2 * CELL)))
  return Array.from({ length: n }, (_, i) => from + ((i + 0.5) * (to - from)) / n)
}

// ---------------------------------------------------------------- the office

/** Everything in an office that comes in more than one colour. Each part is picked on its own. */
interface Decor {
  /** Indices into `TILE_SETS`, `WOOD_SETS` and `CARPET_SETS`, for the floor textures. */
  tile: number
  wood: number
  carpet: number
  /** Desk top and frame; the reception counter's top, the meeting table and shelves too. */
  desk: [string, string]
  chair: string
  /** Seat and back. */
  sofa: [string, string]
  cushions: [string, string]
  /** Border, field and trim. */
  rug: [string, string, string]
  /** Inside of the back walls, or the building's own colour. */
  paint: string | null
  pot: string
  books: string[]
  /** What stands against the back wall in a room big enough: books, a coffee bar, a whiteboard, lockers, a fish tank or servers. */
  back: BackKind
  /** The front corner: a sofa, a ping-pong table, café tables or arcade machines. */
  corner: CornerKind
  /** The back corner: a long meeting table, a round one, or two phone booths. */
  meet: MeetKind
}

const BACK_KINDS = ['books', 'coffee', 'whiteboard', 'lockers', 'aquarium', 'server'] as const
const CORNER_KINDS = ['sofa', 'games', 'cafe', 'arcade'] as const
const MEET_KINDS = ['long', 'round', 'booths'] as const
type BackKind = (typeof BACK_KINDS)[number]
type CornerKind = (typeof CORNER_KINDS)[number]
type MeetKind = (typeof MEET_KINDS)[number]

const DESKS: Array<[string, string]> = [['#a8774e', '#8a5f3c'], ['#e8e2d6', '#b8b0a2'], ['#6b4a33', '#4f3524'], ['#d9b78a', '#b08f64']]
const CHAIRS = ['#56637e', '#2f3a4a', '#c8643f', '#3f8a5a', '#8a5aa8']
const SOFAS: Array<[string, string]> = [['#5b7fa8', '#4a6a8f'], ['#3f8a5a', '#33734a'], ['#c8643f', '#a85234'], ['#d9a13b', '#b8862c'], ['#7d6a8f', '#665677']]
const CUSHIONS: Array<[string, string]> = [['#ffcf5a', '#ff8a5c'], ['#f1e8da', '#5b7fa8'], ['#ff8a5c', '#62b955'], ['#efe2c4', '#c8643f']]
const RUGS: Array<[string, string, string]> = [['#c8643f', '#efe2c4', '#d9a13b'], ['#3b6fb0', '#e8eef5', '#e5b33a'], ['#2f8f8a', '#f1ead8', '#c8643f'], ['#7d4a6a', '#f0e3e8', '#d9a13b']]
const PAINTS = [null, null, '#e4efe6', '#f3e3dc', '#e3e8f2', '#f4ecd6']
const POTS = ['#b0643f', '#e8e2d6', '#56637e', '#3f8a5a']
const BOOKS = ['#d22b1f', '#3b6fb0', '#e5b33a', '#2f8f8a', '#7d6a62', '#8a5aa8', '#f1e8da']

function decorOf(seed: number): Decor {
  const pick = <T,>(k: number, list: readonly T[]) => list[Math.floor(hash(seed, k) * list.length)]
  const index = (k: number, n: number) => Math.floor(hash(seed, k) * n)
  const start = index(11, BOOKS.length)
  return {
    tile: index(1, TILE_SETS.length),
    wood: index(2, WOOD_SETS.length),
    carpet: index(3, CARPET_SETS.length),
    desk: pick(4, DESKS),
    chair: pick(5, CHAIRS),
    sofa: pick(6, SOFAS),
    cushions: pick(7, CUSHIONS),
    rug: pick(8, RUGS),
    paint: pick(9, PAINTS),
    pot: pick(10, POTS),
    books: [...BOOKS.slice(start), ...BOOKS.slice(0, start)].slice(0, 5),
    back: pick(12, BACK_KINDS),
    corner: pick(13, CORNER_KINDS),
    meet: pick(14, MEET_KINDS),
  }
}

const PLANT = '#4fa848'

/** Glowing screens ignore the light. */
const screens = new Map<string, THREE.MeshBasicMaterial>()
const screen = (c: string) => screens.get(c) ?? (screens.set(c, new THREE.MeshBasicMaterial({ color: c })).get(c) as THREE.MeshBasicMaterial)

/** A pot plant: a round bush, a tall slim one, a cactus, a little tree or a monstera. `kind` picks which. */
function Plant({ x, z, pot, kind = 0 }: { x: number; z: number; pot: string; kind?: number }) {
  const y = FLOOR_TOP
  const potBox = <B p={[x, y + 0.18, z]} s={[0.36, 0.36, 0.36]} c={pot} />
  switch (kind % 5) {
    case 1: return (
      <>
        {potBox}
        <B p={[x, y + 0.8, z]} s={[0.06, 0.9, 0.06]} c="#5a7a3a" />
        {[0.55, 0.85, 1.15].map((h, i) => <B key={i} p={[x + (i % 2 ? 0.08 : -0.08), y + h, z]} s={[0.3, 0.18, 0.3]} r={[0, i * 0.6, 0]} c={i % 2 ? PLANT : '#62b955'} />)}
      </>
    )
    case 2: return (
      <>
        <B p={[x, y + 0.12, z]} s={[0.34, 0.24, 0.34]} c={pot} />
        <B p={[x, y + 0.55, z]} s={[0.18, 0.66, 0.18]} c="#4f9a5a" />
        <B p={[x - 0.14, y + 0.6, z]} s={[0.1, 0.06, 0.08]} c="#4f9a5a" />
        <B p={[x - 0.18, y + 0.7, z]} s={[0.08, 0.2, 0.08]} c="#4f9a5a" />
        <B p={[x + 0.14, y + 0.5, z]} s={[0.1, 0.06, 0.08]} c="#4f9a5a" />
        <B p={[x + 0.18, y + 0.6, z]} s={[0.08, 0.18, 0.08]} c="#4f9a5a" />
        <B p={[x, y + 0.9, z]} s={[0.08, 0.06, 0.08]} c="#ff8ab0" />
      </>
    )
    case 3: return (
      <>
        {potBox}
        <B p={[x, y + 0.65, z]} s={[0.08, 0.6, 0.08]} c="#8a5a36" />
        <B p={[x, y + 1.1, z]} s={[0.6, 0.45, 0.6]} c="#3e8f55" />
        <B p={[x + 0.05, y + 1.38, z - 0.05]} s={[0.36, 0.2, 0.36]} c={PLANT} />
      </>
    )
    case 4: return (
      <>
        {potBox}
        {[0, 1, 2, 3].map((i) => (
          <B key={i} p={[x + Math.cos(i * 1.6) * 0.16, y + 0.55 + (i % 2) * 0.15, z + Math.sin(i * 1.6) * 0.16]} s={[0.34, 0.04, 0.24]}
            r={[0.4, i * 1.6, 0]} c={i % 2 ? '#3e8f55' : PLANT} />
        ))}
      </>
    )
    default: return (
      <>
        {potBox}
        <B p={[x, y + 0.6, z]} s={[0.5, 0.5, 0.5]} c={PLANT} />
        <B p={[x, y + 0.95, z]} s={[0.3, 0.26, 0.3]} c="#62b955" />
      </>
    )
  }
}

// ---------------------------------------------------------------- floors

/** Texture pixels per cell (two world units), as on the facades: 8 per world unit. */
const FLOOR_PX = 16

type FloorKind = 'tile' | 'wood' | 'carpet'

/** Colour sets for each floor, as [light, dark, grout], [four plank tones…, joints, grain] and [base, dark, light, seams]. */
const TILE_SETS = [
  ['#e6dfcf', '#ddd5c2', '#c9bfa9'],
  ['#dfe3e6', '#d3d8dc', '#b9c0c6'],
  ['#e9d9c9', '#dfcab6', '#c7ad94'],
  ['#e3e6d8', '#d6dac8', '#bcc1aa'],
]
const WOOD_SETS = [
  ['#c48d58', '#b9824f', '#cc9862', '#bd8752', '#9b6a3e', '#d4a26c'],
  ['#dcb989', '#d2ad7b', '#e3c294', '#d6b281', '#b48c5c', '#ead0a6'],
  ['#8a5a3a', '#7f5234', '#946242', '#845636', '#5f3b24', '#a07050'],
  ['#b9ad9c', '#afa392', '#c2b7a6', '#b3a796', '#8f8473', '#cbc1b2'],
]
const CARPET_SETS = [
  ['#6e84a3', '#62789a', '#7d93b1', '#647a99'],
  ['#6f9a7c', '#628c6f', '#7ea98a', '#658f71'],
  ['#a0606a', '#91545e', '#ad6f78', '#955860'],
  ['#5f646f', '#545964', '#6c717c', '#585d68'],
]

/** One cell of each floor in one of its colour sets, repeated across an area. */
const FLOOR_TILES: Record<FloorKind, (g: CanvasRenderingContext2D, c: string[]) => void> = {
  // two by two stone tiles, faintly checked, with grout lines
  tile: (g, c) => {
    for (let k = 0; k < 4; k++) {
      const x = (k % 2) * 8
      const y = Math.floor(k / 2) * 8
      g.fillStyle = (k === 0 || k === 3) ? c[0] : c[1]
      g.fillRect(x, y, 8, 8)
      g.fillStyle = c[2]
      g.fillRect(x, y, 8, 1)
      g.fillRect(x, y, 1, 8)
    }
  },
  // planks along x, half a world unit wide, with staggered end joints
  wood: (g, c) => {
    for (let r = 0; r < 4; r++) {
      g.fillStyle = c[r]
      g.fillRect(0, r * 4, 16, 4)
      g.fillStyle = c[4]
      g.fillRect(0, r * 4 + 3, 16, 1)
      g.fillRect([3, 11, 7, 14][r], r * 4, 1, 3)
      // a little grain
      g.fillStyle = c[5]
      g.fillRect([9, 2, 12, 5][r], r * 4 + 1, 3, 1)
    }
  },
  // carpet tiles with a speckle
  carpet: (g, c) => {
    g.fillStyle = c[0]
    g.fillRect(0, 0, 16, 16)
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const v = hash(x, y, 21)
      if (v < 0.12) g.fillStyle = c[1]
      else if (v > 0.9) g.fillStyle = c[2]
      else continue
      g.fillRect(x, y, 1, 1)
    }
    g.fillStyle = c[3]
    g.fillRect(0, 0, 16, 1)
    g.fillRect(0, 0, 1, 16)
  },
}
const FLOOR_SETS: Record<FloorKind, string[][]> = { tile: TILE_SETS, wood: WOOD_SETS, carpet: CARPET_SETS }

const floorTextures = new Map<string, THREE.CanvasTexture>()
function floorTexture(kind: FloorKind, variant: number) {
  const key = `${kind}${variant}`
  let t = floorTextures.get(key)
  if (!t) {
    t = canvasTexture(FLOOR_PX, FLOOR_PX, (g) => FLOOR_TILES[kind](g, FLOOR_SETS[kind][variant]))
    t.wrapS = t.wrapT = THREE.RepeatWrapping
    floorTextures.set(key, t)
  }
  return t
}

/**
 * A flat floor covering over an area at height `y`. `perUnit` is world units per unit of the area: 1 for
 * world units, `OFFICE_SCALE` inside the office, so the pattern keeps one tile per cell either way.
 */
function Floor({ kind, variant, a, y, perUnit }: { kind: FloorKind; variant: number; a: Area; y: number; perUnit: number }) {
  const mat = useMemo(() => {
    const map = floorTexture(kind, variant).clone()
    map.repeat.set((a.w * perUnit) / CELL, (a.d * perUnit) / CELL)
    return toonMap('#ffffff', map)
  }, [kind, variant, a.w, a.d, perUnit])
  useEffect(() => () => {
    mat.map?.dispose()
    mat.dispose()
  }, [mat])
  return (
    <mesh position={[a.x, y, a.z]} rotation={[-Math.PI / 2, 0, 0]} scale={[a.w, a.d, 1]} material={mat} receiveShadow>
      <planeGeometry />
    </mesh>
  )
}

/** A woven rug for the lounge: a light field, a coloured border and a row of diamonds. */
function Rug({ a, y, colors: [border, field, trim] }: { a: Area; y: number; colors: [string, string, string] }) {
  const mat = useMemo(() => {
    // texture pixels per office unit, at the same density as the floors
    const k = (FLOOR_PX / CELL) * OFFICE_SCALE
    const w = Math.round(a.w * k)
    const h = Math.round(a.d * k)
    const map = canvasTexture(w, h, (g) => {
      g.fillStyle = border
      g.fillRect(0, 0, w, h)
      g.fillStyle = field
      g.fillRect(2, 2, w - 4, h - 4)
      g.fillStyle = trim
      g.fillRect(4, 4, w - 8, 1)
      g.fillRect(4, h - 5, w - 8, 1)
      g.fillRect(4, 4, 1, h - 8)
      g.fillRect(w - 5, 4, 1, h - 8)
      // diamonds along the middle
      g.fillStyle = border
      const cy = Math.floor(h / 2)
      for (let x = 9; x < w - 8; x += 7) for (let r = 0; r < 3; r++) {
        g.fillRect(x - r, cy - 2 + r, 1 + r * 2, 1)
        g.fillRect(x - r, cy + 2 - r, 1 + r * 2, 1)
      }
    })
    return toonMap('#ffffff', map)
  }, [a.w, a.d, border, field, trim])
  useEffect(() => () => {
    mat.map?.dispose()
    mat.dispose()
  }, [mat])
  return (
    <mesh position={[a.x, y, a.z]} rotation={[-Math.PI / 2, 0, 0]} scale={[a.w, a.d, 1]} material={mat} receiveShadow>
      <planeGeometry />
    </mesh>
  )
}

/** Desk with its screen and chair; `x, z` is the seat. Its person is drawn by `OfficeCrew`. */
/**
 * Desk with its screen and chair; `x, z` is the seat. Its person is drawn by `OfficeCrew`. `setup` picks the
 * screens (one, two, or a laptop) and what else is on the desk (papers, a mug, a lamp, a little plant).
 */
/** A desk and chair with a screen setup; with `detail`, a keyboard and one thing on the desk too. */
function Station({ x, z, busy, k, setup, detail }: { x: number; z: number; busy: boolean; k: Decor; setup: number; detail: boolean }) {
  const y = FLOOR_TOP
  const dz = z - 0.5
  const glow = screen(busy ? '#8fe3ff' : '#2c3f52')
  const monitor = (mx: number, w: number, turn = 0) => (
    <group key={mx} position={[x + mx, 0, dz - 0.15]} rotation={[0, turn, 0]}>
      <B p={[0, y + 0.48, 0]} s={[0.08, 0.1, 0.08]} c="#2c3f52" />
      <mesh position={[0, y + 0.68, -0.02]} scale={[w, 0.34, 0.05]} material={glow} castShadow><boxGeometry /></mesh>
    </group>
  )
  const screens = setup % 3
  const item = detail ? Math.floor(setup / 3) % 4 : -1
  return (
    <>
      <B p={[x, y + 0.19, dz]} s={[1.1, 0.36, 0.5]} c={k.desk[1]} />
      <B p={[x, y + 0.4, dz]} s={[1.2, 0.06, 0.6]} c={k.desk[0]} />
      {screens === 0 && monitor(0, 0.62)}
      {screens === 1 && [monitor(-0.24, 0.46, 0.2), monitor(0.24, 0.46, -0.2)]}
      {screens === 2 && (
        <group position={[x, y + 0.43, dz]}>
          <B p={[0, 0, 0.05]} s={[0.5, 0.03, 0.32]} c="#b8bec8" />
          <mesh position={[0, 0.16, -0.11]} rotation={[-0.25, 0, 0]} scale={[0.5, 0.3, 0.03]} material={glow} castShadow><boxGeometry /></mesh>
        </group>
      )}
      {/* keyboard, then one thing on the desk */}
      {detail && screens !== 2 && <B p={[x, y + 0.44, dz + 0.12]} s={[0.4, 0.02, 0.14]} c="#e8e8e2" shadow={false} />}
      {item === 0 && <B p={[x + 0.42, y + 0.44, dz + 0.05]} s={[0.16, 0.02, 0.22]} c="#f5f5f0" />}
      {item === 1 && <B p={[x + 0.44, y + 0.49, dz + 0.1]} s={[0.1, 0.12, 0.1]} c={k.cushions[0]} />}
      {item === 2 && (
        <group position={[x - 0.44, y + 0.43, dz - 0.1]}>
          <B p={[0, 0.02, 0]} s={[0.16, 0.04, 0.16]} c="#2f3438" />
          <B p={[0, 0.2, 0]} s={[0.03, 0.34, 0.03]} c="#2f3438" />
          <B p={[0.06, 0.37, 0.04]} s={[0.16, 0.08, 0.12]} c={k.cushions[1]} />
        </group>
      )}
      {item === 3 && (
        <group position={[x - 0.44, y + 0.43, dz - 0.1]}>
          <B p={[0, 0.06, 0]} s={[0.12, 0.12, 0.12]} c={k.pot} />
          <B p={[0, 0.18, 0]} s={[0.16, 0.12, 0.16]} c={PLANT} />
        </group>
      )}
      <B p={[x, y + 0.2, z + 0.02]} s={[0.5, 0.06, 0.44]} c={k.chair} />
      <B p={[x, y + 0.36, z + 0.22]} s={[0.5, 0.3, 0.06]} c={k.chair} />
    </>
  )
}

function Reception({ a, trim, k }: { a: Area; trim: string; k: Decor }) {
  return (
    <>
      <B p={[a.x, FLOOR_TOP + 0.3, a.z]} s={[a.w, 0.6, a.d]} c={trim} />
      <B p={[a.x, FLOOR_TOP + 0.63, a.z]} s={[a.w + 0.1, 0.06, a.d + 0.1]} c={k.desk[0]} />
      <B p={[a.x - a.w / 2 + 0.3, FLOOR_TOP + 0.72, a.z]} s={[0.24, 0.12, 0.2]} c="#ff8a5c" />
      {/* a screen for whoever is at the desk, and flowers on the counter */}
      <mesh position={[a.x + 0.1, FLOOR_TOP + 0.84, a.z - 0.12]} scale={[0.4, 0.26, 0.04]} material={screen('#2c3f52')} castShadow><boxGeometry /></mesh>
      <B p={[a.x + a.w / 2 - 0.25, FLOOR_TOP + 0.74, a.z]} s={[0.1, 0.16, 0.1]} c="#e8eef5" />
      <B p={[a.x + a.w / 2 - 0.25, FLOOR_TOP + 0.88, a.z]} s={[0.2, 0.12, 0.2]} c={k.cushions[0]} />
    </>
  )
}

function Meeting({ a, k }: { a: Area; k: Decor }) {
  if (k.meet === 'round') return <RoundTable a={a} k={k} />
  if (k.meet === 'booths') return <Booths a={a} k={k} />
  const y = FLOOR_TOP
  const tw = a.w - 0.8
  const chairs: Array<[number, number]> = []
  // a chair about every 0.8 along each long side
  const n = Math.max(2, Math.floor((a.d - 0.8) / 0.8))
  for (const side of [-1, 1]) for (let i = 0; i < n; i++) chairs.push([a.x + side * (tw / 2 + 0.25), a.z + (i - (n - 1) / 2) * 0.8])
  return (
    <>
      <B p={[a.x, y + 0.2, a.z]} s={[0.3, 0.4, a.d * 0.5]} c={k.desk[1]} />
      <B p={[a.x, y + 0.42, a.z]} s={[tw, 0.06, a.d - 0.4]} c={k.desk[0]} />
      {chairs.map(([cx, cz], i) => <B key={i} p={[cx, y + 0.18, cz]} s={[0.32, 0.3, 0.32]} c={k.chair} />)}
    </>
  )
}

/** A round table with chairs all round it, and a screen on a stand at the far end. */
function RoundTable({ a, k }: { a: Area; k: Decor }) {
  const y = FLOOR_TOP
  const r = Math.min(a.w, a.d) / 2 - 0.55
  return (
    <>
      <Part p={[a.x, y + 0.2, a.z + 0.3]} c={k.desk[1]}><cylinderGeometry args={[0.12, 0.2, 0.4, 8]} /></Part>
      <Part p={[a.x, y + 0.42, a.z + 0.3]} c={k.desk[0]}><cylinderGeometry args={[r, r, 0.06, 16]} /></Part>
      {Array.from({ length: 6 }, (_, i) => {
        const t = (i / 6) * Math.PI * 2
        return <B key={i} p={[a.x + Math.cos(t) * (r + 0.28), y + 0.18, a.z + 0.3 + Math.sin(t) * (r + 0.28)]} s={[0.32, 0.3, 0.32]} r={[0, -t, 0]} c={k.chair} />
      })}
      <B p={[a.x, y + 0.45, a.z - a.d / 2 + 0.25]} s={[0.08, 0.9, 0.08]} c="#2f3438" />
      <mesh position={[a.x, y + 1.05, a.z - a.d / 2 + 0.25]} scale={[1.1, 0.6, 0.05]} material={screen('#3b5670')} castShadow><boxGeometry /></mesh>
    </>
  )
}

/** Two phone booths, one behind the other: walls on three sides and a roof, a seat and a shelf inside, open towards the room. */
function Booths({ a, k }: { a: Area; k: Decor }) {
  const y = FLOOR_TOP
  const bd = a.d / 2 - 0.15
  return (
    <>
      {[-1, 1].map((side) => {
        const z = a.z + side * (bd / 2 + 0.075)
        return (
          <group key={side} position={[a.x, y, z]}>
            <B p={[a.w / 2 - 0.05, 0.75, 0]} s={[0.1, 1.5, bd]} c={k.sofa[1]} />
            <B p={[0, 0.75, -bd / 2 + 0.05]} s={[a.w - 0.2, 1.5, 0.1]} c={k.sofa[1]} />
            <B p={[0, 0.75, bd / 2 - 0.05]} s={[a.w - 0.2, 1.5, 0.1]} c={k.sofa[1]} />
            <B p={[0, 1.52, 0]} s={[a.w - 0.1, 0.06, bd]} c={k.sofa[0]} />
            {/* a padded seat against the back, and a shelf with a laptop */}
            <B p={[a.w / 2 - 0.35, 0.2, 0]} s={[0.4, 0.4, bd - 0.4]} c={k.sofa[0]} />
            <B p={[a.w / 2 - 0.9, 0.45, 0]} s={[0.4, 0.05, bd - 0.5]} c={k.desk[0]} />
            <B p={[a.w / 2 - 0.9, 0.49, 0]} s={[0.24, 0.02, 0.3]} c="#b8bec8" />
          </group>
        )
      })}
    </>
  )
}

/** The front corner: a sofa, or another way to take a break. */
function Corner({ a, k }: { a: Area; k: Decor }) {
  if (k.corner === 'games') return <PingPong a={a} k={k} />
  if (k.corner === 'cafe') return <Cafe a={a} k={k} />
  if (k.corner === 'arcade') return <Arcade a={a} k={k} />
  return <Lounge a={a} k={k} />
}

/** A bean bag: a squashed cushion. */
function BeanBag({ x, z, c }: { x: number; z: number; c: string }) {
  return (
    <>
      <B p={[x, FLOOR_TOP + 0.13, z]} s={[0.62, 0.26, 0.62]} c={c} />
      <B p={[x, FLOOR_TOP + 0.3, z + 0.12]} s={[0.5, 0.18, 0.34]} c={c} />
    </>
  )
}

/** A ping-pong table with its net and two bats, and a bean bag to watch from. */
function PingPong({ a, k }: { a: Area; k: Decor }) {
  const y = FLOOR_TOP
  const tw = Math.min(1.7, a.w - 0.9)
  const td = 0.95
  const cz = a.z - 0.2
  return (
    <>
      {[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sz], i) => <B key={i} p={[a.x + sx * (tw / 2 - 0.12), y + 0.22, cz + sz * (td / 2 - 0.12)]} s={[0.06, 0.44, 0.06]} c="#2f3438" />)}
      <B p={[a.x, y + 0.46, cz]} s={[tw, 0.05, td]} c="#2f7d5a" />
      <B p={[a.x, y + 0.487, cz]} s={[tw, 0.006, 0.03]} c="#f5f5f0" shadow={false} />
      <B p={[a.x, y + 0.487, cz]} s={[0.03, 0.006, td]} c="#f5f5f0" shadow={false} />
      <B p={[a.x, y + 0.55, cz]} s={[0.03, 0.14, td + 0.1]} c="#e8e8e2" />
      <B p={[a.x - tw / 4, y + 0.5, cz + 0.2]} s={[0.14, 0.02, 0.2]} c="#c23b3b" />
      <B p={[a.x + tw / 4, y + 0.5, cz - 0.15]} s={[0.14, 0.02, 0.2]} c="#2f2f38" />
      <B p={[a.x + 0.3, y + 0.51, cz]} s={[0.05, 0.05, 0.05]} c="#f5f5f0" />
      <BeanBag x={a.x - a.w / 2 + 0.5} z={a.z + a.d / 2 - 0.45} c={k.sofa[0]} />
    </>
  )
}

/** Two little round tables with stools, a counter of cups behind them. */
function Cafe({ a, k }: { a: Area; k: Decor }) {
  const y = FLOOR_TOP
  const tables: Array<[number, number]> = [[a.x - a.w / 4, a.z + 0.3], [a.x + a.w / 4, a.z - 0.3]]
  return (
    <>
      {tables.map(([tx, tz], i) => (
        <group key={i}>
          <Part p={[tx, y + 0.25, tz]} c="#2f3438"><cylinderGeometry args={[0.04, 0.12, 0.5, 8]} /></Part>
          <Part p={[tx, y + 0.52, tz]} c={k.desk[0]}><cylinderGeometry args={[0.36, 0.36, 0.04, 14]} /></Part>
          <B p={[tx + 0.1, y + 0.58, tz]} s={[0.09, 0.1, 0.09]} c="#f5f5f0" />
          {[-1, 1].map((s) => (
            <group key={s} position={[tx + s * 0.6, 0, tz]}>
              <Part p={[0, y + 0.18, 0]} c="#2f3438"><cylinderGeometry args={[0.03, 0.08, 0.36, 6]} /></Part>
              <Part p={[0, y + 0.38, 0]} c={k.chair}><cylinderGeometry args={[0.17, 0.17, 0.06, 10]} /></Part>
            </group>
          ))}
        </group>
      ))}
      <B p={[a.x, y + 0.3, a.z - a.d / 2 + 0.22]} s={[a.w - 0.4, 0.6, 0.4]} c={k.desk[1]} />
      <B p={[a.x, y + 0.62, a.z - a.d / 2 + 0.22]} s={[a.w - 0.3, 0.05, 0.46]} c={k.desk[0]} />
      {[-0.6, -0.4, -0.2].map((cx, i) => <B key={i} p={[a.x + cx, y + 0.69, a.z - a.d / 2 + 0.22]} s={[0.1, 0.1, 0.1]} c={i % 2 ? k.cushions[0] : '#f5f5f0'} />)}
      <B p={[a.x + a.w / 2 - 0.5, y + 0.82, a.z - a.d / 2 + 0.22]} s={[0.32, 0.4, 0.28]} c="#2f2f38" />
    </>
  )
}

/** Two arcade cabinets along the back, screens lit, and a bean bag in front of them. */
function Arcade({ a, k }: { a: Area; k: Decor }) {
  const y = FLOOR_TOP
  const colors = [k.chair, k.sofa[0]]
  return (
    <>
      {[-0.45, 0.45].map((cx, i) => (
        <group key={i} position={[a.x + cx, y, a.z - a.d / 2 + 0.35]}>
          <B p={[0, 0.65, 0]} s={[0.6, 1.3, 0.5]} c={colors[i]} />
          <mesh position={[0, 0.95, 0.26]} rotation={[-0.2, 0, 0]} scale={[0.44, 0.34, 0.02]} material={screen(i ? '#ff7ad9' : '#7affb0')}><boxGeometry /></mesh>
          <mesh position={[0, 1.24, 0.26]} scale={[0.5, 0.1, 0.02]} material={screen('#ffcf5a')}><boxGeometry /></mesh>
          <B p={[0, 0.6, 0.32]} s={[0.56, 0.08, 0.2]} c="#2f2f38" />
          <B p={[-0.12, 0.68, 0.34]} s={[0.04, 0.1, 0.04]} c="#c23b3b" />
          <B p={[0.1, 0.65, 0.36]} s={[0.06, 0.03, 0.06]} c="#ffcf5a" />
        </group>
      ))}
      <BeanBag x={a.x} z={a.z + 0.6} c={k.sofa[0]} />
    </>
  )
}

/**
 * Seats on `Lounge`'s sofa for idle people, with the way in: from the open front, up the gap between the
 * side sofa and the table, then across in front of the back sofa. `a` is the lounge as placed in the room.
 */
function loungeSeats(a: Area, mirror: boolean): Amenities['sofa'] {
  const m = mirror ? -1 : 1
  const at = (lx: number, lz: number): [number, number] => [a.x + m * lx, a.z + lz]
  const gap = -a.w / 2 + 0.95
  const entry = at(gap, a.d / 2 + 0.35)
  const stand = -a.d / 2 + 0.95
  return [
    // the side sofa, facing across to the table
    ...[0.1, 0.8].map((lz) => ({ at: at(-a.w / 2 + 0.3, lz), heading: headingOf(m, 0), way: [entry, at(gap, lz)] })),
    // the back sofa, facing the front
    ...[1.15, 1.85].map((dx) => ({ at: at(-a.w / 2 + dx, -a.d / 2 + 0.3), heading: headingOf(0, 1), way: [entry, at(gap, stand), at(-a.w / 2 + dx, stand)] })),
  ]
}

/** Nook layout, about its middle before mirroring: the counter at the left end, then the sofa and its two seats. */
const NOOK_SOFA_X = -NOOK_W / 2 + NOOK_COUNTER + 0.1
const NOOK_SOFA_W = NOOK_W / 2 - NOOK_SOFA_X
const NOOK_SEATS = [NOOK_SOFA_X + NOOK_SOFA_W * 0.27, NOOK_SOFA_X + NOOK_SOFA_W * 0.73]

/** Where in the nook to sit or stand, in office units: the way in goes from its entry to just in front. */
function nookPlaces(plan: OfficePlan) {
  const m = plan.mirror ? -1 : 1
  const wall = plan.nook.z - NOOK_D / 2
  const front = wall + NOOK_D + 0.35
  const x = (lx: number) => plan.nook.x + m * lx
  return {
    sofa: NOOK_SEATS.map((lx) => ({ at: [x(lx), wall + 0.38] as [number, number], heading: headingOf(0, 1), way: [plan.nookEntry, [x(lx), front] as [number, number]] })),
    coffee: { at: [x(-NOOK_W / 2 + NOOK_COUNTER / 2), front] as [number, number], heading: headingOf(0, -1), way: [plan.nookEntry] },
  }
}

/** Where to stand for a drink: at the nook's coffee machine, at the one on a coffee bar, or behind the water cooler. */
function coffeeSpots(plan: OfficePlan, k: Decor): Amenities['coffee'] {
  const out: Amenities['coffee'] = [nookPlaces(plan).coffee]
  if (plan.shelf && k.back === 'coffee') out.push({ at: [plan.shelf.x - plan.shelf.w / 2 + 0.3, plan.shelf.z + plan.shelf.d / 2 + 0.45], heading: headingOf(0, -1) })
  if (plan.cooler) out.push({ at: [plan.cooler[0], plan.cooler[1] - 0.6], heading: headingOf(0, 1) })
  return out
}

/** A rug, an L-shaped sofa along its back and left edges, and a coffee table. */
function Lounge({ a, k }: { a: Area; k: Decor }) {
  const y = FLOOR_TOP
  const x0 = a.x - a.w / 2
  const z0 = a.z - a.d / 2
  return (
    <>
      {/* seat along the back, then along the left */}
      <B p={[a.x + 0.2, y + 0.18, z0 + 0.35]} s={[a.w - 0.4, 0.36, 0.7]} c={k.sofa[0]} />
      <B p={[a.x + 0.2, y + 0.45, z0 + 0.1]} s={[a.w - 0.4, 0.5, 0.2]} c={k.sofa[1]} />
      <B p={[x0 + 0.35, y + 0.18, a.z + 0.35]} s={[0.7, 0.36, a.d - 0.7]} c={k.sofa[0]} />
      <B p={[x0 + 0.1, y + 0.45, a.z + 0.25]} s={[0.2, 0.5, a.d - 0.5]} c={k.sofa[1]} />
      {/* cushions */}
      <B p={[a.x + 0.9, y + 0.44, z0 + 0.3]} s={[0.4, 0.3, 0.12]} c={k.cushions[0]} />
      <B p={[x0 + 0.3, y + 0.44, a.z + 0.9]} s={[0.12, 0.3, 0.4]} c={k.cushions[1]} />
      {/* coffee table with a mug */}
      <B p={[a.x + 0.4, y + 0.14, a.z + 0.4]} s={[1.2, 0.28, 0.8]} c={k.desk[1]} />
      <B p={[a.x + 0.4, y + 0.3, a.z + 0.4]} s={[1.3, 0.05, 0.9]} c={k.desk[0]} />
      <B p={[a.x + 0.2, y + 0.38, a.z + 0.3]} s={[0.12, 0.12, 0.12]} c="#f5f5f0" />
    </>
  )
}

/** What stands against the back wall, by the room's `back`; a clock hangs above it either way. */
function BackWall({ a, k }: { a: Area; k: Decor }) {
  const y = FLOOR_TOP
  const wallZ = a.z - a.d / 2
  let body: ReactNode
  if (k.back === 'coffee') {
    // a counter with a coffee machine and cups, and a fridge at one end
    const cw = a.w - 0.7
    const cx = a.x - a.w / 2 + cw / 2
    body = (
      <>
        <B p={[cx, y + 0.3, a.z]} s={[cw, 0.6, a.d]} c={k.desk[1]} />
        <B p={[cx, y + 0.62, a.z]} s={[cw + 0.04, 0.05, a.d + 0.04]} c={k.desk[0]} />
        <B p={[cx - cw / 2 + 0.3, y + 0.85, a.z - 0.02]} s={[0.34, 0.42, 0.3]} c="#2f2f38" />
        <mesh position={[cx - cw / 2 + 0.3, y + 0.95, a.z + 0.135]} scale={[0.06, 0.06, 0.02]} material={screen('#ff5a4a')}><boxGeometry /></mesh>
        {[0.1, 0.3, 0.5].map((dx, i) => <B key={i} p={[cx + dx, y + 0.7, a.z]} s={[0.1, 0.1, 0.1]} c={i === 1 ? k.cushions[0] : '#f5f5f0'} />)}
        <B p={[a.x + a.w / 2 - 0.32, y + 0.62, a.z]} s={[0.6, 1.24, a.d + 0.04]} c="#e8ecf0" />
        <B p={[a.x + a.w / 2 - 0.32, y + 0.8, a.z + a.d / 2 + 0.03]} s={[0.56, 0.01, 0.01]} c="#b8bec8" />
        <B p={[a.x + a.w / 2 - 0.55, y + 0.95, a.z + a.d / 2 + 0.04]} s={[0.03, 0.2, 0.03]} c="#9aa4b0" />
      </>
    )
  } else if (k.back === 'whiteboard') {
    // a board on the wall with notes and scribbles, a tray of pens under it
    body = (
      <>
        <B p={[a.x, y + 1.0, wallZ + 0.04]} s={[a.w, 1.0, 0.06]} c="#9aa4b0" />
        <B p={[a.x, y + 1.0, wallZ + 0.075]} s={[a.w - 0.1, 0.9, 0.01]} c="#f7f7f4" shadow={false} />
        {[[-0.9, 1.25, 0.8, '#3b6fb0'], [-0.7, 1.1, 0.5, '#3b6fb0'], [-0.8, 0.95, 0.9, '#c23b3b'], [0.2, 0.75, 0.6, '#2f8f5b']].map(([dx, dy, w, c], i) => (
          <B key={i} p={[a.x + (dx as number), y + (dy as number), wallZ + 0.085]} s={[w as number, 0.03, 0.005]} c={c as string} shadow={false} />
        ))}
        {[[0.4, 1.25, '#ffe08a'], [0.75, 1.25, '#ff8ab0'], [1.1, 1.05, '#8fd0c8'], [0.6, 1.0, '#ffe08a']].map(([dx, dy, c], i) => (
          <B key={`n${i}`} p={[a.x + (dx as number), y + (dy as number), wallZ + 0.085]} s={[0.22, 0.22, 0.008]} c={c as string} shadow={false} />
        ))}
        <B p={[a.x, y + 0.5, wallZ + 0.1]} s={[a.w * 0.6, 0.04, 0.1]} c="#9aa4b0" />
        <B p={[a.x - 0.2, y + 0.53, wallZ + 0.1]} s={[0.2, 0.025, 0.025]} c="#c23b3b" />
        <B p={[a.x + 0.1, y + 0.53, wallZ + 0.1]} s={[0.2, 0.025, 0.025]} c="#3b6fb0" />
      </>
    )
  } else if (k.back === 'lockers') {
    const n = Math.floor(a.w / 0.4)
    const lw = a.w / n
    const tones = [k.chair, k.sofa[0], k.cushions[1]]
    body = (
      <>
        {Array.from({ length: n }, (_, i) => {
          const lx = a.x - a.w / 2 + lw * (i + 0.5)
          return (
            <group key={i}>
              <B p={[lx, y + 0.62, a.z]} s={[lw - 0.02, 1.24, a.d]} c={tones[i % tones.length]} />
              {[1.05, 1.0, 0.95].map((h, j) => <B key={j} p={[lx, y + h, a.z + a.d / 2 + 0.005]} s={[lw * 0.6, 0.015, 0.01]} c="#2f3438" shadow={false} />)}
              <B p={[lx + lw / 2 - 0.08, y + 0.65, a.z + a.d / 2 + 0.015]} s={[0.03, 0.12, 0.03]} c="#d8dce2" shadow={false} />
            </group>
          )
        })}
      </>
    )
  } else if (k.back === 'aquarium') {
    // a lit fish tank on a cabinet
    const tw = a.w * 0.75
    body = (
      <>
        <B p={[a.x, y + 0.28, a.z]} s={[tw, 0.56, a.d]} c={k.desk[1]} />
        <mesh position={[a.x, y + 0.88, a.z]} scale={[tw - 0.08, 0.6, a.d - 0.06]} material={screen('#7fc8e0')}><boxGeometry /></mesh>
        <B p={[a.x, y + 1.2, a.z]} s={[tw, 0.05, a.d]} c="#2f3438" />
        <B p={[a.x, y + 0.6, a.z]} s={[tw - 0.1, 0.05, a.d - 0.08]} c="#e8d8a8" shadow={false} />
        {[[-0.6, 0.85, '#ff8a3c'], [0.2, 1.0, '#ffcf5a'], [0.7, 0.78, '#ff8a3c'], [-0.15, 0.72, '#e85d4a']].map(([dx, dy, c], i) => (
          <mesh key={i} position={[a.x + (dx as number), y + (dy as number), a.z + a.d / 2 - 0.025]} scale={[0.12, 0.07, 0.02]} material={screen(c as string)}><boxGeometry /></mesh>
        ))}
        {[-0.95, 0.95].map((dx, i) => <B key={`w${i}`} p={[a.x + dx * (tw / 2.3), y + 0.78, a.z]} s={[0.06, 0.3, 0.06]} c="#3e8f55" shadow={false} />)}
      </>
    )
  } else if (k.back === 'server') {
    // two racks with rows of blinking lights
    body = (
      <>
        {[-0.5, 0.5].map((dx, i) => (
          <group key={i} position={[a.x + dx * (a.w / 2), y, a.z]}>
            <B p={[0, 0.7, 0]} s={[0.8, 1.4, a.d]} c="#2a2f38" />
            {Array.from({ length: 6 }, (_, r) => (
              <group key={r}>
                <B p={[0, 0.25 + r * 0.2, a.d / 2 + 0.005]} s={[0.7, 0.12, 0.01]} c="#3a414c" shadow={false} />
                {[-0.25, -0.18, -0.11].map((lx, j) => (
                  <mesh key={j} position={[lx, 0.25 + r * 0.2, a.d / 2 + 0.012]} scale={0.03} material={screen((r + j + i) % 4 ? '#7affb0' : '#ff5a4a')}><boxGeometry /></mesh>
                ))}
              </group>
            ))}
          </group>
        ))}
      </>
    )
  } else {
    body = <Shelf a={a} k={k} />
  }
  return (
    <>
      {body}
      {/* a wall clock above */}
      <group position={[a.x + a.w / 2 - 0.35, y + 1.95, wallZ + 0.03]} rotation={[Math.PI / 2, 0, 0]}>
        <Part p={[0, 0, 0]} c="#2f3438"><cylinderGeometry args={[0.2, 0.2, 0.04, 16]} /></Part>
        <Part p={[0, 0.025, 0]} c="#f7f7f4"><cylinderGeometry args={[0.17, 0.17, 0.02, 16]} /></Part>
        <B p={[0, 0.04, -0.05]} s={[0.02, 0.01, 0.1]} c="#2f3438" shadow={false} />
        <B p={[0.04, 0.04, 0]} s={[0.08, 0.01, 0.02]} c="#2f3438" shadow={false} />
      </group>
    </>
  )
}

/**
 * Every office's break nook against the back wall, drawn about x = 0: a counter with an espresso machine and
 * cups, then a two-seat sofa facing into the room.
 */
function Nook({ z, k }: { z: number; k: Decor }) {
  const y = FLOOR_TOP
  const wall = z - NOOK_D / 2
  const cx = -NOOK_W / 2 + NOOK_COUNTER / 2
  const sx = NOOK_SOFA_X + NOOK_SOFA_W / 2
  return (
    <>
      {/* counter, its top, and the machine on it */}
      <B p={[cx, y + 0.36, wall + 0.28]} s={[NOOK_COUNTER, 0.72, 0.52]} c={k.desk[1]} />
      <B p={[cx, y + 0.74, wall + 0.28]} s={[NOOK_COUNTER + 0.04, 0.04, 0.56]} c={k.desk[0]} />
      <B p={[cx - 0.12, y + 0.96, wall + 0.22]} s={[0.34, 0.4, 0.3]} c="#2f3438" />
      <B p={[cx - 0.12, y + 0.98, wall + 0.38]} s={[0.22, 0.06, 0.06]} c="#9aa0aa" shadow={false} />
      <B p={[cx - 0.12, y + 0.78, wall + 0.34]} s={[0.24, 0.03, 0.14]} c="#4a4f5c" shadow={false} />
      <B p={[cx - 0.22, y + 1.08, wall + 0.375]} s={[0.04, 0.04, 0.01]} c="#62e07a" shadow={false} />
      {[0.14, 0.27].map((dx) => <B key={dx} p={[cx + dx, y + 0.81, wall + 0.34]} s={[0.09, 0.1, 0.09]} c="#f5f5f0" />)}
      {/* sofa: seat, back against the wall, arms, two cushions */}
      <B p={[sx, y + 0.18, wall + 0.36]} s={[NOOK_SOFA_W, 0.36, 0.62]} c={k.sofa[0]} />
      <B p={[sx, y + 0.45, wall + 0.11]} s={[NOOK_SOFA_W, 0.5, 0.2]} c={k.sofa[1]} />
      {[-1, 1].map((e) => <B key={e} p={[sx + e * (NOOK_SOFA_W / 2 - 0.07), y + 0.3, wall + 0.36]} s={[0.14, 0.5, 0.62]} c={k.sofa[1]} />)}
      {NOOK_SEATS.map((lx, i) => <B key={lx} p={[lx + (i ? 0.12 : -0.12), y + 0.48, wall + 0.27]} s={[0.36, 0.28, 0.12]} c={k.cushions[i]} />)}
    </>
  )
}

/** A water cooler: a cabinet with a blue bottle upside down on top. */
function Cooler({ x, z }: { x: number; z: number }) {
  const y = FLOOR_TOP
  return (
    <>
      <B p={[x, y + 0.35, z]} s={[0.34, 0.7, 0.34]} c="#e8ecf0" />
      <B p={[x, y + 0.48, z + 0.18]} s={[0.05, 0.05, 0.04]} c="#3b6fb0" shadow={false} />
      <Part p={[x, y + 0.92, z]} c="#8fc8ea"><cylinderGeometry args={[0.14, 0.14, 0.42, 10]} /></Part>
      <Part p={[x, y + 1.15, z]} c="#7fb8da"><cylinderGeometry args={[0.06, 0.12, 0.08, 10]} /></Part>
    </>
  )
}

function Shelf({ a, k }: { a: Area; k: Decor }) {
  const y = FLOOR_TOP
  const books = k.books
  // less detail: an empty case
  const detail = usePrefs((s) => s.detail)
  return (
    <>
      <B p={[a.x, y + 0.55, a.z]} s={[a.w, 1.1, a.d]} c={k.desk[1]} />
      {detail && [0.35, 0.8].flatMap((h, row) => Array.from({ length: Math.floor((a.w - 0.5) / 0.5) }, (_, i) => (
        <B key={`${row}-${i}`} p={[a.x - a.w / 2 + 0.35 + i * 0.5 + row * 0.1, y + h, a.z + a.d / 2 - 0.02]} s={[0.36, 0.26, 0.04]} c={books[(i + row * 2) % books.length]} shadow={false} />
      )))}
    </>
  )
}

/** Heights of floor coverings over the tiles, in office units: wood and carpet, then the rug on top. */
const COVER_Y = FLOOR_TOP + 0.008
const RUG_Y = FLOOR_TOP + 0.016

function Office({ teamId, plan, decor, trim, seed }: { teamId: string; plan: OfficePlan; decor: Decor; trim: string; seed: number }) {
  const w = useStore((s) => s.world)
  // less detail: no desk items or pot plants
  const detail = usePrefs((s) => s.detail)
  const replicas = teamReplicas(w, teamId)
  const crew: CrewMember[] = replicas.map((r) => ({ id: r.id, look: r.look, busy: !!activity(w, r).sub }))
  // wood under the desks, out to a margin round them
  const desks = useMemo((): Area | null => {
    if (!plan.stations.length) return null
    const xs = plan.stations.flatMap((s) => [s.x - s.w / 2, s.x + s.w / 2])
    const zs = plan.stations.flatMap((s) => [s.z - s.d / 2, s.z + s.d / 2])
    const x0 = Math.min(...xs) - 0.5, x1 = Math.max(...xs) + 0.5
    const z0 = Math.min(...zs) - 0.5, z1 = Math.max(...zs) + 0.6
    return { x: (x0 + x1) / 2, z: (z0 + z1) / 2, w: x1 - x0, d: z1 - z0 }
  }, [plan])
  const grow = (a: Area, m: number): Area => ({ ...a, w: a.w + m * 2, d: a.d + m * 2 })
  const k = decor
  const amenities = useMemo((): Amenities => ({
    sofa: [...nookPlaces(plan).sofa, ...(plan.lounge && decor.corner === 'sofa' ? loungeSeats(plan.lounge, plan.mirror) : [])],
    coffee: coffeeSpots(plan, decor),
  }), [plan, decor])
  // drawn in office units; scaled about the floor plate's top so things still stand on it
  return (
    <group position={[0, FLOOR_TOP * (1 - OFFICE_SCALE), 0]} scale={OFFICE_SCALE}>
      {desks && <Floor kind="wood" variant={k.wood} a={desks} y={COVER_Y} perUnit={OFFICE_SCALE} />}
      {plan.meeting && <Floor kind="carpet" variant={k.carpet} a={grow(plan.meeting, 0.3)} y={COVER_Y} perUnit={OFFICE_SCALE} />}
      {plan.lounge && <Floor kind="wood" variant={k.wood} a={grow(plan.lounge, 0.3)} y={COVER_Y} perUnit={OFFICE_SCALE} />}
      {plan.lounge && <Rug a={plan.lounge} y={RUG_Y} colors={k.rug} />}
      {/* a doormat inside the entrance */}
      <B p={[0, FLOOR_TOP + 0.015, plan.half - 0.45]} s={[1.6, 0.03, 0.7]} c="#4a4f5c" shadow={false} />
      {crew.slice(0, plan.seats.length).map((r, i) => (
        <Station key={r.id} x={plan.seats[i][0]} z={plan.seats[i][1]} busy={r.busy} k={k} setup={Math.floor(hash(seed, i, 41) * 12)} detail={detail} />
      ))}
      <OfficeCrew teamId={teamId} seed={seed} plan={plan} crew={crew} floor={FLOOR_TOP} amenities={amenities} />
      {plan.reception && <Mirrored on={plan.mirror} x={plan.reception.x}><Reception a={{ ...plan.reception, x: 0 }} trim={trim} k={k} /></Mirrored>}
      {plan.meeting && <Meeting a={plan.meeting} k={k} />}
      {/* the sofa backs onto the room's side wall, whichever side that is */}
      {plan.lounge && <Mirrored on={plan.mirror} x={plan.lounge.x}><Corner a={{ ...plan.lounge, x: 0 }} k={k} /></Mirrored>}
      {plan.shelf && <BackWall a={plan.shelf} k={k} />}
      <Mirrored on={plan.mirror} x={plan.nook.x}><Nook z={plan.nook.z} k={k} /></Mirrored>
      {detail && plan.plants.map(([x, z], i) => <Plant key={i} x={x} z={z} pot={k.pot} kind={Math.floor(hash(seed, i, 31) * 5)} />)}
      {plan.cooler && <Cooler x={plan.cooler[0]} z={plan.cooler[1]} />}
    </group>
  )
}

/** Its children, drawn about x = 0, put at `x`, turned left to right when `on`. */
function Mirrored({ on, x, children }: { on: boolean; x: number; children: ReactNode }) {
  return <group position={[x, 0, 0]} scale={[on ? -1 : 1, 1, 1]}>{children}</group>
}

const calm = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
const SHOUT = '#ffc93a'
/** Thickness of a shout stroke, how far its inner end stays off the building's outline, how far up the second pose sits, and its length against the first. */
const STROKE = 0.85
const SHOUT_GAP = 1.1
const SHOUT_LIFT = 0.6
const SHOUT_SHRINK = 0.65
/** Turns a group so its x and y run along the screen, facing the camera (which never rotates). */
const ON_SCREEN = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(SCREEN_RIGHT, SCREEN_UP, ISO_DIR))

/** One shout stroke: degrees up from pointing straight out, and length in world units. */
export interface Ray { angle: number; len: number }
/** A fan of strokes off one side of the building as seen on screen. */
export interface Burst {
  /** 1 on the right of the screen, -1 on the left. */
  side: 1 | -1
  /** The building's outline corner on that side, at the fan's height. */
  at: [number, number, number]
  rays: Ray[]
  /** Seconds between the strokes' two poses. */
  beat: number
}

const FANS: Ray[][] = [
  [{ angle: 30, len: 2.3 }, { angle: 3, len: 2.7 }, { angle: -25, len: 2.1 }],
  [{ angle: 46, len: 1.7 }, { angle: 20, len: 2.4 }, { angle: -4, len: 2.1 }, { angle: -30, len: 1.8 }],
]

/**
 * The two fans of cartoon shout strokes for a building `w` × `d` and `h` tall. The seed picks which side
 * gets four strokes and sits low, and which gets three and sits high, so the two never mirror each other.
 */
export function shoutBursts(w: number, d: number, h: number, seed: number): Burst[] {
  const four = hash(seed, 71) < 0.5 ? 1 : -1
  return ([1, -1] as const).map((side) => {
    const low = side === four
    const y = h * (low ? 0.38 + 0.12 * hash(seed, 72) : 0.66 + 0.12 * hash(seed, 73))
    // the outermost corner on that side of the screen: (+w/2, -d/2) on the right, (-w/2, +d/2) on the left
    return { side, at: [(side * w) / 2, y, (-side * d) / 2], rays: FANS[low ? 1 : 0], beat: low ? 0.26 : 0.2 }
  })
}

/** Cartoon shout strokes off both sides of a building while the company is at work; they jump between two poses, still with reduced motion. */
function Shout({ w, d, h, seed }: { w: number; d: number; h: number; seed: number }) {
  const bursts = useMemo(() => shoutBursts(w, d, h, seed), [w, d, h, seed])
  const mat = useMemo(() => new THREE.MeshBasicMaterial({ color: SHOUT, toneMapped: false }), [])
  useEffect(() => () => mat.dispose(), [mat])
  const poses = useRef<(THREE.Group | null)[]>([])
  useFrame(({ clock }) => {
    if (calm) return
    bursts.forEach((b, i) => {
      const far = Math.floor(clock.elapsedTime / b.beat) % 2 === 1
      const [near, out] = [poses.current[2 * i], poses.current[2 * i + 1]]
      if (near) near.visible = !far
      if (out) out.visible = far
    })
  })
  return bursts.map((b, i) => (
    <group key={i} position={b.at} quaternion={ON_SCREEN}>
      <group scale={[b.side, 1, 1]}>
        {/* pose 0 full length, pose 1 raised and shorter */}
        {[0, 1].map((p) => (
          <group key={p} ref={(g) => { poses.current[2 * i + p] = g }} position={[0, p * SHOUT_LIFT, 0]} visible={p === 0}>
            {b.rays.map((r, k) => {
              const len = r.len * (p ? SHOUT_SHRINK : 1)
              return (
                <group key={k} rotation={[0, 0, THREE.MathUtils.degToRad(r.angle)]}>
                  <mesh position={[SHOUT_GAP + len / 2, 0, 0]} scale={[len, STROKE, 0.05]} material={mat} layers={NO_OUTLINE_LAYER} raycast={() => null}>
                    <boxGeometry />
                  </mesh>
                </group>
              )
            })}
          </group>
        ))}
      </group>
    </group>
  ))
}

/** Height of the tallest roof item, so labels can sit above it. */
export const ROOF_TOP = 1.7 * KIT

function Roof({ style, w, d, pal }: { style: BuildingStyle; w: number; d: number; pal: Palette }) {
  if (style === 'pagoda') {
    // two tiers of hipped roof, the lower one flaring past the walls, and a golden finial
    const hip = (y: number, sx: number, sz: number, h: number, c: string) => (
      <mesh position={[0, y, 0]} rotation={[0, Math.PI / 4, 0]} scale={[sx * Math.SQRT1_2, 1, sz * Math.SQRT1_2]} material={toon(c)} castShadow receiveShadow>
        <coneGeometry args={[1, h, 4]} />
      </mesh>
    )
    return (
      <>
        {hip(0.5, w + 0.8, d + 0.8, 1.0, pal.roof)}
        <B p={[0, 0.85, 0]} s={[w * 0.4, 0.5, d * 0.4]} c={pal.trim} />
        {hip(1.3, w * 0.55, d * 0.55, 0.5, pal.roof)}
        <B p={[0, 1.6, 0]} s={[0.1, 0.18, 0.1]} c={pal.sign} />
      </>
    )
  }
  if (style === 'deco') {
    // a stepped crown, gold lines at each step, and a spire
    return (
      <>
        <B p={[0, 0.25, 0]} s={[w * 0.7, 0.5, d * 0.7]} c={pal.wall} />
        <B p={[0, 0.52, 0]} s={[w * 0.7 + 0.04, 0.06, d * 0.7 + 0.04]} c={pal.sign} />
        <B p={[0, 0.75, 0]} s={[w * 0.45, 0.5, d * 0.45]} c={pal.wall} />
        <B p={[0, 1.02, 0]} s={[w * 0.45 + 0.04, 0.06, d * 0.45 + 0.04]} c={pal.sign} />
        <B p={[0, 1.15, 0]} s={[w * 0.22, 0.25, d * 0.22]} c={pal.trim} />
        <Part p={[0, 1.45, 0]} c={pal.sign}><coneGeometry args={[0.12, 0.5, 4]} /></Part>
      </>
    )
  }
  if (style === 'eco') {
    // a lawn over the whole deck, a few small trees and a wind turbine
    return (
      <>
        <B p={[0, 0.06, 0]} s={[w - 0.4, 0.12, d - 0.4]} c="#7cc25a" />
        {[[-w / 4, d / 4], [w / 4, -d / 6], [-w / 6, -d / 4]].map(([tx, tz], i) => (
          <group key={i} position={[tx, 0.12, tz]}>
            <B p={[0, 0.2, 0]} s={[0.12, 0.4, 0.12]} c="#8a5a36" />
            <B p={[0, 0.55, 0]} s={[0.55, 0.45, 0.55]} c={i % 2 ? '#3e8f55' : '#4fa848'} />
          </group>
        ))}
        <group position={[w / 2 - 0.7, 0, d / 2 - 0.7]}>
          <B p={[0, 0.65, 0]} s={[0.07, 1.3, 0.07]} c="#e8ecf0" />
          <B p={[0, 1.3, 0.06]} s={[0.12, 0.12, 0.16]} c="#e8ecf0" />
          {[0, 1, 2].map((i) => (
            <B key={i} p={[Math.sin((i * 2 * Math.PI) / 3) * 0.25, 1.3 + Math.cos((i * 2 * Math.PI) / 3) * 0.25, 0.15]} s={[0.06, 0.5, 0.02]}
              r={[0, 0, -(i * 2 * Math.PI) / 3]} c="#f5f5f0" />
          ))}
        </group>
      </>
    )
  }
  if (style === 'villa') {
    // a low terracotta roof past the walls, and a white chimney
    return (
      <>
        <mesh position={[0, 0.75, 0]} rotation={[0, Math.PI / 4, 0]} scale={[((w + 0.5) / 2) * Math.SQRT2, 1, ((d + 0.5) / 2) * Math.SQRT2]}
          material={toon(pal.roof)} castShadow receiveShadow>
          <coneGeometry args={[1, 1.5, 4]} />
        </mesh>
        <B p={[-w / 4, 0.9, d / 6]} s={[0.4, 1.0, 0.4]} c={pal.wall} />
        <B p={[-w / 4, 1.42, d / 6]} s={[0.48, 0.06, 0.48]} c={pal.roof} />
      </>
    )
  }
  if (style === 'loft') {
    // a sawtooth roof: north lights in rows, and a vent stack
    const teeth = Math.max(2, Math.floor((d - 1) / 1.6))
    return (
      <>
        {Array.from({ length: teeth }, (_, i) => {
          const z = -d / 2 + 0.9 + i * ((d - 1.8) / Math.max(1, teeth - 1))
          return (
            <group key={i} position={[0, 0, z]}>
              <B p={[0, 0.42, 0.22]} s={[w - 0.8, 0.08, 1.15]} r={[0.72, 0, 0]} c={pal.wall} />
              <B p={[0, 0.42, -0.2]} s={[w - 0.8, 0.84, 0.06]} c={pal.glass} />
            </group>
          )
        })}
        <Part p={[w / 2 - 0.8, 0.6, d / 2 - 0.8]} c={pal.trim}><cylinderGeometry args={[0.18, 0.18, 1.2, 8]} /></Part>
      </>
    )
  }
  if (style === 'timber') {
    // a hipped roof over the whole deck, and a chimney through it
    return (
      <>
        <mesh position={[0, 0.6, 0]} rotation={[0, Math.PI / 4, 0]} scale={[(w / 2) * Math.SQRT2, 1, (d / 2) * Math.SQRT2]}
          material={toon(pal.roof)} castShadow receiveShadow>
          <coneGeometry args={[1, 1.2, 4]} />
        </mesh>
        <B p={[w / 4, 0.75, -d / 6]} s={[0.4, 1.3, 0.4]} c={pal.trim} />
      </>
    )
  }
  if (style === 'classic') {
    // a drum and a dome, with a finial
    return (
      <>
        <Part p={[0, 0.2, 0]} c={pal.trim}><cylinderGeometry args={[1.25, 1.25, 0.4, 16]} /></Part>
        <Part p={[0, 0.4, 0]} c={pal.roof}><sphereGeometry args={[1.1, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2]} /></Part>
        <B p={[0, 1.6, 0]} s={[0.1, 0.25, 0.1]} c={pal.sign} />
      </>
    )
  }
  if (style === 'tech') {
    // a helipad and a mast with a light on top
    return (
      <>
        <Part p={[0.3, 0.04, 0.3]} c="#3a3f4a"><cylinderGeometry args={[1.35, 1.35, 0.08, 16]} /></Part>
        {/* the H */}
        <B p={[0.3 - 0.28, 0.09, 0.3]} s={[0.12, 0.02, 0.9]} c="#f5f5f0" shadow={false} />
        <B p={[0.3 + 0.28, 0.09, 0.3]} s={[0.12, 0.02, 0.9]} c="#f5f5f0" shadow={false} />
        <B p={[0.3, 0.09, 0.3]} s={[0.5, 0.02, 0.12]} c="#f5f5f0" shadow={false} />
        <B p={[-w / 2 + 0.6, 0.6, -d / 2 + 0.6]} s={[0.08, 1.2, 0.08]} c={pal.trim} />
        <mesh position={[-w / 2 + 0.6, 1.25, -d / 2 + 0.6]} scale={0.16} material={screen(pal.sign)}><boxGeometry /></mesh>
      </>
    )
  }
  if (style === 'tower') {
    return (
      <>
        {/* plant room, two AC units and an antenna */}
        <B p={[-w / 2 + 0.9, 0.35, -d / 2 + 0.9]} s={[1.2, 0.7, 1.2]} c="#a3abbd" />
        <B p={[-w / 2 + 0.9, 0.72, -d / 2 + 0.9]} s={[1.3, 0.06, 1.3]} c="#56637e" />
        {[[0.7, -0.6], [0.7, 0.5]].map(([ax, az], i) => (
          <group key={i} position={[ax, 0, az]}>
            <B p={[0, 0.2, 0]} s={[0.7, 0.4, 0.55]} c="#d5dbe5" />
            <B p={[0, 0.41, 0]} s={[0.4, 0.02, 0.4]} c="#4a5468" />
          </group>
        ))}
        <B p={[-w / 2 + 0.9, 1.2, -d / 2 + 0.9]} s={[0.07, 1.0, 0.07]} c="#56637e" />
        <B p={[-w / 2 + 0.9, 1.72, -d / 2 + 0.9]} s={[0.14, 0.14, 0.14]} c="#ff5a4a" />
      </>
    )
  }
  if (style === 'brick') {
    return (
      <>
        {/* timber water tank on legs, and two planters */}
        <group position={[-w / 2 + 1, 0, -d / 2 + 1]}>
          {[[-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3], [0.3, 0.3]].map(([lx, lz], i) => (
            <B key={i} p={[lx, 0.25, lz]} s={[0.08, 0.5, 0.08]} c="#5b3a26" />
          ))}
          <Part p={[0, 0.85, 0]} c="#9a6a44"><cylinderGeometry args={[0.48, 0.48, 0.7, 8]} /></Part>
          <Part p={[0, 1.38, 0]} c="#6b4a33"><coneGeometry args={[0.55, 0.36, 8]} /></Part>
        </group>
        {[[0.8, 0.8], [0.8, -0.2]].map(([ax, az], i) => (
          <group key={i} position={[ax, 0, az]}>
            <B p={[0, 0.12, 0]} s={[0.8, 0.24, 0.5]} c="#8a5a3a" />
            <B p={[0, 0.34, 0]} s={[0.7, 0.24, 0.42]} c={i ? '#4fa848' : '#62b955'} />
          </group>
        ))}
      </>
    )
  }
  return (
    <>
      {/* roof garden with two small trees, and a row of solar panels */}
      <B p={[0.55, 0.06, 0.2]} s={[2.2, 0.12, 2.6]} c="#7cc25a" />
      {[[0.1, 1.0], [1.1, -0.4]].map(([tx, tz], i) => (
        <group key={i} position={[tx, 0.12, tz]}>
          <B p={[0, 0.2, 0]} s={[0.12, 0.4, 0.12]} c="#8a5a36" />
          <B p={[0, 0.55, 0]} s={[0.55, 0.45, 0.55]} c={i ? '#3e8f55' : '#4fa848'} />
        </group>
      ))}
      {[-1.1, -0.45, 0.2].map((sz, i) => (
        <B key={i} p={[-w / 2 + 0.75, 0.3, sz + 0.3]} s={[0.9, 0.06, 0.55]} r={[0.5, 0, 0]} c="#33507a" />
      ))}
    </>
  )
}
