// The fixed isometric camera and the maths for focusing on one building. No React.

import * as THREE from 'three'
import { CELL, FLOOR_CELLS, POWER_TOWER, TREE_CELLS, type Town } from './layout'

/**
 * Fixed isometric view, same angle as agent-factory: orthographic, looking from the +x/+z corner
 * (45° around) about 48° down from straight above. Players pan and zoom; they never rotate.
 */
export const ISO_DIR = new THREE.Vector3(48, 62, 48).normalize()
export const CAMERA_DISTANCE = 200
/** The sea is a square of this size, centred on the origin. */
export const SEA_SIZE = 500
/** Orthographic zoom = screen pixels per world unit. */
export const MIN_ZOOM = 6
export const MAX_ZOOM = 80

/** The camera's screen axes in world space (they never change, since the camera never rotates). */
export const SCREEN_RIGHT = new THREE.Vector3(ISO_DIR.z, 0, -ISO_DIR.x).normalize()
export const SCREEN_UP = new THREE.Vector3().crossVectors(ISO_DIR, SCREEN_RIGHT).normalize()

/** A building as a world-space box resting on the ground. */
export interface FocusBox {
  x: number
  z: number
  w: number
  d: number
  /** Top of the tallest part, roof equipment included. */
  height: number
}

export interface View {
  width: number
  height: number
  /** Screen pixels covered by a panel on the right. */
  coverRight: number
}

/** Share of the free screen the building may fill. */
const FILL_W = 0.98
const FILL_H = 0.95

/**
 * Where the camera should look, on the ground, and how far to zoom so the box sits centred in the part
 * of the screen the right-hand panel leaves free. `scale` above 1 zooms in further, letting the box's
 * outer corners run past the free area. `tight` drops the margin, so the box touches the free area's edges.
 */
export function focusView(box: FocusBox, view: View, scale = 1, tight = false): { target: THREE.Vector3; zoom: number } {
  const { minX, maxX, minY, maxY } = screenBounds(box)
  const free = Math.max(1, view.width - view.coverRight)
  const zoom = THREE.MathUtils.clamp(scale * Math.min((free * (tight ? 1 : FILL_W)) / (maxX - minX), (view.height * (tight ? 1 : FILL_H)) / (maxY - minY)), MIN_ZOOM, MAX_ZOOM)
  return { target: focusTarget(box, view, zoom), zoom }
}

/** Where to look so the box sits centred in the free part of the screen at the given zoom. */
export function focusTarget(box: FocusBox, view: View, zoom: number): THREE.Vector3 {
  const { minX, maxX, minY, maxY } = screenBounds(box)
  // the box's screen centre goes to the middle of the free part, which is coverRight / 2 left of the screen centre
  const u = (minX + maxX) / 2 + view.coverRight / 2 / zoom
  const v = (minY + maxY) / 2
  const target = SCREEN_RIGHT.clone().multiplyScalar(u).addScaledVector(SCREEN_UP, v)
  // slide along the view direction down to the ground; that doesn't move anything on screen
  return target.addScaledVector(ISO_DIR, -target.y / ISO_DIR.y)
}

/** The box's projected extent, in world units on screen. */
function screenBounds(box: FocusBox) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  const p = new THREE.Vector3()
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (const y of [0, box.height]) {
    p.set(box.x + (sx * box.w) / 2, y, box.z + (sz * box.d) / 2)
    const u = p.dot(SCREEN_RIGHT)
    const v = p.dot(SCREEN_UP)
    minX = Math.min(minX, u); maxX = Math.max(maxX, u)
    minY = Math.min(minY, v); maxY = Math.max(maxY, v)
  }
  return { minX, maxX, minY, maxY }
}

/** Whether any of the box shows on a screen of this size, for a camera looking at `center` (any point on its line of sight). */
export function boxOnScreen(box: FocusBox, center: THREE.Vector3, zoom: number, view: Pick<View, 'width' | 'height'>): boolean {
  const { minX, maxX, minY, maxY } = screenBounds(box)
  const u = center.dot(SCREEN_RIGHT), v = center.dot(SCREEN_UP)
  const halfW = view.width / 2 / zoom, halfH = view.height / 2 / zoom
  return maxX > u - halfW && minX < u + halfW && maxY > v - halfH && minY < v + halfH
}

/** Whether the box stands between the point and the camera: a line from the point towards the camera goes through it. */
export function hidesPoint(box: FocusBox, p: THREE.Vector3): boolean {
  const min = new THREE.Vector3(box.x - box.w / 2, 0, box.z - box.d / 2)
  const max = new THREE.Vector3(box.x + box.w / 2, box.height, box.z + box.d / 2)
  return new THREE.Ray(p, ISO_DIR).intersectsBox(new THREE.Box3(min, max))
}

/** Width of the right-hand drawer for a given canvas width: half, but never cramped. */
export const drawerWidth = (width: number) => Math.min(width, Math.max(width / 2, 380))

/** A camera view: where it looks on the ground, and its zoom. */
export interface Shot {
  target: THREE.Vector3
  zoom: number
}

/**
 * The view `u` of the way (0 to 1) from one shot to another, as a single zoom about the one point on the map
 * that stays put on screen. Everything on screen then slides in a straight line; moving the target and
 * the zoom each on their own makes the picture swing round a curve instead. The zoom changes by the same
 * ratio every step, so zooming in reads as steady.
 */
export function shotAt(from: Shot, to: Shot, u: number): Shot {
  const zoom = from.zoom * (to.zoom / from.zoom) ** u
  // almost no zoom change: the still point is far away or nowhere, so just slide across
  if (Math.abs(to.zoom - from.zoom) < from.zoom * 1e-3) return { target: from.target.clone().lerp(to.target, u), zoom }
  // a point P sits at (P - target) * zoom on screen; the still point F keeps (F - target) * zoom fixed
  const still = to.target.clone().multiplyScalar(to.zoom).addScaledVector(from.target, -from.zoom).divideScalar(to.zoom - from.zoom)
  const target = from.target.clone().sub(still).multiplyScalar(from.zoom / zoom).add(still)
  return { target, zoom }
}

/**
 * How far the ground a screen of this size shows at `zoom` reaches from what the camera looks at, along x or z:
 * a square this much each way round the target covers the whole screen.
 */
export function groundReach(view: Pick<View, 'width' | 'height'>, zoom: number): number {
  // the square's edges run at 45° on screen; the ground is foreshortened vertically by the tilt
  return (view.width / 2 + view.height / 2 / ISO_DIR.y) / Math.SQRT2 / zoom
}

/** The lowest zoom at which the sea, at its own size, still fills a screen of this size, looking at `target`. */
export function seaCoverZoom(target: THREE.Vector3, view: Pick<View, 'width' | 'height'>): number {
  return groundReach(view, 1) / (SEA_SIZE / 2 - Math.max(Math.abs(target.x), Math.abs(target.z)))
}

/** Fit projected land cells and static structures, not the origin-centred allocation rectangle. */
export function islandView(town: Town, view: Pick<View, 'width' | 'height'>): Shot {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  const point = new THREE.Vector3()
  const include = (x: number, y: number, z: number) => {
    point.set(x, y, z)
    const u = point.dot(SCREEN_RIGHT), v = point.dot(SCREEN_UP)
    minX = Math.min(minX, u); maxX = Math.max(maxX, u)
    minY = Math.min(minY, v); maxY = Math.max(maxY, v)
  }
  const box = (x: number, z: number, w: number, d: number, height: number, margin = 0) => {
    for (const px of [x * CELL - margin, (x + w) * CELL + margin]) {
      for (const pz of [z * CELL - margin, (z + d) * CELL + margin]) {
        include(px, 0, pz); include(px, height, pz)
      }
    }
  }
  town.ground.forEach((cell, k) => {
    // Includes the beach beyond the grass and the island's soil edge.
    if (cell) box(k % town.cols - town.cols / 2, Math.floor(k / town.cols) - town.rows / 2, 1, 1, -2, 1.5)
  })
  for (const lot of town.lots) box(lot.building.x - town.cols / 2, lot.building.z - town.rows / 2, lot.building.w, lot.building.d, lot.floors * FLOOR_CELLS * CELL + 4)
  for (const tree of town.trees) box(tree.x - town.cols / 2, tree.z - town.rows / 2, TREE_CELLS, TREE_CELLS, tree.height * CELL)
  const airport = { ...town.airport, x: town.airport.x - town.cols / 2, z: town.airport.z - town.rows / 2 }
  box(airport.x, airport.z, airport.w, airport.d, 5)
  // Control tower, in world units relative to the airport centre (Airport.tsx).
  const ax = (airport.x + airport.w / 2) * CELL - 14, az = (airport.z + airport.d / 2) * CELL - 15
  for (const x of [ax - 2, ax + 2]) for (const z of [az - 2, az + 2]) include(x, 17, z)
  // the power tower in the airfield's corner (PowerTower.tsx)
  const px = (airport.x + airport.w / 2) * CELL + POWER_TOWER.x, pz = (airport.z + airport.d / 2) * CELL + POWER_TOWER.z
  for (const x of [px - 2, px + 2]) for (const z of [pz - 2, pz + 2]) include(x, POWER_TOWER.h + 2, z)
  // Leave space for name tags and the toolbar; allow large islands below the normal manual zoom floor.
  const zoom = Math.min(MAX_ZOOM, Math.max(1, view.width - 80) / (maxX - minX), Math.max(1, view.height - 160) / (maxY - minY))
  const target = SCREEN_RIGHT.clone().multiplyScalar((minX + maxX) / 2).addScaledVector(SCREEN_UP, (minY + maxY) / 2)
  target.addScaledVector(ISO_DIR, -target.y / ISO_DIR.y)
  return { target, zoom }
}
