// Time of day: the sun's path, the sky, the sea and the lit windows through a day.

import * as THREE from 'three'

/** real follows the computer's clock; minecraft runs a whole day in 20 minutes; day and night stand still. */
export type Daylight = 'real' | 'minecraft' | 'day' | 'night'

/** A Minecraft day, in milliseconds. */
export const MINECRAFT_DAY = 20 * 60 * 1000

/**
 * Where in its day the town is, 0 to 1: 0 is midnight, 0.5 noon. A Minecraft day is counted from the epoch, so it
 * carries on across reloads; it starts at sunrise, 6 o'clock, as in the game.
 */
export function phaseOf(mode: Daylight, now: Date): number {
  if (mode === 'day') return 0.5
  if (mode === 'night') return 0
  if (mode === 'minecraft') return ((now.getTime() % MINECRAFT_DAY) / MINECRAFT_DAY + 0.25) % 1
  return (now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds() + now.getMilliseconds() / 1000) / 86400
}

/**
 * Night, dawn, day and dusk, as shares of the day. In a Minecraft day that is 10 minutes of day, 1.5 of dusk, 7 of
 * night and 1.5 of dawn; on the clock, day runs 6:00–18:00 and night 19:48–4:12.
 */
const DAWN = 0.175
const DAY = 0.25
const DUSK = 0.75
const NIGHT = 0.825

/** The sun is never lower than this, in degrees: lower, its shadows run off the shadow box and hide the town. */
export const MIN_SUN_ELEVATION = 32
/** At noon the sun is where it always stood before there was time of day: from the back left, fairly high. */
const NOON = { azimuth: 145, elevation: 56.6 }
/** How far round the sun goes from noon to its rising or setting, in degrees. It stays behind the town's left side. */
const SWING = 30
/** At night the light is the moon's, standing still. */
const MOON = { azimuth: 125, elevation: 60 }

interface Look {
  sky: string
  /** The hemisphere light's sky and ground colours, and its strength. */
  above: string
  below: string
  fill: number
  sun: string
  strength: number
  shallow: string
  mid: string
  deep: string
  /** How brightly the lit windows shine, 0 to 1. */
  glow: number
}

const LOOKS: Record<'night' | 'dawn' | 'day' | 'dusk', Look> = {
  night: { sky: '#1d2f57', above: '#a9bdf0', below: '#3d5288', fill: 1.15, sun: '#c4d4ff', strength: 0.75, shallow: '#3d7891', mid: '#2a5785', deep: '#1d3a6b', glow: 1 },
  dawn: { sky: '#8f86b4', above: '#ffd6b8', below: '#7088b8', fill: 1.35, sun: '#ffb889', strength: 1.6, shallow: '#6fd0e6', mid: '#3f92e0', deep: '#3466c4', glow: 0.35 },
  // the light as it was before time of day
  day: { sky: '#3b86c6', above: '#fff4e0', below: '#7fb6d6', fill: 1.5, sun: '#fff6e6', strength: 2.2, shallow: '#86dcd6', mid: '#4fb2dc', deep: '#3b86c6', glow: 0 },
  dusk: { sky: '#8a5f8f', above: '#ffc7a0', below: '#6474a8', fill: 1.3, sun: '#ff9f66', strength: 1.7, shallow: '#6cbede', mid: '#3c7ad6', deep: '#3150b4', glow: 0.6 },
}

/** The looks round the day, by phase; the last wraps to the first. */
const STOPS: [number, Look][] = [
  [DAWN, LOOKS.night], [(DAWN + DAY) / 2, LOOKS.dawn], [DAY, LOOKS.day],
  [DUSK, LOOKS.day], [(DUSK + NIGHT) / 2, LOOKS.dusk], [NIGHT, LOOKS.night],
]

export interface Light {
  sky: THREE.Color
  above: THREE.Color
  below: THREE.Color
  fill: number
  sun: THREE.Color
  strength: number
  /** Unit vector from the town towards the sun, or the moon. */
  toSun: THREE.Vector3
  shallow: THREE.Color
  mid: THREE.Color
  deep: THREE.Color
  glow: number
}

export const newLight = (): Light => ({
  sky: new THREE.Color(), above: new THREE.Color(), below: new THREE.Color(), fill: 0, sun: new THREE.Color(), strength: 0,
  toSun: new THREE.Vector3(), shallow: new THREE.Color(), mid: new THREE.Color(), deep: new THREE.Color(), glow: 0,
})

const ca = new THREE.Color()
const cb = new THREE.Color()
const mix = (out: THREE.Color, a: string, b: string, t: number) => out.copy(ca.set(a)).lerp(cb.set(b), t)

function direction(out: THREE.Vector3, azimuth: number, elevation: number) {
  const az = THREE.MathUtils.degToRad(azimuth)
  const el = THREE.MathUtils.degToRad(elevation)
  return out.set(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az))
}

/** Where the light comes from: the sun along its arc by day, the moon by night, gliding between the two at dawn and dusk. */
function sunAt(out: THREE.Vector3, phase: number) {
  const rise = { azimuth: NOON.azimuth + SWING, elevation: MIN_SUN_ELEVATION }
  const set = { azimuth: NOON.azimuth - SWING, elevation: MIN_SUN_ELEVATION }
  const between = (a: typeof MOON, b: typeof MOON, t: number) =>
    direction(out, a.azimuth + (b.azimuth - a.azimuth) * t, a.elevation + (b.elevation - a.elevation) * t)
  if (phase >= DAY && phase <= DUSK) {
    const s = (phase - DAY) / (DUSK - DAY)
    return direction(out, rise.azimuth - SWING * 2 * s, MIN_SUN_ELEVATION + (NOON.elevation - MIN_SUN_ELEVATION) * Math.sin(Math.PI * s))
  }
  if (phase > DAWN && phase < DAY) return between(MOON, rise, smooth((phase - DAWN) / (DAY - DAWN)))
  if (phase > DUSK && phase < NIGHT) return between(set, MOON, smooth((phase - DUSK) / (NIGHT - DUSK)))
  return direction(out, MOON.azimuth, MOON.elevation)
}

const smooth = (t: number) => t * t * (3 - 2 * t)

/** The light at `phase` (see `phaseOf`), written into `out`. */
export function lightAt(phase: number, out: Light = newLight()): Light {
  const p = ((phase % 1) + 1) % 1
  let i = STOPS.findIndex(([at]) => at > p)
  if (i < 0) i = 0
  const [toAt, to] = STOPS[i]
  const [fromAt, from] = STOPS[(i + STOPS.length - 1) % STOPS.length]
  const span = (toAt - fromAt + 1) % 1 || 1
  const t = smooth(((p - fromAt + 1) % 1) / span)
  for (const k of ['sky', 'above', 'below', 'sun', 'shallow', 'mid', 'deep'] as const) mix(out[k], from[k], to[k], t)
  out.fill = from.fill + (to.fill - from.fill) * t
  out.strength = from.strength + (to.strength - from.strength) * t
  out.glow = from.glow + (to.glow - from.glow) * t
  sunAt(out.toSun, p)
  return out
}

/** The light now, shared by the scene's lights, the sea and the windows; the World's sun updates it each frame. */
export const light = lightAt(0.5)

/** Materials whose lit windows glow in the dark; see `glowMap`. */
export const glowing = new Set<THREE.MeshToonMaterial>()
