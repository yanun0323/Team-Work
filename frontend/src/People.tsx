// People who move: employees inside an opened office, who leave their desks when idle (to wander, chat,
// rest on the sofa, have a coffee or stare into space) and come back when work arrives, and people out on the island, who stroll about and sit on the benches.
//
// One figure for both, in office units (about 1.15 tall standing), seated or standing with a walk cycle.
// Movement is driven per frame from refs; React only renders the figures once.

import { useFrame } from '@react-three/fiber'
import { memo, useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import type { Look } from './core/domain/types'
import { anchors } from './core/voxel/labels'
import { isSwimwear, seedOf, styleOf, type Style } from './figureStyle'
import { hash, type Town } from './layout'
import { OFFICE_SCALE, type OfficePlan } from './office'
import { MAX_FRAME } from './PixelPass'
import { toon } from './toon'
import {
  advance, benchSeats, cellPos, crowdSize, freeCells, headingOf, inSteps, isFree, officeGrid, resettle, route, seatRoute, townGrid,
  type BenchSeat, type P, type Stroller as WalkStroller, type Walker,
} from './walk'

const calm = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/** Walking speed, in office units per second (one and a half world units). */
const SPEED = 1
/** Leg swing per office unit walked, in radians of the walk cycle. */
const STRIDE = 7
/** How fast someone turns to face where they walk, per second. */
const TURN = 10
/** Where a name tag sits over a person, in office units above the floor. */
const TAG_SEATED = 1.35
const TAG_STANDING = 1.55

type V3 = [number, number, number]

/** A box that casts a shadow and never takes the pointer, so people don't get in the way of clicks. */
/** `shadow` false: neither casts nor catches a shadow (the bubbles, which float in the air as signs, not things). */
function M({ p, s, c, r, shadow = true }: { p: V3; s: V3; c: string; r?: (m: THREE.Mesh | null) => void; shadow?: boolean }) {
  return (
    <mesh ref={r} position={p} scale={s} material={toon(c)} castShadow={shadow} receiveShadow={shadow} raycast={() => null}>
      <boxGeometry />
    </mesh>
  )
}

/** The moving parts of one figure. */
export interface Rig {
  root: THREE.Group | null
  seated: THREE.Group | null
  standing: THREE.Group | null
  legs: Array<THREE.Group | null>
  arms: Array<THREE.Group | null>
  /** Seated shins and feet, stretched down to the floor from a seat higher than a chair. */
  shins: Array<THREE.Mesh | null>
  feet: Array<THREE.Mesh | null>
  /** A mug in the right hand, shown while having a coffee. */
  mug: THREE.Group | null
  /** How far the seated shins already reach below the feet (`Figure`'s `drop`). */
  drop: number
}

export const newRig = (): Rig => ({
  root: null, seated: null, standing: null, legs: [null, null], arms: [null, null], shins: [null, null], feet: [null, null], mug: null, drop: 0,
})

export { seedOf } from './figureStyle'

/** A colour a little darker (k < 1) or lighter (k > 1). */
const tone = (c: string, k: number) => `#${new THREE.Color(c).multiplyScalar(k).getHexString()}`

const INK = '#1f1d2b'
/** A lab coat's white. */
const COAT = '#f4f4f0'
/** Flip-flops, worn with swimwear. */
const FLIPFLOP = '#f2a93b'
const SHOE = '#2a2a30'

/** Head, face, hair and headwear, centred at height `y`; the face looks towards -z. */
function head(y: number, look: Look, st: Style) {
  const parts: Array<[V3, V3, string]> = [
    [[0, y, -0.02], [0.3, 0.28, 0.28], look.skin],
    // eyes, mouth and ears
    [[-0.07, y + 0.02, -0.165], [0.05, 0.06, 0.01], INK],
    [[0.07, y + 0.02, -0.165], [0.05, 0.06, 0.01], INK],
    [[0, y - 0.075, -0.165], [0.08, 0.024, 0.01], '#a8524a'],
    [[-0.16, y, -0.02], [0.03, 0.08, 0.07], tone(look.skin, 0.92)],
    [[0.16, y, -0.02], [0.03, 0.08, 0.07], tone(look.skin, 0.92)],
  ]
  const h = look.hair
  const cap = look.extra === 'cap'
  // a cap, a beanie or a straw hat covers the crown: nothing that sits on top of the head shows
  const covered = cap || look.extra === 'beanie' || look.extra === 'strawhat'
  // a beret sits on the crown, so buns, spikes and the like give way to it, but the crown stays
  const topped = covered || look.extra === 'beret'
  // the crown and back of the head, by cut
  if (st.hair === 'buzz' || st.hair === 'mohawk') parts.push([[0, y + 0.155, -0.02], [0.31, 0.04, 0.31], h], [[0, y + 0.06, 0.125], [0.31, 0.14, 0.03], h])
  else if (st.hair !== 'bald') {
    if (!covered) parts.push([[0, y + 0.17, -0.02], [0.32, 0.08, 0.32], h])
    parts.push([[0, y + 0.03, 0.13], [0.32, 0.24, 0.04], h], [[-0.16, y + 0.08, 0], [0.04, 0.12, 0.24], h], [[0.16, y + 0.08, 0], [0.04, 0.12, 0.24], h])
  }
  if (st.hair === 'long') parts.push([[0, y - 0.1, 0.13], [0.34, 0.3, 0.06], h], [[-0.165, y - 0.04, 0.03], [0.04, 0.26, 0.2], h], [[0.165, y - 0.04, 0.03], [0.04, 0.26, 0.2], h])
  if (st.hair === 'fringe') parts.push([[0, y + 0.1, -0.165], [0.32, 0.07, 0.03], h])
  if (st.hair === 'bun' && !topped) parts.push([[0, y + 0.25, 0.07], [0.14, 0.12, 0.14], h])
  if (st.hair === 'spiky' && !topped) for (const x of [-0.09, 0, 0.09]) parts.push([[x, y + 0.24, -0.02 + x * 0.4], [0.08, 0.08, 0.08], h])
  // a tail down the back, held by a band
  if (st.hair === 'ponytail') parts.push([[0, y + 0.06, 0.17], [0.1, 0.08, 0.06], tone(h, 0.7)], [[0, y - 0.1, 0.19], [0.1, 0.26, 0.08], h])
  // to the jaw all round, with a straight fringe
  if (st.hair === 'bob') parts.push([[0, y - 0.04, 0.13], [0.34, 0.2, 0.05], h], [[-0.165, y - 0.02, -0.01], [0.04, 0.2, 0.26], h], [[0.165, y - 0.02, -0.01], [0.04, 0.2, 0.26], h], [[0, y + 0.11, -0.165], [0.32, 0.05, 0.03], h])
  // a big round cloud, wider than the head
  if (st.hair === 'afro') {
    parts.push([[0, y + 0.08, 0.04], [0.42, 0.3, 0.38], h], [[-0.19, y - 0.02, 0.03], [0.06, 0.2, 0.3], h], [[0.19, y - 0.02, 0.03], [0.06, 0.2, 0.3], h])
    if (!covered) parts.push([[0, y + 0.22, -0.01], [0.38, 0.1, 0.34], h])
  }
  if (st.hair === 'mohawk' && !topped) parts.push([[0, y + 0.23, -0.0], [0.08, 0.12, 0.34], h])
  // a side parting: the fringe swept to one side
  if (st.hair === 'side') parts.push([[0.05, y + 0.11, -0.165], [0.22, 0.06, 0.03], h], [[0.13, y + 0.06, -0.165], [0.06, 0.06, 0.03], h])
  // a tail either side, or one, held by bands
  if (st.hair === 'twintails' || st.hair === 'sidetail') {
    for (const k of st.hair === 'twintails' ? [-1, 1] : [-1]) {
      parts.push([[k * 0.2, y + 0.08, 0.05], [0.1, 0.06, 0.1], tone(h, 0.7)], [[k * 0.21, y - 0.08, 0.05], [0.08, 0.26, 0.08], h], [[k * 0.22, y - 0.23, 0.05], [0.06, 0.06, 0.06], h])
    }
  }
  // long and full, past the shoulders, the ends curling out
  if (st.hair === 'waves') {
    parts.push([[0, y - 0.14, 0.14], [0.38, 0.38, 0.07], h], [[-0.18, y - 0.06, 0.03], [0.05, 0.32, 0.22], h], [[0.18, y - 0.06, 0.03], [0.05, 0.32, 0.22], h])
    parts.push([[-0.2, y - 0.2, -0.03], [0.06, 0.07, 0.1], h], [[0.2, y - 0.2, -0.03], [0.06, 0.07, 0.1], h])
  }
  // two buns on top, one each side
  if (st.hair === 'buns' && !topped) parts.push([[-0.11, y + 0.24, 0.02], [0.12, 0.11, 0.12], h], [[0.11, y + 0.24, 0.02], [0.12, 0.11, 0.12], h])
  // one plait down over the right shoulder, in front of the chest, tied at the end
  if (st.hair === 'braid') {
    parts.push([[0.15, y - 0.04, -0.12], [0.07, 0.14, 0.07], h], [[0.13, y - 0.15, -0.16], [0.08, 0.09, 0.08], h], [[0.12, y - 0.24, -0.165], [0.075, 0.09, 0.075], h])
    parts.push([[0.13, y - 0.32, -0.16], [0.07, 0.08, 0.07], h], [[0.13, y - 0.38, -0.16], [0.06, 0.04, 0.06], tone(h, 0.7)])
  }
  // long hair with the top half tied back in a small knot
  if (st.hair === 'halfup') {
    parts.push([[0, y - 0.1, 0.13], [0.34, 0.3, 0.06], h], [[-0.165, y - 0.04, 0.03], [0.04, 0.26, 0.2], h], [[0.165, y - 0.04, 0.03], [0.04, 0.26, 0.2], h])
    parts.push([[0, y + 0.13, 0.18], [0.12, 0.1, 0.07], h])
  }
  // short curls: lumps on top and over the ears
  if (st.hair === 'curly') {
    if (!topped) for (const x of [-0.1, 0, 0.1]) parts.push([[x, y + 0.235, -0.03 + Math.abs(x) * 0.5], [0.1, 0.06, 0.1], h])
    parts.push([[-0.18, y + 0.1, -0.05], [0.05, 0.08, 0.08], h], [[0.18, y + 0.1, -0.05], [0.05, 0.08, 0.08], h], [[0, y + 0.12, -0.17], [0.26, 0.04, 0.03], h])
  }
  // combed up high at the front and back over the crown
  if (st.hair === 'quiff' && !topped) parts.push([[0, y + 0.22, -0.12], [0.3, 0.1, 0.12], h], [[0, y + 0.27, -0.14], [0.24, 0.05, 0.1], h])
  if (st.facial === 'goatee') parts.push([[0, y - 0.12, -0.17], [0.08, 0.06, 0.03], h])
  if (st.facial === 'mustache') parts.push([[0, y - 0.045, -0.168], [0.14, 0.03, 0.012], h])
  if (st.facial === 'beard' || st.facial === 'stubble') {
    // chin and jaw, below the mouth; stubble is a shadow of one
    const c = st.facial === 'beard' ? h : tone(look.skin, 0.78)
    const deep = st.facial === 'beard' ? 0.05 : 0.012
    parts.push([[0, y - 0.115, -0.15 - deep / 2 + 0.006], [0.3, 0.06, deep], c])
    parts.push([[-0.135, y - 0.06, -0.15 - deep / 2 + 0.006], [0.03, 0.12, deep], c], [[0.135, y - 0.06, -0.15 - deep / 2 + 0.006], [0.03, 0.12, deep], c])
    if (st.facial === 'beard') parts.push([[0, y - 0.045, -0.168], [0.14, 0.03, 0.012], h])
  }
  // Hats are sized to sit over the hair, never level with it: two faces in one plane flicker between their colours.
  // An afro is wider and taller than the head, so a hat is pulled down over it, bigger and higher.
  const afro = st.hair === 'afro'
  if (cap) {
    const c = tone(look.shirt, 0.8)
    if (afro) parts.push([[0, y + 0.25, 0.02], [0.44, 0.1, 0.44], c], [[0, y + 0.22, -0.26], [0.34, 0.03, 0.14], c])
    else parts.push([[0, y + 0.18, -0.02], [0.34, 0.1, 0.36], c], [[0, y + 0.135, -0.23], [0.33, 0.03, 0.14], c])
  }
  if (look.extra === 'beanie') {
    // a knitted hat with a folded band and a bobble
    const [hy, hz, hw] = afro ? [0.26, 0.02, 0.44] : [0.19, -0.02, 0.34]
    parts.push([[0, y + hy, hz], [hw, 0.14, hw + 0.02], st.accent], [[0, y + hy - 0.07, hz], [hw + 0.01, 0.05, hw + 0.03], tone(st.accent, 0.82)], [[0, y + hy + 0.1, hz], [0.08, 0.07, 0.08], tone(st.accent, 1.15)])
  }
  if (look.extra === 'bow') {
    // between two buns it sits in front of them, in the middle
    const [bx, by, bz] = st.hair === 'buns' ? [-0.05, y + 0.22, -0.1] : [0.07, y + (afro ? 0.3 : 0.22), -0.04]
    parts.push([[bx, by, bz], [0.08, 0.08, 0.05], '#e5484d'], [[bx + 0.1, by, bz], [0.08, 0.08, 0.05], '#e5484d'], [[bx + 0.05, by, bz - 0.005], [0.04, 0.05, 0.05], '#b8323a'])
  }
  // how high the hair reaches, and how far out at the sides, for what sits on or beside it
  const crown = st.hair === 'bald' ? 0.14 : st.hair === 'buzz' || st.hair === 'mohawk' ? 0.175 : afro ? 0.27 : 0.21
  const side = afro ? 0.22 : st.hair === 'waves' || st.hair === 'curly' ? 0.205 : st.hair === 'buzz' || st.hair === 'mohawk' || st.hair === 'bald' ? 0.15
    : st.hair === 'long' || st.hair === 'bob' || st.hair === 'halfup' ? 0.185 : 0.18
  if (look.extra === 'strawhat') {
    // a wide brim with a red band round the crown
    const [hy, hw] = afro ? [0.29, 0.44] : [0.21, 0.34]
    parts.push([[0, y + hy - 0.065, -0.02], [hw + 0.22, 0.03, hw + 0.22], '#e3c27a'], [[0, y + hy, -0.02], [hw, 0.1, hw], '#e3c27a'])
    parts.push([[0, y + hy - 0.03, -0.02], [hw + 0.01, 0.035, hw + 0.01], '#c0453a'])
  }
  if (look.extra === 'beret') {
    // flat, pulled over to the left, with a stalk on top
    const w = afro ? 0.46 : 0.38
    parts.push([[-0.05, y + crown + 0.025, -0.02], [w, 0.06, w - 0.02], st.accent], [[-0.05, y + crown + 0.07, -0.02], [0.03, 0.03, 0.03], tone(st.accent, 0.8)])
  }
  if (look.extra === 'bandana') {
    // a band round the forehead, knotted at the back
    const [w, z, d] = afro ? [0.45, 0.04, 0.42] : [0.38, -0.02, 0.36]
    parts.push([[0, y + 0.092, z], [w, 0.06, d], st.accent], [[0.07, y + 0.092, z + d / 2 + 0.02], [0.06, 0.06, 0.05], tone(st.accent, 0.8)])
    parts.push([[0.09, y + 0.03, z + d / 2 + 0.015], [0.05, 0.1, 0.02], tone(st.accent, 0.8)])
  }
  if (look.extra === 'headband') {
    // a thin band over the top, from ear to ear
    const ex = afro ? 0.235 : side === 0.15 ? 0.165 : 0.175
    const top = y + crown + 0.018
    parts.push([[0, top, -0.04], [ex * 2 - 0.02, 0.03, 0.05], st.accent])
    for (const k of [-1, 1]) parts.push([[k * ex, (top + y + 0.03) / 2, -0.04], [0.03, top - y - 0.03, 0.05], st.accent])
  }
  if (look.extra === 'hairclip') {
    // two clips above the left ear, the side the map sees
    parts.push([[-side - 0.012, y + 0.1, -0.07], [0.03, 0.025, 0.09], '#ffcf5a'], [[-side - 0.012, y + 0.05, -0.07], [0.03, 0.025, 0.09], '#e86f8a'])
  }
  if (look.extra === 'flower') {
    // over the left ear, the side the map sees: four petals round a yellow middle
    const cx = -side - 0.02
    parts.push([[cx, y + 0.1, -0.04], [0.05, 0.12, 0.05], '#f28bb0'], [[cx, y + 0.1, -0.04], [0.05, 0.05, 0.12], '#f28bb0'], [[cx - 0.005, y + 0.1, -0.04], [0.05, 0.06, 0.06], '#ffcf5a'])
  }
  if (look.extra === 'glasses') {
    parts.push([[-0.075, y + 0.02, -0.17], [0.11, 0.09, 0.01], '#2a2a33'], [[0.075, y + 0.02, -0.17], [0.11, 0.09, 0.01], '#2a2a33'])
    parts.push([[-0.075, y + 0.02, -0.176], [0.07, 0.05, 0.01], '#cfe3ef'], [[0.075, y + 0.02, -0.176], [0.07, 0.05, 0.01], '#cfe3ef'])
  }
  if (look.extra === 'sunglasses') {
    parts.push([[-0.075, y + 0.02, -0.172], [0.12, 0.08, 0.012], '#16161c'], [[0.075, y + 0.02, -0.172], [0.12, 0.08, 0.012], '#16161c'])
    parts.push([[0, y + 0.045, -0.172], [0.06, 0.02, 0.012], '#16161c'])
  }
  if (look.extra === 'headset') {
    // over an afro: a wider band above the hair, straps down its sides and the cups outside it
    const ex = afro ? 0.235 : side > 0.2 ? 0.225 : 0.18
    parts.push([[0, y + (afro ? 0.29 : 0.2), -0.02], [ex * 2, 0.04, 0.06], '#2a2a33'], [[-ex, y, -0.02], [0.05, 0.11, 0.11], '#2a2a33'], [[ex, y, -0.02], [0.05, 0.11, 0.11], '#2a2a33'])
    if (afro) parts.push([[-ex, y + 0.155, -0.02], [0.03, 0.23, 0.04], '#2a2a33'], [[ex, y + 0.155, -0.02], [0.03, 0.23, 0.04], '#2a2a33'])
    parts.push([[-ex + (afro ? 0.03 : 0.035), y - 0.07, -0.12], [0.02, 0.02, 0.14], '#2a2a33'])
  }
  return parts
}

/** The head's boxes, as [centre, size, colour], for checking how they fit together. */
export const headBoxesForTest = (look: Look, st: Style) => head(0, look, st)

/** Upper body between heights `y0` and `y1`, `w` wide, front towards -z; `tails` hangs a long coat's tails below `y0`. */
function torso(y0: number, y1: number, w: number, look: Look, st: Style, tails = false) {
  const y = (y0 + y1) / 2
  const h = y1 - y0
  const front = -0.115
  if (isSwimwear(st.bottom)) {
    // bare, with a bikini top across the chest and straps over the shoulders
    const bare: Array<[V3, V3, string]> = [[[0, y, 0], [w, h, 0.22], look.skin]]
    if (st.bottom === 'bikini') {
      bare.push([[0, y1 - h * 0.38, 0], [w + 0.006, 0.07, 0.226], look.shirt])
      for (const k of [-1, 1]) bare.push([[k * 0.09, y1 - h * 0.14, front - 0.002], [0.03, h * 0.28, 0.01], look.shirt])
    }
    return bare
  }
  const body = st.top === 'jacket' || st.top === 'vest' || st.top === 'cardigan' ? st.accent : st.top === 'labcoat' ? COAT : look.shirt
  const parts: Array<[V3, V3, string]> = [[[0, y, 0], [w, h, 0.22], body]]
  // an open cardigan: the shirt (or dress) down the front, a ribbed hem and buttons
  if (st.top === 'cardigan') {
    parts.push([[0, y, front], [0.1, h, 0.01], look.shirt], [[0, y0 + 0.025, 0], [w + 0.01, 0.05, 0.23], tone(body, 0.85)])
    for (const k of [0.35, 0.65]) parts.push([[-0.065, y0 + h * k, front - 0.002], [0.025, 0.025, 0.01], tone(body, 0.7)])
  }
  // a blouse: a white collar with a bow at the neck
  if (st.top === 'bowshirt') {
    parts.push([[0, y1 - 0.02, front], [0.2, 0.04, 0.01], '#f4f4f0'])
    parts.push([[-0.035, y1 - 0.05, front - 0.004], [0.05, 0.04, 0.012], st.accent], [[0.035, y1 - 0.05, front - 0.004], [0.05, 0.04, 0.012], st.accent], [[0, y1 - 0.05, front - 0.006], [0.02, 0.03, 0.012], tone(st.accent, 0.8)])
  }
  // checks: bands round and down, in one colour
  if (st.top === 'plaid') {
    for (const k of [0.3, 0.7]) parts.push([[0, y0 + h * k, 0], [w + 0.006, 0.03, 0.226], st.accent])
    for (const x of [-w / 4, w / 4]) parts.push([[x, y, 0], [0.03, h - 0.004, 0.226], st.accent])
  }
  // a long white coat, open over the shirt, with lapels and pockets; its tails hang below the waist when standing
  if (st.top === 'labcoat') {
    parts.push([[0, y1 - 0.08, front], [0.1, 0.16, 0.01], look.shirt])
    parts.push([[-0.06, y1 - 0.07, front - 0.004], [0.05, 0.12, 0.01], tone(COAT, 0.88)], [[0.06, y1 - 0.07, front - 0.004], [0.05, 0.12, 0.01], tone(COAT, 0.88)])
    for (const k of [-1, 1]) parts.push([[k * 0.11, y0 + 0.07, front], [0.08, 0.06, 0.01], tone(COAT, 0.9)])
    if (tails) parts.push([[0, y0 - 0.1, 0], [w + 0.02, 0.2, 0.24], COAT])
  }
  // a high collar round the neck, under the chin, and a ribbed hem
  if (st.top === 'turtleneck') parts.push([[0, y1 - 0.01, -0.02], [0.32, 0.06, 0.3], tone(body, 0.85)], [[0, y0 + 0.025, 0], [w + 0.01, 0.05, 0.23], tone(body, 0.85)])
  if (st.top === 'jacket') {
    // open jacket over a light shirt, with lapels
    parts.push([[0, y, front], [0.12, h, 0.01], '#eef0f2'], [[-0.07, y1 - 0.06, front - 0.004], [0.05, 0.1, 0.01], tone(body, 0.8)], [[0.07, y1 - 0.06, front - 0.004], [0.05, 0.1, 0.01], tone(body, 0.8)])
  }
  if (st.top === 'tie') parts.push([[0, y1 - 0.02, front], [0.2, 0.04, 0.01], '#f4f4f0'], [[0, y + 0.02, front - 0.002], [0.05, h * 0.75, 0.01], st.accent])
  if (st.top === 'hoodie') {
    // the hood down on the back, a pocket in front and the drawstrings
    parts.push([[0, y1 - 0.02, 0.13], [0.3, 0.12, 0.06], tone(body, 0.85)], [[0, y0 + 0.08, front], [0.24, 0.08, 0.01], tone(body, 0.85)])
    parts.push([[-0.04, y1 - 0.07, front], [0.02, 0.08, 0.01], '#f4f4f0'], [[0.04, y1 - 0.07, front], [0.02, 0.08, 0.01], '#f4f4f0'])
  }
  if (st.top === 'tee') parts.push([[0, y1 - 0.015, front], [0.14, 0.03, 0.01], tone(body, 0.8)])
  // knit: ribbed hem and neck, a band across the chest
  if (st.top === 'sweater') {
    parts.push([[0, y0 + 0.025, 0], [w + 0.01, 0.05, 0.23], tone(body, 0.82)], [[0, y1 - 0.015, front], [0.16, 0.03, 0.01], tone(body, 0.82)])
    parts.push([[0, y + 0.03, 0], [w + 0.006, 0.05, 0.226], st.accent])
  }
  // a collar either side of a short button placket
  if (st.top === 'polo') {
    parts.push([[-0.06, y1 - 0.02, front - 0.002], [0.08, 0.04, 0.012], tone(body, 0.85)], [[0.06, y1 - 0.02, front - 0.002], [0.08, 0.04, 0.012], tone(body, 0.85)])
    parts.push([[0, y1 - 0.08, front], [0.03, 0.1, 0.01], tone(body, 0.85)])
  }
  // a vest over the shirt: the shirt shows in a V at the neck
  if (st.top === 'vest') parts.push([[0, y1 - 0.06, front - 0.002], [0.1, 0.12, 0.01], look.shirt], [[0, y1 - 0.13, front - 0.002], [0.04, 0.04, 0.01], look.shirt])
  if (st.top === 'stripes') for (const k of [0.25, 0.5, 0.75]) parts.push([[0, y0 + h * k, 0], [w + 0.006, 0.035, 0.226], st.accent])
  return parts
}

const boxes = (parts: Array<[V3, V3, string]>, key: string) => parts.map(([p, sz, c], i) => <M key={`${key}${i}`} p={p} s={sz} c={c} />)

/**
 * A person facing -z at the origin, feet on y = 0, in office units; `scale` sizes it into the world
 * (positions stay in the parent's units). `drop` lengthens the seated shins below the feet, for seats
 * higher than an office chair. `seed` picks the hairstyle and clothes.
 */
export const Figure = memo(function Figure({ look, rig, seed, drop = 0, scale = 1, beach = false }: {
  look: Look; rig: Rig; seed: number; drop?: number; scale?: number
  /** Out on the island: more often in swimwear. */
  beach?: boolean
}) {
  const st = useMemo(() => styleOf(seed, look.wardrobe, beach), [seed, look.wardrobe, beach])
  const sleeve = st.top === 'jacket' || st.top === 'cardigan' ? st.accent : st.top === 'labcoat' ? COAT : look.shirt
  // short sleeves on a tee, a polo, a striped top or a blouse, so the forearms show
  const forearm = st.top === 'tee' || st.top === 'polo' || st.top === 'stripes' || st.top === 'bowshirt' ? look.skin : sleeve
  // a skirt in the trousers' colour, a dress in the shirt's; bare legs below either, but a long skirt hides them
  const skirt = st.bottom === 'dress' ? look.shirt : look.pants
  const legs = st.bottom === 'pants' || st.bottom === 'longskirt' ? look.pants : look.skin
  const hem = st.bottom === 'longskirt' ? 0.07 : st.bottom === 'pants' ? 0.47 : 0.25
  // swimwear: bare arms and legs, trunks in the trousers' colour or a bikini in the shirt's, and flip-flops
  const swim = isSwimwear(st.bottom)
  const suit = st.bottom === 'bikini' ? look.shirt : look.pants
  const arm = swim ? look.skin : sleeve
  const lower = swim ? look.skin : forearm
  rig.drop = drop
  return (
    <group ref={(g) => void (rig.root = g)} scale={scale}>
      {/* seated at a desk or on a bench: thighs forward, hands reaching to the lap or keyboard */}
      <group ref={(g) => void (rig.seated = g)}>
        {swim
          ? <>
            {/* bare thighs, the trunks or bikini over the hips */}
            <M p={[0, 0.3, -0.16]} s={[0.34, 0.12, 0.34]} c={look.skin} />
            <M p={[0, 0.3, st.bottom === 'trunks' ? -0.08 : -0.05]} s={[0.35, 0.13, st.bottom === 'trunks' ? 0.19 : 0.13]} c={suit} />
          </>
          : st.bottom === 'pants'
          ? <M p={[0, 0.3, -0.16]} s={[0.34, 0.12, 0.34]} c={look.pants} />
          : <>
            {/* a skirt over the lap, its hem falling over the knees */}
            <M p={[0, 0.3, -0.17]} s={[0.38, 0.12, 0.38]} c={skirt} />
            <M p={[0, st.bottom === 'longskirt' ? 0.15 : 0.2, -0.37]} s={[0.38, st.bottom === 'longskirt' ? 0.22 : 0.1, 0.02]} c={skirt} />
          </>}
        {[-1, 1].map((k, i) => <M key={`s${k}`} r={(m) => void (rig.shins[i] = m)} p={[k * 0.09, (0.24 - drop) / 2, -0.28]} s={[0.12, 0.24 + drop, 0.12]} c={legs} />)}
        {[-1, 1].map((k, i) => <M key={`f${k}`} r={(m) => void (rig.feet[i] = m)} p={[k * 0.09, 0.035 - drop, -0.31]} s={[0.14, 0.07, 0.2]} c={swim ? FLIPFLOP : SHOE} />)}
        {boxes(torso(0.35, 0.69, 0.42, look, st), 't')}
        {[-1, 1].map((k) => (
          <group key={`a${k}`}>
            <M p={[k * 0.26, 0.58, -0.02]} s={[0.1, 0.18, 0.14]} c={arm} />
            <M p={[k * 0.26, 0.48, -0.15]} s={[0.1, 0.1, 0.22]} c={lower} />
            <M p={[k * 0.25, 0.48, -0.28]} s={[0.09, 0.08, 0.08]} c={look.skin} />
          </group>
        ))}
        {boxes(head(0.82, look, st), 'h')}
      </group>
      {/* standing: legs and arms hang from hips and shoulders so they can swing */}
      <group ref={(g) => void (rig.standing = g)} visible={false}>
        {[-1, 1].map((k, i) => (
          <group key={`l${k}`} ref={(g) => void (rig.legs[i] = g)} position={[k * 0.1, 0.44, 0]}>
            <M p={[0, -0.2, 0]} s={[0.15, 0.4, 0.17]} c={legs} />
            {swim
              ? <>
                {/* the trunks' legs, or a bikini's sides, swinging with the leg; bare feet on flip-flops */}
                <M p={[0, st.bottom === 'trunks' ? -0.075 : -0.03, 0]} s={[0.16, st.bottom === 'trunks' ? 0.14 : 0.05, 0.18]} c={suit} />
                <M p={[0, -0.405, -0.03]} s={[0.16, 0.07, 0.23]} c={look.skin} />
                <M p={[0, -0.432, -0.03]} s={[0.17, 0.02, 0.24]} c={FLIPFLOP} />
              </>
              : <M p={[0, -0.405, -0.03]} s={[0.16, 0.07, 0.23]} c={SHOE} />}
          </group>
        ))}
        <M p={[0, 0.46, 0]} s={[0.41, 0.05, 0.23]} c={swim ? suit : tone(skirt, st.bottom === 'dress' ? 0.8 : 0.7)} />
        {!swim && st.bottom !== 'pants' && (
          <>
            {/* the skirt from the waist to its hem, flaring out at the bottom */}
            <M p={[0, (0.47 + hem) / 2, 0]} s={[0.42, 0.47 - hem, 0.27]} c={skirt} />
            <M p={[0, hem + 0.02, 0]} s={[0.48, 0.06, 0.31]} c={tone(skirt, 0.9)} />
          </>
        )}
        {boxes(torso(0.48, 0.82, 0.4, look, st, true), 't')}
        {[-1, 1].map((k, i) => (
          <group key={`r${k}`} ref={(g) => void (rig.arms[i] = g)} position={[k * 0.25, 0.8, 0]}>
            <M p={[0, -0.09, 0]} s={[0.1, 0.18, 0.13]} c={arm} />
            <M p={[0, -0.26, 0]} s={[0.1, 0.16, 0.12]} c={lower} />
            <M p={[0, -0.38, 0]} s={[0.09, 0.08, 0.1]} c={look.skin} />
            {/* a mug in the right hand, held out in front */}
            {k === 1 && (
              <group ref={(g) => void (rig.mug = g)} position={[0, -0.4, -0.1]} visible={false}>
                <M p={[0, 0, 0]} s={[0.1, 0.12, 0.1]} c="#f5f5f0" />
                <M p={[0.065, 0, 0]} s={[0.03, 0.06, 0.04]} c="#f5f5f0" />
              </group>
            )}
          </group>
        ))}
        {boxes(head(0.96, look, st), 'h')}
      </group>
    </group>
  )
})

/**
 * Puts a figure where its walker is: seated or standing, legs swinging by how far it walked this frame.
 * `lift` raises someone seated higher than a chair (a sofa), shins stretched down to the floor.
 */
export function pose(rig: Rig, w: Walker & { phase: number }, seated: boolean, moved: number, y: number, dt: number, lift = 0) {
  const root = rig.root
  if (!root || !rig.seated || !rig.standing) return
  rig.seated.visible = seated
  rig.standing.visible = !seated
  // turn smoothly, the short way round
  let turn = w.heading - root.rotation.y
  turn = Math.atan2(Math.sin(turn), Math.cos(turn))
  root.rotation.y += seated ? turn : turn * Math.min(1, TURN * dt)
  w.phase = moved > 0 ? w.phase + moved * STRIDE : 0
  const swing = moved > 0 ? Math.sin(w.phase) : 0
  rig.legs.forEach((l, i) => l && (l.rotation.x = swing * 0.55 * (i ? -1 : 1)))
  rig.arms.forEach((a, i) => a && (a.rotation.x = swing * 0.45 * (i ? 1 : -1)))
  root.position.set(w.x, y + (seated ? lift : 0) + Math.abs(swing) * 0.03, w.z)
  const reach = rig.drop + (seated ? lift : 0)
  rig.shins.forEach((s) => s && (s.position.y = (0.24 - reach) / 2, s.scale.y = 0.24 + reach))
  rig.feet.forEach((f) => f && (f.position.y = 0.035 - reach))
}

const rand = (a: number, b: number) => a + Math.random() * (b - a)
const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)]

// ---------------------------------------------------------------- in the office

export interface CrewMember {
  id: string
  look: Look
  /** Working on something: stays at (or goes back to) the desk. */
  busy: boolean
}

/** Where idle people can go besides wandering, in office units; empty when the room has none. */
export interface Amenities {
  /** Sofa seats: where to sit, which way to face, and the way in from the open floor (walked in this order). */
  sofa: Array<{ at: P; heading: number; way: P[] }>
  /** Where to stand for a coffee or a cup of water, facing the machine, and the way in from the open floor if it is tucked away. */
  coffee: Array<{ at: P; heading: number; way?: P[] }>
}

const NO_AMENITIES: Amenities = { sofa: [], coffee: [] }

/** What an idle person is up to. */
type Act = 'wander' | 'chat' | 'sofa' | 'coffee' | 'daze'
type Mode = 'seated' | 'walking' | 'standing' | 'lounging'

interface Worker extends Walker {
  phase: number
  mode: Mode
  /** Seconds until the next decision. */
  wait: number
  /** Heading home to sit down. */
  home: boolean
  act: Act
  /** Chatting: who with. */
  partner: string | null
  /** Chatting: walked over to the other, rather than waited. */
  lead: boolean
  /** Sofa seat or coffee spot held, by index. */
  spot: number
  /** Seconds into the current act, for gestures and bubbles. */
  t: number
  /** Distance walked in the last step, for the stride. */
  moved: number
}

/** Height of a sofa seat over a chair's, in office units: someone on it sits this much higher. */
const SOFA_LIFT = 0.36 - 0.23
/** How far apart two people stand to talk. */
const TALK_GAP = 0.8

/** A speech bubble (`kind` 'talk') or a thought bubble ('think'), turned to the camera; placed per frame. */
function Bubble({ bind, kind }: { bind: (g: THREE.Group | null) => void; kind: 'talk' | 'think' }) {
  const think = kind === 'think'
  const body = think ? '#eef1f6' : '#ffffff'
  return (
    <group ref={bind} visible={false} rotation={[0, Math.PI / 4, 0]}>
      <M p={[0, 0, 0]} s={[0.8, 0.44, 0.06]} c={body} shadow={false} />
      {think
        ? [<M key="a" p={[-0.3, -0.32, 0]} s={[0.14, 0.14, 0.06]} c={body} shadow={false} />, <M key="b" p={[-0.4, -0.47, 0]} s={[0.09, 0.09, 0.06]} c={body} shadow={false} />]
        : <M p={[-0.2, -0.28, 0]} s={[0.16, 0.13, 0.06]} c={body} shadow={false} />}
      {[-0.2, 0, 0.2].map((x) => <M key={x} p={[x, 0, 0.035]} s={[0.1, 0.1, 0.02]} c="#4a4f5c" shadow={false} />)}
    </group>
  )
}

/** One office's idle life: its room, where people can go, and everyone's state, kept while the office is closed. */
interface OfficeSim {
  plan: OfficePlan
  grid: ReturnType<typeof officeGrid>
  spots: P[]
  amenities: Amenities
  states: Map<string, Worker>
}

/**
 * Moves everyone in an office on by `dt` seconds: decisions and walking only, nothing drawn, so a closed
 * office can be caught up cheaply when it opens again.
 */
function tick(sim: OfficeSim, crewNow: CrewMember[], dt: number) {
  const { plan, grid, spots, amenities, states } = sim
  // seats and spots already held, so two people never go for the same one
  const held = (act: Act) => new Set([...states.values()].filter((o) => o.act === act).map((o) => o.spot))
  crewNow.forEach((c, i) => {
    const seat = plan.seats[i]
    if (!seat) return
    // the walkway cell just behind the chair, where people stand up into and sit down from
    const aisle: P = [seat[0], seat[1] + 0.7]
    let w = states.get(c.id)
    if (!w) {
      // everyone starts at their desk; idle people get up at different times
      w = { x: seat[0], z: seat[1], route: [], heading: 0, phase: 0, moved: 0, mode: 'seated', wait: rand(0.6, 5), home: false, act: 'wander', partner: null, lead: false, spot: -1, t: 0 }
      states.set(c.id, w)
    }
    const me = w
    /** Off the sofa, or away from a tucked-away coffee machine, first: by the way in backwards. */
    const leaving = (): P[] => {
      if (me.mode === 'lounging' && amenities.sofa[me.spot]) return [...amenities.sofa[me.spot].way].reverse()
      const cup = me.act === 'coffee' && me.mode === 'standing' ? amenities.coffee[me.spot] : undefined
      return cup?.way ? [...cup.way].reverse() : []
    }
    const stopAct = () => {
      // whoever was chatting with this one stops too
      if (me.act === 'chat' && me.partner) {
        const o = states.get(me.partner)
        if (o && o.act === 'chat' && o.partner === c.id) {
          o.act = 'wander'
          o.partner = null
          if (o.mode === 'standing') o.wait = Math.min(o.wait, rand(0.3, 1.2))
        }
      }
      me.act = 'wander'
      me.partner = null
      me.spot = -1
    }
    const goHome = () => {
      const out = leaving()
      stopAct()
      me.route = [...out, ...route(grid, out.length ? out[out.length - 1] : [me.x, me.z], aisle), seat]
      me.mode = 'walking'
      me.home = true
    }
    const walkTo = (to: P, act: Act) => {
      const out = leaving()
      stopAct()
      me.route = [...out, ...route(grid, out.length ? out[out.length - 1] : [me.x, me.z], to)]
      me.act = act
      me.mode = 'walking'
      me.home = false
    }
    /** Picks what to do next, standing somewhere (or on the sofa) with nothing to do. */
    const next = () => {
      if (Math.random() < 0.2) return goHome()
      const r = Math.random()
      // someone else idle and standing about, to go and talk to
      const others = crewNow.filter((o) => {
        const s = states.get(o.id)
        return o.id !== c.id && !o.busy && s && s.mode === 'standing' && s.act === 'wander'
      })
      const sofa = amenities.sofa.map((_, k) => k).filter((k) => !held('sofa').has(k))
      const coffee = amenities.coffee.map((_, k) => k).filter((k) => !held('coffee').has(k))
      if (r < 0.3 && others.length) {
        const o = pick(others)
        const s = states.get(o.id) as Worker
        // stand beside them as seen on screen (along x - z), so neither hides the other; on our side
        const side = me.x - me.z > s.x - s.z ? 1 : -1
        const off = (TALK_GAP / Math.SQRT2) * side
        const to: P = [s.x + off, s.z - off]
        walkTo(to, 'chat')
        if (!me.route.length) return stopAct()
        // the grid gets us near; the last step to the exact spot, when it is open floor
        if (isFree(grid, Math.round((to[0] - grid.x0) / grid.step), Math.round((to[1] - grid.z0) / grid.step))) me.route.push(to)
        me.partner = o.id
        me.lead = true
        // the other waits where they are
        s.act = 'chat'
        s.partner = c.id
        s.lead = false
        s.wait = 30
        return
      }
      if (r < 0.5 && sofa.length) {
        const k = pick(sofa)
        const place = amenities.sofa[k]
        walkTo(place.way[0], 'sofa')
        me.route.push(...place.way, place.at)
        me.spot = k
        return
      }
      if (r < 0.7 && coffee.length) {
        const k = pick(coffee)
        const cup = amenities.coffee[k]
        walkTo(cup.way?.[0] ?? cup.at, 'coffee')
        me.route.push(...(cup.way ?? []), cup.at)
        me.spot = k
        return
      }
      walkTo(pick(spots), r < 0.85 ? 'daze' : 'wander')
    }

    me.moved = 0
    {
      me.wait -= dt
      me.t += dt
      if (me.mode === 'seated') {
        if (!c.busy && me.wait <= 0) {
          // stand up and head somewhere
          me.route = [aisle]
          me.mode = 'walking'
          me.home = false
          me.act = 'wander'
          me.route.push(...route(grid, aisle, pick(spots)))
        }
      } else if (c.busy && !me.home) {
        // work came in: go straight back
        goHome()
      } else if (me.mode === 'walking') {
        me.moved = advance(me, SPEED * dt)
        if (!me.route.length) {
          me.t = 0
          if (me.home) {
            me.mode = 'seated'
            me.heading = 0
            me.wait = c.busy ? 0 : rand(4, 10)
          } else if (me.act === 'sofa') {
            me.mode = 'lounging'
            me.heading = amenities.sofa[me.spot].heading
            me.wait = rand(8, 16)
          } else {
            me.mode = 'standing'
            if (me.act === 'coffee') {
              me.heading = amenities.coffee[me.spot].heading
              me.wait = rand(6, 10)
            } else if (me.act === 'daze') {
              me.heading = rand(-Math.PI, Math.PI)
              me.wait = rand(5, 10)
            } else if (me.act === 'chat') {
              const o = me.partner ? states.get(me.partner) : undefined
              if (o && o.act === 'chat' && o.partner === c.id) {
                // face each other and talk a while
                me.heading = headingOf(o.x - me.x, o.z - me.z)
                o.heading = headingOf(me.x - o.x, me.z - o.z)
                me.wait = o.wait = rand(5, 9)
                o.t = 0
              } else {
                stopAct()
                me.wait = rand(1, 3)
              }
            } else me.wait = rand(1.5, 4)
          }
        }
      } else if (me.mode === 'standing' || me.mode === 'lounging') {
        const o = me.act === 'chat' && me.partner ? states.get(me.partner) : undefined
        // the one we were waiting for gave up
        if (me.act === 'chat' && !(o && o.act === 'chat' && o.partner === c.id)) {
          stopAct()
          me.wait = Math.min(me.wait, rand(0.5, 1.5))
        }
        if (me.wait <= 0) next()
      }
    }
  })
}

/** Offices' idle state by company, so people carry on from where they were when it opens again. */
const sims = new Map<string, { seed: number; sim: OfficeSim; closedAt: number }>()
/** At most this long of a closed office is caught up on opening; past that it looks the same anyway. */
const CATCH_UP = 120
/** Step used to catch up, in seconds: coarse, nobody is watching. */
const CATCH_STEP = 0.2

/**
 * Everyone in an opened office, in office units. Busy people work at their desks. Idle people get up after
 * a while and walk about; between walks they stop to chat with someone else who is idle, sit on the sofa,
 * have a coffee or just stand and stare, and now and then sit back down at their desk for a bit. What they
 * are up to outlives the office: closed, it waits, and on opening again the time away is caught up (up to
 * `CATCH_UP` seconds) without drawing.
 */
export function OfficeCrew({ teamId, seed, plan, crew, floor, amenities = NO_AMENITIES }: {
  /** Whose office, and the seed its room was laid out with: the state is kept across openings while both stay the same. */
  teamId: string
  seed: number
  plan: OfficePlan
  crew: CrewMember[]
  floor: number
  amenities?: Amenities
}) {
  const sim = useMemo(() => {
    const kept = sims.get(teamId)
    if (kept && kept.seed === seed) {
      // carry on where they were, then catch up on the time the office was closed
      kept.sim.amenities = amenities
      if (!calm && kept.closedAt) {
        const gone = Math.min((performance.now() - kept.closedAt) / 1000, CATCH_UP)
        for (let t = 0; t < gone; t += CATCH_STEP) tick(kept.sim, crew, CATCH_STEP)
      }
      kept.closedAt = 0
      return kept.sim
    }
    const grid = officeGrid(plan)
    const fresh: OfficeSim = { plan, grid, spots: freeCells(grid).map(([x, z]) => cellPos(grid, x, z)), amenities, states: new Map() }
    sims.set(teamId, { seed, sim: fresh, closedAt: 0 })
    return fresh
    // the room, its amenities and the seed all come from the same layout
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId, seed])
  useEffect(() => {
    const kept = sims.get(teamId)
    if (kept?.sim === sim) kept.closedAt = 0
    return () => {
      if (kept?.sim === sim) kept.closedAt = performance.now()
    }
  }, [teamId, sim])
  const rigs = useRef(new Map<string, Rig>())
  const bubbles = useRef(new Map<string, { talk: THREE.Group | null; think: THREE.Group | null }>())
  const latest = useRef(crew)
  latest.current = crew
  const tag = useMemo(() => new THREE.Vector3(), [])

  const rigOf = (id: string) => rigs.current.get(id) ?? (rigs.current.set(id, newRig()).get(id) as Rig)
  const bubblesOf = (id: string) => bubbles.current.get(id) ?? (bubbles.current.set(id, { talk: null, think: null }).get(id) as { talk: null; think: null })

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, MAX_FRAME)
    const crewNow = latest.current
    const states = sim.states
    // with reduced motion nobody moves, but everyone still gets a place
    if (calm) tick(sim, crewNow, 0)
    else inSteps(dt, (step) => tick(sim, crewNow, step))
    crewNow.forEach((c) => {
      const me = states.get(c.id)
      if (!me) return
      const moved = me.moved
      const rig = rigOf(c.id)
      const seated = me.mode === 'seated' || me.mode === 'lounging'
      pose(rig, me, seated, moved, floor, dt, me.mode === 'lounging' ? SOFA_LIFT : 0)
      // what the hands and the bubbles show
      const partner = me.act === 'chat' && me.partner ? states.get(me.partner) : undefined
      const talking = me.mode === 'standing' && !!partner && partner.mode === 'standing' && partner.partner === c.id
      // the two take turns, about a second and a half each
      const speaking = talking && (Math.floor(me.t / 1.5) % 2 === 0) === me.lead
      const sipping = me.mode === 'standing' && me.act === 'coffee'
      const dazing = me.mode === 'standing' && me.act === 'daze'
      if (rig.mug) rig.mug.visible = sipping
      if (!calm && rig.arms[1] && sipping) rig.arms[1].rotation.x = me.t % 3 < 0.9 ? 1.9 : 0.9
      if (!calm && rig.arms[0] && speaking) rig.arms[0].rotation.x = 0.5 + Math.sin(me.t * 6) * 0.35
      // standing and staring: turning slowly to look one way, then the other
      if (!calm && dazing) me.heading += Math.sin(me.t * 0.6) * 0.25 * dt
      const b = bubblesOf(c.id)
      for (const [g, on] of [[b.talk, speaking], [b.think, dazing]] as const) {
        if (!g) continue
        g.visible = on
        // clear above the name tag, a little to the right of the screen
        if (on) g.position.set(me.x + 0.25, floor + 2.55 + Math.sin(me.t * 3) * 0.03, me.z - 0.25)
      }
      // the name tag follows, a little higher over someone standing
      if (rig.root) {
        rig.root.updateWorldMatrix(true, false)
        tag.set(0, seated ? TAG_SEATED : TAG_STANDING, 0)
        rig.root.localToWorld(tag)
        anchors.set(`fusion-crew-${c.id}`, [tag.x, tag.y, tag.z])
      }
    })
  })

  return (
    <>
      {crew.map((c) => (
        <group key={c.id}>
          <Figure look={c.look} rig={rigOf(c.id)} seed={c.look.style ?? seedOf(c.id)} />
          <Bubble kind="talk" bind={(g) => void (bubblesOf(c.id).talk = g)} />
          <Bubble kind="think" bind={(g) => void (bubblesOf(c.id).think = g)} />
        </group>
      ))}
    </>
  )
}

// ---------------------------------------------------------------- on the island

const SKIN = ['#f1c7a5', '#e0ac85', '#c68b62', '#8d5a3c', '#f6d7bd']
const HAIR = ['#2a2018', '#5a3a24', '#9a6a3a', '#d8b26a', '#1c1c24', '#b04a2a', '#c9c9cf']
const SHIRT = ['#e85d4a', '#3f7fd0', '#f2c14e', '#4fae6a', '#f0f0f0', '#8a5cc8', '#ef8fb0', '#2f9c9c']
const PANTS = ['#34405a', '#4a4a52', '#6b5642', '#2f3e6b', '#c8b48a']

export const lookOf = (i: number): Look => ({
  skin: SKIN[Math.floor(hash(i, 1) * SKIN.length)],
  hair: HAIR[Math.floor(hash(i, 2) * HAIR.length)],
  shirt: SHIRT[Math.floor(hash(i, 3) * SHIRT.length)],
  pants: PANTS[Math.floor(hash(i, 4) * PANTS.length)],
  // a few in glasses or a hat
  extra: hash(i, 8) < 0.2 ? 'glasses' : hash(i, 8) < 0.3 ? 'cap' : hash(i, 8) < 0.38 ? 'strawhat' : 'none',
  wardrobe: 2,
})

/** Height of a bench seat's top, in world units; matches the bench drawn in World. */
const BENCH_TOP = 0.56
/** Height of an office chair's seat over the floor, in office units; the seated figure is built for it. */
const CHAIR_TOP = 0.23
/** A seated figure on a bench: its feet sit this far up, so its shins reach down this much further. */
const BENCH_LIFT = BENCH_TOP / OFFICE_SCALE - CHAIR_TOP

interface Stroller extends WalkStroller {
  phase: number
}

/**
 * A few people out on the island, two to five per building: they walk between spots on the paving and
 * grass, stop for a moment, and sometimes sit on a free bench for a while.
 */
export function Strollers({ town }: { town: Town }) {
  const grid = useMemo(() => townGrid(town), [town])
  const seats = useMemo(() => benchSeats(town, grid), [town, grid])
  const cells = useMemo(() => freeCells(grid), [grid])
  const paved = useMemo(() => cells.filter(([x, z]) => town.ground[z * town.cols + x] === 'pave'), [cells, town])
  const n = useMemo(() => crowdSize(town), [town])
  const looks = useMemo(() => Array.from({ length: n }, (_, i) => lookOf(i)), [n])
  const rigs = useMemo(() => looks.map(newRig), [looks])

  const people = useMemo(() => {
    const taken = new Set<BenchSeat>()
    return looks.map((_, i): Stroller => {
      // about a third start on a bench, the rest standing somewhere on the paving
      const seat = i % 3 === 0 ? seats.find((s, k) => !taken.has(s) && hash(i, k, 5) < 0.4) ?? null : null
      if (seat) {
        taken.add(seat)
        return { x: seat.at[0], z: seat.at[1], route: [], heading: seat.heading, phase: 0, mode: 'sitting', wait: rand(3, 14), seat, toSeat: false }
      }
      const [x, z] = cellPos(grid, ...(paved.length ? paved : cells)[Math.floor(hash(i, 6) * (paved.length || cells.length))])
      return { x, z, route: [], heading: hash(i, 7) * Math.PI * 2, phase: 0, mode: 'standing', wait: rand(0.2, 3), seat: null, toSeat: false }
    })
    // only a new crowd starts over: when a building grows the grid changes, and people carry on from where they are
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [looks])
  useEffect(() => resettle(people, grid, seats), [grid, seats, people])

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, MAX_FRAME)
    // benches are told apart by where they are, as the seat list is rebuilt with the grid
    const spot = (s: BenchSeat) => `${s.at}`
    const held = new Set(people.flatMap((p) => (p.seat ? [spot(p.seat)] : [])))
    const moved = people.map(() => 0)
    if (!calm) inSteps(dt, (dt) => people.forEach((p, i) => {
      p.wait -= dt
      if (p.mode === 'sitting' && p.wait <= 0) {
        // get up, step off the bench and carry on
        p.route = [(p.seat as BenchSeat).front]
        p.seat = null
        p.mode = 'walking'
      } else if (p.mode === 'walking') {
        moved[i] += advance(p, SPEED * OFFICE_SCALE * dt)
        if (!p.route.length) {
          if (p.toSeat && p.seat) {
            p.mode = 'sitting'
            p.heading = p.seat.heading
            p.wait = rand(8, 20)
            p.toSeat = false
          } else {
            p.mode = 'standing'
            p.wait = rand(1, 4)
          }
        }
      } else if (p.mode === 'standing' && p.wait <= 0) {
        const free = seats.filter((s) => !held.has(spot(s)))
        const seat = free.length && Math.random() < 0.3 ? pick(free) : null
        const toBench = seat ? seatRoute(grid, [p.x, p.z], seat) : []
        if (seat && toBench.length) {
          held.add(spot(seat))
          p.seat = seat
          p.toSeat = true
          p.route = toBench
        } else {
          // mostly along the paving round the buildings, sometimes out on the grass
          const [x, z] = Math.random() < 0.7 && paved.length ? pick(paved) : pick(cells)
          p.route = route(grid, [p.x, p.z], cellPos(grid, x, z))
        }
        p.mode = 'walking'
      }
    }))
    people.forEach((p, i) => {
      const sitting = p.mode === 'sitting'
      // feet on the paving, or on the grass just below it
      const [cx, cz] = [Math.round((p.x - grid.x0) / grid.step), Math.round((p.z - grid.z0) / grid.step)]
      const ground = town.ground[cz * town.cols + cx] === 'pave' ? 0.08 : 0
      pose(rigs[i], p, sitting, moved[i] / OFFICE_SCALE, sitting ? BENCH_TOP - CHAIR_TOP * OFFICE_SCALE : ground, dt)
    })
  })

  return (
    <>
      {/* figures are built in office units */}
      {looks.map((look, i) => <Figure key={i} look={look} rig={rigs[i]} seed={i * 7 + 3} drop={BENCH_LIFT} scale={OFFICE_SCALE} beach />)}
    </>
  )
}
