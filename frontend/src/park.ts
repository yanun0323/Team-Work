// The park the island grows by itself as tasks are finished (backend/internal/usecase/landmarks.go): small, then
// medium, then large, from the middle of its ground outward. Its ground, as large as a company's plot, is kept for it
// from the start. What stands where, in cells from the ground's corner; pure data, no three.js.

import type { Prop, Rect } from './layout'

/** The park's ground is this many cells a side: a company's plot. Keep in step with PLOT_CELLS in layout.ts. */
export const PARK_CELLS = 16

/** A tree in the park, on 2 × 2 cells from (x, z). */
export interface ParkTree { x: number; z: number; height: number; variant: number }

/** What a park has standing in it, in its own cells, or (once laid out) in the town's. */
export interface ParkPlan {
  /** Gravel paths, one cell each: a ring round the flower bed, the way in from the front, and a loop round the lawn. */
  walks: Array<[number, number]>
  /** Benches, facing the paths, and lamp posts. */
  props: Prop[]
  /** Flower beds. */
  beds: Rect[]
  /** Picnic blankets, two cells along x: one sits on each cell, facing the other. */
  blankets: Rect[]
  trees: ParkTree[]
  /** The bandstand, at the back of the large park. */
  gazebo: Rect | null
}

/** What each stage adds, in turn: everything up to a park's stage stands in it. */
const STAGES: ParkPlan[] = [
  // small: a flower bed with a gravel ring round it, the way in, two benches, two trees, lamps at the way in, a blanket
  {
    walks: [
      ...square(6, 9).filter(([x, z]) => x === 6 || x === 9 || z === 6 || z === 9),
      ...[7, 8].flatMap((x) => range(10, 15).map((z): [number, number] => [x, z])),
    ],
    props: [
      bench(7, 5, 2, 1, [0, 1]), bench(5, 7, 1, 2, [1, 0]),
      lamp(6, 11), lamp(9, 11),
    ],
    beds: [{ x: 7, z: 7, w: 2, d: 2 }],
    blankets: [{ x: 4, z: 10, w: 2, d: 1 }],
    trees: [{ x: 4, z: 4, height: 2, variant: 0 }, { x: 10, z: 4, height: 3, variant: 1 }],
    gazebo: null,
  },
  // medium: a loop round the lawn, more benches along it, more trees and another blanket
  {
    walks: square(3, 12).filter(([x, z]) => (x === 3 || x === 12 || z === 3 || z === 12) && !(z === 12 && (x === 7 || x === 8))),
    props: [
      bench(10, 7, 1, 2, [-1, 0]),
      bench(7, 2, 2, 1, [0, 1]), bench(2, 7, 1, 2, [1, 0]), bench(13, 7, 1, 2, [-1, 0]),
      lamp(2, 3), lamp(13, 3),
    ],
    beds: [{ x: 4, z: 7, w: 1, d: 2 }, { x: 11, z: 7, w: 1, d: 2 }],
    blankets: [{ x: 9, z: 13, w: 2, d: 1 }],
    trees: [{ x: 10, z: 10, height: 2, variant: 0 }, { x: 4, z: 13, height: 3, variant: 1 }],
    gazebo: null,
  },
  // large: a bandstand at the back, trees and flowers round the edge, two more benches and a third blanket
  {
    walks: [],
    props: [
      bench(4, 2, 2, 1, [0, 1]), bench(10, 2, 2, 1, [0, 1]),
      lamp(2, 13), lamp(13, 13),
    ],
    beds: [{ x: 0, z: 4, w: 1, d: 3 }, { x: 15, z: 4, w: 1, d: 3 }, { x: 13, z: 14, w: 2, d: 1 }],
    blankets: [{ x: 13, z: 10, w: 2, d: 1 }],
    trees: [
      { x: 14, z: 0, height: 3, variant: 2 }, { x: 0, z: 9, height: 2, variant: 0 }, { x: 0, z: 13, height: 4, variant: 1 },
      { x: 14, z: 7, height: 2, variant: 1 }, { x: 10, z: 14, height: 2, variant: 0 },
    ],
    gazebo: { x: 0, z: 0, w: 3, d: 3 },
  },
]

/** How many stages a park has: small, medium and large. */
export const PARK_STAGES = STAGES.length

/** Everything standing in a park at `stage` (1 to `PARK_STAGES`), in its own cells. */
export function parkPlan(stage: number): ParkPlan {
  const upTo = STAGES.slice(0, Math.max(0, Math.min(stage, PARK_STAGES)))
  return {
    walks: upTo.flatMap((s) => s.walks),
    props: upTo.flatMap((s) => s.props),
    beds: upTo.flatMap((s) => s.beds),
    blankets: upTo.flatMap((s) => s.blankets),
    trees: upTo.flatMap((s) => s.trees),
    gazebo: upTo.reduce<Rect | null>((g, s) => s.gazebo ?? g, null),
  }
}

/**
 * The loop someone walking round the park follows, as the corners of its widest gravel ring in its own cells, round
 * the way the clock goes as seen from above: the ring round the flower bed in a small park, the loop round the lawn
 * after that.
 */
export function parkLoop(stage: number): Array<[number, number]> {
  const [a, b] = stage >= 2 ? [3, 12] : [6, 9]
  return [[a, a], [b, a], [b, b], [a, b]]
}

/** The cells in front of the park's way in, just past its ground's front (+z) edge: where the footpath joins it. */
export const PARK_DOOR: [number, number] = [7, PARK_CELLS]

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i)
}

function square(from: number, to: number): Array<[number, number]> {
  return range(from, to).flatMap((z) => range(from, to).map((x): [number, number] => [x, z]))
}

function bench(x: number, z: number, w: number, d: number, face: [number, number]): Prop {
  return { x, z, w, d, kind: 'bench', face }
}

function lamp(x: number, z: number): Prop {
  return { x, z, w: 1, d: 1, kind: 'lamp' }
}
