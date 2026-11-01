// The startup screen in index.html, and how the camera lands on the island when it lifts.
// The first run plays the whole landing; later runs a short one. Reduced motion gets a plain fade.

const SEEN_KEY = 'team-work-intro-seen'
/** How long the clouds take to part; --leave in public/boot/boot.css matches these. */
const LEAVE_MS = { full: 1200, short: 450 }

export interface Intro {
  kind: keyof typeof LEAVE_MS
  /** The flight's length, once the startup screen starts to clear. */
  seconds: number
  /** The first zoom, as a share of the island's. */
  zoomFrom: number
  /** Seconds before the camera moves, so it comes in as the clouds open. */
  hold: number
}

export const FULL_INTRO: Intro = { kind: 'full', seconds: 1.3, zoomFrom: 0.45, hold: 0.1 }
export const SHORT_INTRO: Intro = { kind: 'short', seconds: 0.5, zoomFrom: 0.85, hold: 0.05 }

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

/** Stops the waiting motion while the backend can't be reached. */
export function holdBoot(held: boolean) {
  document.getElementById('boot')?.toggleAttribute('data-held', held)
}
