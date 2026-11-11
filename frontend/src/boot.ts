// The startup screen in index.html, and how the camera lands on the island when it lifts: following a plane in
// over the sea (voyagePath.ts). The first run plays the whole landing; later runs a short one. Reduced motion gets a
// plain fade.
// Going to another island, or back, is a flight too (`travel`); with reduced motion, or no scene to fly in, the
// same clouds come in again over the map instead (`coverIsland`) and part once the island arrived has been drawn.

import { tr } from './core/i18n'

const SEEN_KEY = 'team-work-intro-seen'
/** How long the clouds take to part; --leave in public/boot/boot.css matches these. */
const LEAVE_MS = { full: 1200, short: 450 }

export interface Intro {
  kind: keyof typeof LEAVE_MS
  /** The flight's length, once the startup screen starts to clear. */
  seconds: number
  /** Seconds before the plane moves, so it comes in as the clouds open. */
  hold: number
}

export const FULL_INTRO: Intro = { kind: 'full', seconds: 5.5, hold: 0.2 }
export const SHORT_INTRO: Intro = { kind: 'short', seconds: 3.5, hold: 0.1 }

export function introFor(seen: boolean, calm: boolean): Intro | null {
  if (calm) return null
  return seen ? SHORT_INTRO : FULL_INTRO
}

/** A private window or full storage just means the full landing plays again. */
function readSeen(storage: Pick<Storage, 'getItem'>) {
  try { return storage.getItem(SEEN_KEY) !== null } catch { return false }
}

function markSeen(storage: Pick<Storage, 'setItem'>) {
  try { storage.setItem(SEEN_KEY, '1') } catch { /* see readSeen */ }
}

/** Decides this launch's landing and remembers that one has played. */
export function nextIntro(storage: Pick<Storage, 'getItem' | 'setItem'>, calm: boolean) {
  const intro = introFor(readSeen(storage), calm)
  markSeen(storage)
  return intro
}

/** Clears the startup screen. Calling it again does nothing. */
export function revealBoot(kind: Intro['kind'] = 'short') {
  const boot = document.getElementById('boot')
  if (!boot || boot.dataset.leaving) return
  boot.dataset.leaving = kind
  setTimeout(() => boot.remove(), LEAVE_MS[kind])
}

/** Input during the landing: the clouds go at once, with the camera. */
export function skipBoot() {
  const boot = document.getElementById('boot')
  if (boot?.dataset.leaving) boot.remove()
}

/** How long the clouds take to close over the map; --cover in public/boot/boot.css matches these. */
export const COVER_MS = { motion: 600, calm: 200 }

const CLOUDS = 21

/**
 * The startup screen again, as in index.html, its name saying what it waits for; and a plane flying across over
 * the clouds while it waits (boot.css, `.boot-plane`).
 */
function bootScreen() {
  const boot = document.createElement('div')
  boot.id = 'boot'
  boot.setAttribute('role', 'status')
  for (let i = 1; i <= CLOUDS; i++) boot.appendChild(document.createElement('i')).className = `c${i}`
  const plane = boot.appendChild(document.createElement('img'))
  plane.className = 'boot-plane'
  plane.src = '/boot/plane.svg'
  plane.alt = ''
  const mark = boot.appendChild(document.createElement('div'))
  mark.className = 'boot-mark'
  const word = mark.appendChild(document.createElement('img'))
  word.className = 'boot-word'
  word.src = '/boot/wordmark.svg'
  word.alt = ''
  const name = mark.appendChild(document.createElement('span'))
  name.className = 'boot-name'
  name.textContent = tr('載入中…')
  return boot
}

/**
 * Closes the clouds over the map, then calls `then`, which changes the island under them. They stay until the
 * camera lands on the island arrived (`revealBoot`). Already covered, `then` runs at once; with no page (tests) too.
 */
export function coverIsland(then: () => void) {
  if (typeof document === 'undefined') return then()
  const cur = document.getElementById('boot')
  if (cur && !cur.dataset.leaving && !cur.dataset.covering) return then()
  if (cur?.dataset.covering) return void cur.addEventListener('covered', then, { once: true })
  cur?.remove()
  const boot = bootScreen()
  boot.dataset.covering = '1'
  document.body.appendChild(boot)
  const calm = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  setTimeout(() => {
    delete boot.dataset.covering
    then()
    boot.dispatchEvent(new Event('covered'))
  }, calm ? COVER_MS.calm : COVER_MS.motion)
}

/**
 * Flies to another island: calls `swap`, which changes the island, once this one is out of sight. `home`: back to
 * the player's own, the other way.
 */
type Pilot = (swap: () => void, home: boolean) => void
let pilot: Pilot | null = null

/** The scene that flies between islands; null when it goes. */
export function setPilot(p: Pilot | null) {
  pilot = p
}

/**
 * Goes to another island, or back `home`: a flight from this island's airport when the scene can show one, otherwise
 * (reduced motion, no scene) the clouds close over the map (`coverIsland`). `swap` changes the island, unseen.
 */
export function travel(swap: () => void, home = false) {
  const calm = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  if (pilot && !calm) pilot(swap, home)
  else coverIsland(swap)
}

/** Stops the waiting motion while the backend can't be reached. */
export function holdBoot(held: boolean) {
  document.getElementById('boot')?.toggleAttribute('data-held', held)
}
