import { describe, expect, it } from 'vitest'
import { roadJunctions } from './footpaths'
import { CELL, cellCenter, type Ground } from './layout'
import { footpathBoxes, FOOTPATH_TOP, pathLampBoxes, SIGNAL_TIMES, signalBoxes, signalBulbs, signalLights, type Box } from './streetProps'

/** A town from rows of text: '.' grass, '=' path, '#' a plot's paving. */
function town(rows: string[]) {
  const ground: Array<Ground | null> = rows.join('').split('').map((c) => (c === '=' ? 'path' : c === '#' ? 'pave' : 'grass'))
  const cols = rows[0].length
  return { cols, rows: rows.length, ground, pathLamps: [] as Array<[number, number]>, junctions: roadJunctions(ground, cols, rows.length) }
}

/** Two roads crossing in the middle, each running out to paving at both ends. */
const CROSSROADS = [
  '.....##.....',
  '.....==.....',
  '.....==.....',
  '.....==.....',
  '.....==.....',
  '#==========#',
  '#==========#',
  '.....==.....',
  '.....==.....',
  '.....==.....',
  '.....==.....',
  '.....##.....',
]

const WHITE = '#f2f0e8'
const YELLOW = '#e5b33a'
const top = (b: Box) => b.p[1] + b.s[1] / 2
/** Markings: flat on the tarmac, just above it. */
const markings = (boxes: Box[]) => boxes.filter((b) => top(b) > FOOTPATH_TOP && top(b) < FOOTPATH_TOP + 0.03)
/** The cell a box's middle is over. */
const cellOf = (t: { cols: number; rows: number }, b: Box) => [Math.floor(b.p[0] / CELL + t.cols / 2), Math.floor(b.p[2] / CELL + t.rows / 2)]

describe('footpathBoxes', () => {
  it('gives each path cell its tarmac, and kerbs only along the grass, with a stone in the turn', () => {
    // an L of path two wide, ending against a plot's paving on the right
    const t = town([
      '......',
      '.==###',
      '.==###',
      '.==...',
      '......',
    ])
    const boxes = footpathBoxes(t)
    const slabs = boxes.filter((b) => b.s[0] === CELL && b.s[2] === CELL)
    expect(slabs).toHaveLength(6)
    for (const s of slabs) expect(s.p[1] + s.s[1] / 2).toBeCloseTo(FOOTPATH_TOP)
    // no crosswalk or stop line: the road meets no other, only the yellow middle line
    const marks = markings(boxes)
    expect(marks.every((m) => m.c === YELLOW)).toBe(true)
    const kerbs = boxes.filter((b) => !slabs.includes(b) && !marks.includes(b))
    // kerbs stand above the slabs
    for (const k of kerbs) expect(k.p[1] + k.s[1] / 2).toBeGreaterThan(FOOTPATH_TOP)
    // left side 3, top 2, bottom 2, and right of the bottom-right cell 1; none against the paving
    const long = kerbs.filter((k) => Math.max(k.s[0], k.s[2]) === CELL)
    expect(long).toHaveLength(8)
    const [px] = cellCenter(t, 3, 1)
    for (const k of long) expect(k.p[0]).toBeLessThan(px - CELL / 2)
    // the paving ends above the bottom-right cell's right side: one corner stone where the kerb turns in
    expect(kerbs.length - long.length).toBe(1)
  })

  it('marks a straight road with a dashed yellow middle line on every other cell', () => {
    const t = town([
      '........',
      '#======#',
      '#======#',
      '........',
    ])
    const marks = markings(footpathBoxes(t))
    expect(marks.every((m) => m.c === YELLOW)).toBe(true)
    const [, z1] = cellCenter(t, 0, 1)
    expect(marks.map((d) => [d.p[0], d.p[2]])).toEqual([2, 4, 6].map((x) => [cellCenter(t, x, 1)[0], z1 + CELL / 2]))
    // each runs along the road, shorter than a cell, so there are gaps between
    for (const d of marks) expect(d.s[0]).toBeGreaterThan(d.s[2])
    for (const d of marks) expect(d.s[0]).toBeLessThan(CELL)
  })

  it('crosses every road into a junction with a crosswalk, stops the lane coming in, and keeps the middle line solid to it', () => {
    const t = town(CROSSROADS)
    const marks = markings(footpathBoxes(t))
    const white = marks.filter((m) => m.c === WHITE)
    // five stripes across each of the four roads, lying along it, on the two cells next to the junction
    const stripes = white.filter((m) => Math.min(m.s[0], m.s[2]) > 0.35)
    expect(stripes).toHaveLength(20)
    const crosswalks = ['4,5', '4,6', '7,5', '7,6', '5,4', '6,4', '5,7', '6,7']
    for (const s of stripes) expect(crosswalks).toContain(`${cellOf(t, s)}`)
    for (const s of stripes) expect(s.s[0] > s.s[2]).toBe(['4', '7'].includes(`${cellOf(t, s)[0]}`))
    // a stop line across the lane coming in, on the right as traffic keeps right, one cell out from the crosswalk
    const stops = white.filter((m) => !stripes.includes(m))
    expect(stops.map((m) => `${cellOf(t, m)}`).sort()).toEqual(['3,6', '5,3', '6,8', '8,5'])
    // no middle line over a crosswalk; solid, a whole cell long, beside each stop line; dashed further out
    const yellow = marks.filter((m) => m.c === YELLOW)
    for (const y of yellow) expect(crosswalks).not.toContain(`${cellOf(t, y)}`)
    const solid = yellow.filter((m) => Math.max(m.s[0], m.s[2]) === CELL)
    expect(solid).toHaveLength(4)
    expect(yellow.length).toBeGreaterThan(solid.length)
  })

  it('marks a street three wide across all of it, its middle line halfway, its stop line and light over the side coming in', () => {
    // the street along x, rows 1 to 3, with a road joining from below
    const t = town([
      '............',
      '#==========#',
      '#==========#',
      '#==========#',
      '.....==.....',
      '.....==.....',
      '.....##.....',
    ])
    const marks = markings(footpathBoxes(t))
    const stripes = marks.filter((m) => m.c === WHITE && Math.min(m.s[0], m.s[2]) > 0.35)
    // seven stripes across each arm of the street, five across the road two wide
    const byArm = (x: number) => stripes.filter((m) => cellOf(t, m)[0] === x).length
    expect([byArm(4), byArm(7)]).toEqual([7, 7])
    expect(stripes).toHaveLength(7 + 7 + 5)
    // the middle line runs through the middle of the middle row
    const [, mid] = cellCenter(t, 0, 2)
    const yellow = marks.filter((m) => m.c === YELLOW && m.s[0] > m.s[2])
    expect(yellow.length).toBeGreaterThan(0)
    for (const y of yellow) expect(y.p[2]).toBeCloseTo(mid)
    // in from the west on the south half: the stop line between the middle and the south kerb
    const stop = marks.find((m) => m.c === WHITE && !stripes.includes(m) && m.p[0] < cellCenter(t, 4, 0)[0])
    const [, south] = cellCenter(t, 0, 3)
    expect(stop && stop.p[2] > mid && stop.p[2] < south + CELL / 2).toBe(true)
    // its light hangs over that half too
    const west = t.junctions[0].arms.find((a) => a.dir[0] === -1)
    const head = signalBulbs(t, true).filter((b) => b.way === 0 && b.p[0] < cellCenter(t, 5, 0)[0])
    expect(west?.pole).not.toBeNull()
    for (const b of head) expect(b.p[2]).toBeCloseTo((mid + south + CELL / 2) / 2)
  })

  it('draws a lamp for each one along the paths, unless detail is off', () => {
    const t = town(['...', '.==', '...'])
    t.pathLamps = [[0, 0], [0, 2]]
    const lamps = pathLampBoxes(t, true)
    expect(lamps.filter((b) => b.glow)).toHaveLength(2)
    expect(pathLampBoxes(t, false)).toEqual([])
  })
})

describe('traffic lights', () => {
  it('stand one to each road into a junction, with three lamps facing the traffic coming in; none with less detail', () => {
    const t = town(CROSSROADS)
    expect(signalBoxes(t, true)).toHaveLength(4 * 4)
    const bulbs = signalBulbs(t, true)
    expect(bulbs).toHaveLength(4 * 3)
    for (const a of t.junctions[0].arms) {
      const [lx, lz] = cellCenter(t, ...a.cross[0])
      const mine = bulbs.filter((b) => Math.abs(b.p[0] - lx) < 0.5 && Math.abs(b.p[2] - lz) < 0.5)
      expect(mine.map((b) => b.light)).toEqual([0, 1, 2])
      // red at the top, all on the side the traffic comes from, shown to the way the road runs
      expect(mine[0].p[1]).toBeGreaterThan(mine[2].p[1])
      for (const b of mine) expect((b.p[0] - lx) * a.dir[0] + (b.p[2] - lz) * a.dir[1]).toBeGreaterThan(0)
      for (const b of mine) expect(b.way).toBe(a.dir[0] ? 0 : 1)
    }
    expect(signalBoxes(t, false)).toEqual([])
    expect(signalBulbs(t, false)).toEqual([])
  })

  it('give each way green, then amber, then red, and never let both go at once', () => {
    const period = (SIGNAL_TIMES.green + SIGNAL_TIMES.amber + SIGNAL_TIMES.clear) * 2
    const seen: string[] = []
    for (let t = 0; t < period; t += 0.25) {
      const [x, z] = signalLights(t)
      expect(x === 0 || z === 0).toBe(true)
      const now = `${x}${z}`
      if (seen.at(-1) !== now) seen.push(now)
    }
    // green, amber and both red for the roads along x, then the same for those along z
    expect(seen).toEqual(['20', '10', '00', '02', '01', '00'])
    expect(signalLights(period + 1)).toEqual(signalLights(1))
    expect(signalLights(-1)).toEqual(signalLights(period - 1))
  })
})
