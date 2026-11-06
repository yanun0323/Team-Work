// Planes in the air right now, so the people on the island can stop and watch them. No three.js.

export interface Aloft {
  x: number
  y: number
  z: number
}

/** Each plane in the air, by which plane it is, in world units: written every frame by the planes, gone once they land or leave. */
export const aloft = new Map<string, Aloft>()

/** Lower than this, in world units, a plane is rolling on the runway rather than flying. */
export const IN_THE_AIR = 1.5
