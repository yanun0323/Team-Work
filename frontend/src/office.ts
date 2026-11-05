// Floor plan of an opened building: one open-plan floor holding every employee. Pure data, no three.js.
// Office space: origin at the footprint centre, +x and +z are the two walls facing the camera, and
// everything is drawn at `OFFICE_SCALE` into the world.

/** An axis-aligned area on the floor: centre and full size. */
export interface Area {
  x: number
  z: number
  w: number
  d: number
}

export interface OfficePlan {
  /** Inner half-size of the room, wall to wall. */
  half: number
  /** One per employee, in hiring order: where the person sits. Desks sit just behind (towards -z). */
  seats: Array<[number, number]>
  /** What each seat's desk and chair take up. */
  stations: Area[]
  /** In front of the door, kept clear of everything but the doormat. */
  entrance: Area
  /** Beside the entrance; left out when the room is too narrow for it there. */
  reception?: Area
  /** Meeting table, lounge (sofa and coffee table) and bookshelf: left out when the room has no space for them. */
  meeting?: Area
  lounge?: Area
  shelf?: Area
  /**
   * Against the back wall in every room: a counter with a coffee machine (the `NOOK_COUNTER` at its left end,
   * before any mirroring) and a two-seat sofa facing into the room. The strip along the back wall is always
   * free of desks, which start a cell in.
   */
  nook: Area
  /** Open floor to walk to the nook from: in front of it, or beside it when desks stand right in front. */
  nookEntry: [number, number]
  plants: Array<[number, number]>
  /** A water cooler by the reception, beyond its far end, when there is room between it and the corner. */
  cooler?: [number, number]
  /** Laid out right to left: desks on the right, meeting table and lounge on the left. */
  mirror: boolean
}

/** A number in [0, 1) from a seed and a key, the same every time. */
function mix(seed: number, k: number) {
  let h = Math.imul(seed ^ 0x9e3779b9, 16777619) ^ Math.imul(k + 1, 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39)
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296
}

/** Wall thickness, in world units; also used by the drawing code. */
export const WALL = 0.2
/**
 * The office is drawn in its own units, scaled up by this much into the world, so that one workstation
 * (desk, chair and person) fills one ground cell. People come out about 1.5 world units tall.
 */
export const OFFICE_SCALE = 1.5
/** A workstation: desk in front (towards -z), chair and person behind it. Fits inside one cell. */
const STATION_W = 1.3
const STATION_D = 1.1
/** How far the seat is from the station's back edge. */
const SEAT_BACK = 0.35
/**
 * Width kept for the meeting table and lounge along the right wall: the 2.4-wide table, a little room behind it,
 * and a walkway to the desks. Any wider takes a whole column of desks from an 8 × 8 building.
 */
const RIGHT_ZONE = 2.8

/** How far into the room the entrance is kept clear, from the front wall. */
const ENTRANCE_DEPTH = 1.8
/** Clear floor kept either side of the doorway. */
const ENTRANCE_SIDE = 0.6
/** The narrowest reception counter worth drawing. */
const RECEPTION_MIN = 0.9

/** The break nook: counter and sofa side by side along the back wall, and how deep they stand. */
export const NOOK_W = 2.4
export const NOOK_D = 0.65
export const NOOK_COUNTER = 0.8

/** Below this room size (office units, wall to wall) there is no meeting table or lounge on the right. */
const ROOM_FOR_RIGHT = 9.5
/** Below this, no bookshelf on the back wall. */
const ROOM_FOR_SHELF = 7

/** Whole cells for desks, as [first, last] cell index on each axis, and what else the room has space for. */
function zones(footprint: number, cell: number) {
  const size = footprint / OFFICE_SCALE
  const step = cell / OFFICE_SCALE
  const half = size / 2 - WALL / OFFICE_SCALE
  const edge = half - 0.3
  const right = half * 2 >= ROOM_FOR_RIGHT
  const shelf = half * 2 >= ROOM_FOR_SHELF
  // the desk zone: left wall to the right-hand zone (or the right wall), shelf (or back wall) to a walkway
  // in front of the entrance and the reception
  const zx0 = -edge + 0.2
  const zx1 = right ? edge - RIGHT_ZONE : edge - 0.2
  const zz0 = shelf ? -half + 0.8 : -half + 0.3
  const zz1 = half - ENTRANCE_DEPTH - 0.3
  // whole cells inside the zone, by index from the footprint's corner
  const span = (lo: number, hi: number) => [Math.ceil((lo + size / 2) / step), Math.floor((hi + size / 2) / step) - 1]
  const [ix0, ix1] = span(zx0, zx1)
  const [iz0, iz1] = span(zz0, zz1)
  return { size, step, half, edge, right, shelf, ix0, iz0, nx: Math.max(0, ix1 - ix0 + 1), nz: Math.max(0, iz1 - iz0 + 1) }
}

/** Rows of desks that fit in `nz` cells, each with a free cell behind its chairs to walk along. */
const rowsIn = (nz: number) => Math.ceil(nz / 2)

/** How many desks fit in a room this size (one per cell, side by side in rows, a walkway behind each row). */
export function officeCapacity(footprint: number, cell: number) {
  const z = zones(footprint, cell)
  return z.nx * rowsIn(z.nz)
}

/**
 * Zones on one open floor, in office units (world units / `OFFICE_SCALE`), origin at the footprint centre:
 * a block of desks on the left, each on a ground cell of its own, in rows with a free cell behind every
 * row of chairs to walk along (and between neighbours in a row where there is room); the entrance kept
 * clear, with the reception beside it; plants in the corners; a coffee counter and a sofa against the back
 * wall. A room big enough also gets a
 * bookshelf on the back wall, a meeting table in the back-right corner and a lounge in the front-right.
 * `footprint` and `cell` are in world units. People beyond `officeCapacity` get no seat.
 *
 * With a `seed` the room is laid out at random within those rules: how many desks across, where the block
 * sits in its zone, which plants there are, and whether the whole room is mirrored left to right. The same
 * seed always gives the same room.
 */
export function officePlan(people: number, footprint: number, cell: number, seed?: number): OfficePlan {
  const { size, step, half, edge, right, shelf, ix0, iz0, nx, nz } = zones(footprint, cell)
  const rowsMax = rowsIn(nz)
  const seated = Math.min(people, nx * rowsMax)
  const rand = (k: number, fallback: number) => (seed === undefined ? fallback : mix(seed, k))
  let cols: number
  if (seed === undefined || !seated) {
    // as square a block as fits, up to three across when there is room for walkways
    const roomy = Math.min(3, Math.ceil(Math.sqrt(seated * 1.5)))
    cols = Math.max(1, Math.min(nx, 2 * roomy - 1 <= nx && Math.ceil(seated / roomy) <= rowsMax ? roomy : Math.ceil(seated / rowsMax)))
  } else {
    // any number across that still fits every desk
    const least = Math.max(1, Math.ceil(seated / rowsMax))
    const most = Math.max(least, Math.min(nx, seated))
    cols = least + Math.floor(mix(seed, 1) * (most - least + 1))
  }
  const rows = Math.max(1, Math.ceil(seated / cols))
  // a free cell behind every row of chairs; one between desks in a row too, when the zone has room for it
  const gap = 2 * cols - 1 <= nx ? 2 : 1
  const slackX = Math.max(0, nx - (gap * (cols - 1) + 1))
  // the block's place in its zone: centred, or anywhere it fits
  const slackZ = Math.max(0, nz - (2 * (rows - 1) + 1))
  const left = ix0 + Math.floor(rand(2, 0.5) * (slackX + 1) - (seed === undefined ? 0.5 : 0))
  const top = iz0 + Math.floor(rand(3, 0.5) * (slackZ + 1) - (seed === undefined ? 0.5 : 0))
  const centre = (i: number) => (i + 0.5) * step - size / 2
  const seats: Array<[number, number]> = []
  const stations: Area[] = []
  for (let i = 0; i < seated; i++) {
    const r = Math.floor(i / cols)
    // a short last row sits under the middle of the others
    const inRow = Math.min(cols, seated - r * cols)
    const c = (i % cols) + Math.floor((cols - inRow) / 2)
    const x = centre(left + c * gap)
    const z = centre(top + r * 2)
    stations.push({ x, z, w: STATION_W, d: STATION_D })
    seats.push([x, z + STATION_D / 2 - SEAT_BACK])
  }
  // the doorway is two cells wide, in the middle of the front wall
  const doorHalf = step + ENTRANCE_SIDE
  const entrance: Area = { x: 0, z: half - ENTRANCE_DEPTH / 2, w: doorHalf * 2, d: ENTRANCE_DEPTH }
  const apart = (a: Area, b: Area) => Math.abs(a.x - b.x) >= (a.w + b.w) / 2 || Math.abs(a.z - b.z) >= (a.d + b.d) / 2
  // reception just left of the entrance, narrower in a small room, none when it doesn't fit
  const rw = Math.min(2.4, edge - doorHalf - 0.1)
  const reception: Area | undefined = rw >= RECEPTION_MIN ? { x: -doorHalf - rw / 2, z: edge - 0.6, w: rw, d: 0.6 } : undefined
  const meeting: Area | undefined = right ? { x: edge - 1.4, z: -edge + 2.4, w: 2.4, d: 3.6 } : undefined
  const shelfArea: Area | undefined = shelf ? { x: -edge + 2.2, z: -half + 0.25, w: 3.2, d: 0.4 } : undefined
  // the nook ends short of the meeting table, with room for someone to stand between them (desks may stand right
  // in front of it), or short of the back corner's plant
  const nookEnd = meeting ? meeting.x - meeting.w / 2 - 0.85 : edge - 0.6
  const nook: Area = { x: nookEnd - NOOK_W / 2, z: -half + NOOK_D / 2, w: NOOK_W, d: NOOK_D }
  // walk up to it from open floor: in front of it if the desks leave room, else from either end
  const nf = nook.z + NOOK_D / 2
  const candidates: Array<[number, number]> = [
    [nook.x, nf + 0.65], [nookEnd - 0.4, nf + 0.65], [nookEnd - NOOK_W + 0.4, nf + 0.65],
    [nookEnd + 0.45, nf + 0.35], [nookEnd - NOOK_W - 0.45, nf + 0.35],
  ]
  const inTheWay = [...stations, ...(meeting ? [meeting] : []), ...(shelfArea ? [shelfArea] : [])]
  const open = ([x, z]: [number, number]) =>
    Math.abs(x) < half - 0.4 && inTheWay.every((a) => apart(a, { x, z, w: 0.7, d: 0.7 }))
  const nookEntry = candidates.find(open) ?? candidates[0]
  const corners: Array<[number, number]> = [
    [-edge + 0.2, edge - 0.2], [edge - 0.2, edge - 0.2], [-edge + 0.2, -edge + 0.2], [edge - 0.2, -edge + 0.2],
    ...(right ? [[edge - 0.2, 0.2], [-edge + 4.2, -edge + 0.2]] as Array<[number, number]> : []),
  ]
  // each spot for a plant has one about three times in four
  const plants = corners.filter(([x, z], i) => {
    const pot = { x, z, w: 0.5, d: 0.5 }
    return rand(10 + i, 0) < 0.75 && apart(pot, entrance) && (!reception || apart(pot, reception)) && apart(pot, { ...nook, w: nook.w + 0.2 }) && apart(pot, { x: nookEntry[0], z: nookEntry[1], w: 0.7, d: 0.7 })
  })
  const coolerX = -doorHalf - rw - 0.55
  // beyond the reception, clear of the front corner's plant
  const cooler: [number, number] | undefined = reception && coolerX - 0.2 > -edge + 0.95 ? [coolerX, edge - 0.35] : undefined
  // the lounge fills the front-right corner up to the entrance
  const lw = Math.min(3.0, edge - 0.2 - doorHalf)
  const mirror = rand(4, 1) < 0.5
  const flip = (a: Area): Area => (mirror ? { ...a, x: -a.x } : a)
  const flipped = (p: [number, number]): [number, number] => (mirror ? [-p[0], p[1]] : p)
  return {
    half,
    seats: seats.map(flipped),
    stations: stations.map(flip),
    entrance,
    reception: reception && flip(reception),
    meeting: meeting && flip(meeting),
    lounge: right ? flip({ x: edge - 0.1 - lw / 2, z: edge - 1.9, w: lw, d: 2.6 }) : undefined,
    shelf: shelfArea && flip(shelfArea),
    nook: flip(nook),
    nookEntry: flipped(nookEntry),
    plants: plants.map(flipped),
    cooler: cooler && flipped(cooler),
    mirror,
  }
}
