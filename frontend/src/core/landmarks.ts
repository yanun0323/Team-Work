// The public places the island grows by itself as milestones are reached: what the map stands on the island, and the
// simulator's stand-in for the backend's growing them (backend/internal/usecase/landmarks.go).

import { canPlace, dockFace, layoutTown, PLOT_CELLS, STAFFING_SPOT, type LandmarkInput, type Spot } from '../layout'
import { LANDMARK_KINDS, type Landmark, type LandmarkKind, type World } from './domain/types'

/** The milestones that grow each landmark, stage by stage. Keep in step with landmarkSteps in the backend. */
export const STEPS: Record<LandmarkKind, readonly number[]> = {
  // finished tasks: a small park, then medium, then large
  park: [10, 50, 200],
  // days in use: a hill, then a lookout on it
  hill: [7, 30],
  // chats: a fountain, then a lake with a wooden bridge
  pond: [20, 100],
  // companies: a pier, then boats moored at it
  dock: [3, 5],
  // days in use: a clock tower
  clock: [365],
}

/** The finished tasks that grow the park: small, then medium, then large. */
export const PARK_STEPS = STEPS.park

/** A landmark's road, as the profile shows it: the milestones that grow it, and how far the user has got along them. */
export interface LandmarkRoad {
  kind: LandmarkKind
  /** The stage it has reached, 0 before it appears. */
  stage: number
  /** The count its milestones go by now, such as tasks finished. */
  value: number
  /** The counts that grow each stage, in order. */
  steps: number[]
}

const KNOWN = new Set<string>(LANDMARK_KINDS)

/** The landmarks a world has grown, for `layoutTown`, in a steady order; kinds this map does not know are left out. */
export function landmarksOf(w: Pick<World, 'landmarks'>): LandmarkInput[] {
  return Object.values(w.landmarks ?? {})
    .filter((l): l is Landmark => !!l && KNOWN.has(l.kind) && Array.isArray(l.at) && l.at.length === 2 && l.stage > 0)
    .sort((a, b) => LANDMARK_KINDS.indexOf(a.kind) - LANDMARK_KINDS.indexOf(b.kind))
    .map((l) => ({ kind: l.kind, stage: l.stage, at: l.at, ...(typeof l.face === 'number' ? { face: l.face } : {}) }))
}

/** Where the staffing agency stands: where the user moved it, or where it always has. */
export function staffingSpotOf(w: Pick<World, 'places'>): Spot {
  const at = w.places?.staffing?.at
  return Array.isArray(at) && at.length === 2 && at.every(Number.isInteger) ? at : STAFFING_SPOT
}

/** Whole days from `since` to `now`, both in seconds, counting the first day; 0 before any use (daysSince in Profile.tsx). */
const daysBetween = (since: number, now: number) => (since > 0 ? Math.max(1, Math.floor((now - since) / 86400) + 1) : 0)

/** What each road's milestones go by in the simulator's world, as the backend counts them. */
function values(w: World): Record<LandmarkKind, number> {
  // a world made up only in part, as a test's, counts what it has
  const chats = Object.values(w.chats ?? {})
  const tasks = Object.values(w.tasks ?? {})
  const starts = [...tasks.map((t) => t.createdAt), ...chats.flatMap((c) => (c.messages ?? []).map((m) => m.at))].filter((t) => t > 0)
  // the simulator keeps its own clock
  const days = daysBetween(starts.length ? Math.min(...starts) : 0, w.now)
  return {
    park: tasks.filter((t) => t.stage === 'done').length,
    hill: days,
    pond: chats.length,
    dock: Object.keys(w.teams ?? {}).length,
    clock: days,
  }
}

/** The simulator's roads, as the backend's profile has them. */
export function mockLandmarkRoads(w: World): LandmarkRoad[] {
  const now = values(w)
  return LANDMARK_KINDS.map((kind) => ({ kind, stage: w.landmarks?.[kind]?.stage ?? 0, value: now[kind], steps: [...STEPS[kind]] }))
}

/**
 * The simulator grows its landmarks as the backend does: to the stage the milestones have reached, never back down,
 * putting each the first time on the first free plot from the middle out, clear of the companies the map hands
 * places to (the simulator's companies keep none of their own).
 */
export function mockGrowLandmarks(w: World) {
  for (const road of mockLandmarkRoads(w)) {
    const stage = road.steps.filter((n) => road.value >= n).length
    if (stage <= road.stage) continue
    const had = w.landmarks?.[road.kind]
    if (had) {
      had.stage = stage
      continue
    }
    const spot = freeSpot(w, road.kind)
    if (spot) w.landmarks = { ...w.landmarks, [road.kind]: { kind: road.kind, stage, ...spot, createdAt: w.now } }
  }
}

/** Plots this many cells apart keep where the map hands its companies. */
const CLEAR = 2

/** Where a landmark first stands: the first free plot from the middle out; the pier's on the coast, facing open sea. */
function freeSpot(w: World, kind: LandmarkKind): { at: Spot; face?: number } | null {
  const lots = Object.values(w.teams ?? {}).map((t) => ({ id: t.id, name: t.name, members: 0, at: t.plot?.at }))
  const town = layoutTown(lots, false, landmarksOf(w), staffingSpotOf(w))
  const near = (a: Spot, b: Spot) => Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1])) < PLOT_CELLS + CLEAR
  for (let radius = 0; radius <= 28; radius++) {
    for (let z = -radius; z <= radius; z++) for (let x = -radius; x <= radius; x++) {
      if (Math.max(Math.abs(x), Math.abs(z)) !== radius) continue
      const at: Spot = [x * 18 - 8, z * 18 - 8]
      if (town.lots.some((l) => near(l.at, at))) continue
      if (kind !== 'dock') {
        if (canPlace(town, at)) return { at }
        continue
      }
      const face = dockFace(town, at)
      if (face !== null) return { at, face }
    }
  }
  return null
}
