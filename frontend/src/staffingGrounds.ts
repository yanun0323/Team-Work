// Where things stand on the staffing agency's paving (layout.ts `STAFFING_LOT`): the rotunda with its flower bed, and
// what is round it. Pure data, no three.js: `StaffingAgency.tsx` draws from it, and `walk.ts` keeps people off it.

import { CELL, STAFFING_LOT, type Rect, type Town } from './layout'

/** Something on the paving round the rotunda, in world units about its middle: its centre and full size. */
export interface Footprint { x: number; z: number; w: number; d: number }

/** Half the paving's side, in world units. */
export const HALF_LOT = (STAFFING_LOT.w * CELL) / 2
/** The round stone plinth the rotunda stands on. */
export const PLINTH = { r: 4.7, h: 0.6 }
/** The flower bed round the plinth, out to `r1`, left open `gap` radians either side of the steps. */
export const BED = { r0: PLINTH.r, r1: 5.65, gap: 0.42 }
/** The steps' half width, which the bed's opening lets through. */
export const STEPS_HALF = 1.6
/** How far out from the middle, towards the town (+z), the foot of the steps is: where people go in and come out. */
export const DOORSTEP = PLINTH.r + 0.8

/** Where everything round the rotunda stands; the door and the steps face +z, the town, and the airport is to -x. */
export const GROUNDS = {
  /** From the steps out to the paving's edge, its kerbs included; people walk on it. */
  path: { x: 0, z: 7.8, w: 3.9, d: 4.4 },
  badge: { x: 3.4, z: 5.8, w: 2.2, d: 0.9 },
  lamps: [{ x: -2.6, z: 8.8, w: 0.5, d: 0.5 }, { x: 2.6, z: 8.8, w: 0.5, d: 0.5 }],
  shelter: { x: -7.8, z: 6.6, w: 3.8, d: 1.7 },
  sign: { x: -9.3, z: 9.0, w: 0.5, d: 0.5 },
  luggage: { x: -4.9, z: 8.4, w: 1.8, d: 0.9 },
  flags: [-4.5, -1.5, 1.5, 4.5].map((z) => ({ x: 7, z, w: 0.5, d: 0.5 })),
  planters: [{ x: 7.2, z: 8.6, w: 4, d: 1.2 }, { x: -7.6, z: -7.6, w: 2.4, d: 2.4 }, { x: 7.6, z: -7.6, w: 2.4, d: 2.4 }],
} satisfies Record<string, Footprint | Footprint[]>

/** Everything people walk round: all of `GROUNDS` but the path. */
export function obstacles(): Footprint[] {
  const { path: _path, lamps, flags, planters, ...single } = GROUNDS
  return [...Object.values(single), ...lamps, ...flags, ...planters]
}

/** How much room, in world units, a figure keeps from the rotunda and what stands round it. */
const BODY = 0.3

/**
 * The town cells people can't stand on: those a figure would clip the rotunda, its flower bed or anything round it
 * from. `lot` is the paving in `town`'s cells (`town.staffing`).
 */
export function blockedCells(town: Pick<Town, 'cols' | 'rows'>, lot: Rect): Array<[number, number]> {
  const things = obstacles()
  const out: Array<[number, number]> = []
  for (let z = lot.z; z < lot.z + lot.d; z++) for (let x = lot.x; x < lot.x + lot.w; x++) {
    // the cell about the paving's middle, as a square
    const cx = (x - lot.x - lot.w / 2 + 0.5) * CELL
    const cz = (z - lot.z - lot.d / 2 + 0.5) * CELL
    const h = CELL / 2
    const near = Math.hypot(Math.max(0, Math.abs(cx) - h), Math.max(0, Math.abs(cz) - h))
    const onRotunda = near < BED.r1 + BODY
    const onThing = things.some((f) => Math.abs(f.x - cx) < f.w / 2 + h + BODY && Math.abs(f.z - cz) < f.d / 2 + h + BODY)
    if ((onRotunda || onThing) && x >= 0 && z >= 0 && x < town.cols && z < town.rows) out.push([x, z])
  }
  return out
}
