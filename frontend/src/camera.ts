// The fixed isometric camera and the maths for focusing on one building. No React.

import * as THREE from 'three'

/**
 * Fixed isometric view, same angle as agent-factory: orthographic, looking from the +x/+z corner
 * (45° around) about 48° down from straight above. Players pan and zoom; they never rotate.
 */
export const ISO_DIR = new THREE.Vector3(48, 62, 48).normalize()
export const CAMERA_DISTANCE = 200
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
 * outer corners run past the free area.
 */
export function focusView(box: FocusBox, view: View, scale = 1): { target: THREE.Vector3; zoom: number } {
  // projected size of the box, in world units on screen
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  const p = new THREE.Vector3()
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (const y of [0, box.height]) {
    p.set(box.x + (sx * box.w) / 2, y, box.z + (sz * box.d) / 2)
    const u = p.dot(SCREEN_RIGHT)
    const v = p.dot(SCREEN_UP)
    minX = Math.min(minX, u); maxX = Math.max(maxX, u)
    minY = Math.min(minY, v); maxY = Math.max(maxY, v)
  }
  const free = Math.max(1, view.width - view.coverRight)
  const zoom = THREE.MathUtils.clamp(scale * Math.min((free * FILL_W) / (maxX - minX), (view.height * FILL_H) / (maxY - minY)), MIN_ZOOM, MAX_ZOOM)
  // the box's screen centre goes to the middle of the free part, which is coverRight / 2 left of the screen centre
  const u = (minX + maxX) / 2 + view.coverRight / 2 / zoom
  const v = (minY + maxY) / 2
  const target = SCREEN_RIGHT.clone().multiplyScalar(u).addScaledVector(SCREEN_UP, v)
  // slide along the view direction down to the ground; that doesn't move anything on screen
  target.addScaledVector(ISO_DIR, -target.y / ISO_DIR.y)
  return { target, zoom }
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
