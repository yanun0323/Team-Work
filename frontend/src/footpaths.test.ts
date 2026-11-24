import { describe, expect, it } from 'vitest'
import { ALONG_X, LAMP_GAP, lampsAlong, layFootpaths, NODE, RING_ROAD, roadCells, roadJunctions } from './footpaths'
import { layoutTown, PLOT_CELLS, type Ground, type Spot, type Town } from './layout'

const teams = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `t${i}`, name: `T${i}`, members: 3 }))
const at = (t: Town, x: number, z: number) => (x < 0 || z < 0 || x >= t.cols || z >= t.rows ? null : t.ground[z * t.cols + x])

/** Path cells reached from a cell through path cells, by their four sides. */
function along(t: Pick<Town, 'cols' | 'rows' | 'ground'>, x0: number, z0: number) {
  const seen = new Set<number>()
  const stack = [[x0, z0]]
  while (stack.length) {
    const [x, z] = stack.pop() as number[]
    const k = z * t.cols + x
    if (x < 0 || z < 0 || x >= t.cols || z >= t.rows || seen.has(k) || t.ground[k] !== 'path') continue
    seen.add(k)
    stack.push([x + 1, z], [x - 1, z], [x, z + 1], [x, z - 1])
  }
  return seen
}

describe('footpaths', () => {
  for (const n of [1, 4, 9]) {
    it(`join each of ${n} companies' doors to the staffing agency's, two cells wide`, () => {
      const t = layoutTown(teams(n))
      const s = t.staffing
      const hub = along(t, s.x + s.w / 2 - 1, s.z + s.d)
      expect(hub.size).toBeGreaterThan(0)
      for (const l of t.lots) {
        const x = l.plot.x + PLOT_CELLS / 2 - 1
        const z = l.plot.z + PLOT_CELLS
        expect([at(t, x, z), at(t, x + 1, z)], l.id).toEqual(['path', 'path'])
        expect(hub.has(z * t.cols + x), l.id).toBe(true)
      }
      // every path cell is all there is: one network, and each cell part of a 2 × 2 square of path
      const all = t.ground.flatMap((g, k) => (g === 'path' ? [k] : []))
      expect(all.length).toBe(hub.size)
      const isPath = (x: number, z: number) => at(t, x, z) === 'path'
      for (const k of all) {
        const x = k % t.cols
        const z = (k - x) / t.cols
        const wide = [[0, 0], [-1, 0], [0, -1], [-1, -1]].some(([dx, dz]) => isPath(x + dx, z + dz) && isPath(x + dx + 1, z + dz) && isPath(x + dx, z + dz + 1) && isPath(x + dx + 1, z + dz + 1))
        expect(wide, `${x},${z}`).toBe(true)
      }
    })
  }

  it('have lamps along them, on grass right beside a path, apart, and clear of the plots and the trees', () => {
    const t = layoutTown(teams(6))
    expect(t.pathLamps.length).toBeGreaterThan(3)
    const trees = new Set(t.trees.flatMap((tr) => [0, 1].flatMap((dz) => [0, 1].map((dx) => `${tr.x + dx},${tr.z + dz}`))))
    for (const [x, z] of t.pathLamps) {
      expect(at(t, x, z)).toBe('grass')
      expect([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => at(t, x + dx, z + dz) === 'path'), `${x},${z}`).toBe(true)
      expect(trees.has(`${x},${z}`), `${x},${z}`).toBe(false)
      for (const r of [...t.lots.map((l) => l.plot), t.airport, t.staffing]) {
        expect(x >= r.x - 1 && x <= r.x + r.w && z >= r.z - 1 && z <= r.z + r.d, `${x},${z}`).toBe(false)
      }
    }
    for (const [i, a] of t.pathLamps.entries()) for (const b of t.pathLamps.slice(i + 1)) {
      expect(Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]))).toBeGreaterThanOrEqual(LAMP_GAP)
    }
    expect(layoutTown(teams(6), false).pathLamps).toEqual([])
  })

  it('puts a lamp beside a straight path every LAMP_GAP cells, one side only, never on the shore', () => {
    // a path two cells wide down the middle of a strip of grass, shore on the left edge
    const cols = 6
    const rows = 20
    const ground: Array<Ground | null> = Array.from({ length: cols * rows }, (_, k) => (k % cols === 0 ? 'shore' : k % cols === 2 || k % cols === 3 ? 'path' : 'grass'))
    const lamps = lampsAlong(ground, cols, rows, () => false)
    expect(lamps).toEqual([[1, 0], [1, 7], [1, 14]])
    expect(lampsAlong(ground, cols, rows, (_, z) => z < 5)).toEqual([[1, 5], [1, 12], [1, 19]])
  })

  it('have traffic lights where they meet, by the road, clear of the trees, the lamps and the staffing agency', () => {
    const t = layoutTown(teams(14))
    expect(t.junctions.length).toBeGreaterThan(2)
    const trees = new Set(t.trees.flatMap((tr) => [0, 1].flatMap((dz) => [0, 1].map((dx) => `${tr.x + dx},${tr.z + dz}`))))
    const lamps = new Set(t.pathLamps.map((l) => `${l}`))
    const poles = t.junctions.flatMap((j) => j.arms.flatMap((a) => (a.pole ? [a.pole] : [])))
    expect(poles.length).toBeGreaterThan(t.junctions.length * 2)
    expect(new Set(poles.map((p) => `${p}`)).size).toBe(poles.length)
    const s = t.staffing
    for (const [x, z] of poles) {
      expect(['grass', 'pave']).toContain(at(t, x, z))
      expect(trees.has(`${x},${z}`) || lamps.has(`${x},${z}`), `${x},${z}`).toBe(false)
      expect(x >= s.x && x < s.x + s.w && z >= s.z && z < s.z + s.d, `${x},${z}`).toBe(false)
    }
    for (const j of t.junctions) expect(j.arms.length).toBeGreaterThanOrEqual(3)
    expect(layoutTown(teams(14), false).junctions).toEqual([])
  })

  for (const n of [1, 4, 9]) {
    it(`ring each of ${n} companies' plots with road all the way round`, () => {
      const t = layoutTown(teams(n))
      for (const l of t.lots) {
        const p = l.plot
        for (let z = p.z - RING_ROAD; z < p.z + p.d + RING_ROAD; z++) for (let x = p.x - RING_ROAD; x < p.x + p.w + RING_ROAD; x++) {
          const onPlot = x >= p.x && x < p.x + p.w && z >= p.z && z < p.z + p.d
          if (!onPlot) expect(['path', 'pave'], `${l.id} at ${x},${z}`).toContain(at(t, x, z))
        }
      }
    })
  }

  it('make one street between two plots standing a little apart, as wide as the gap, and two roads further apart', () => {
    for (const gap of [1, 2, 3, 4, 5, 6]) {
      const t = layoutTown([
        { id: 'a', name: 'A', members: 3, at: [0, 0] as Spot },
        { id: 'b', name: 'B', members: 3, at: [PLOT_CELLS + gap, 0] as Spot },
      ])
      const [a] = t.lots
      const z = a.plot.z + PLOT_CELLS / 2
      const between = Array.from({ length: gap }, (_, i) => at(t, a.plot.x + PLOT_CELLS + i, z))
      expect(between, `gap ${gap}`).toEqual(gap <= 5 ? Array(gap).fill('path') : ['path', 'path', 'grass', 'grass', 'path', 'path'])
    }
  })

  it('lays none without companies, and none when only the bare land is asked for', () => {
    expect(layoutTown([]).ground).not.toContain('path')
    expect(layoutTown(teams(4), false).ground).not.toContain('path')
  })

  it('meet at a crossroads, each road with its crosswalk, the lane coming in, its stop line and its light', () => {
    const rows = [
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
    const ground: Array<Ground | null> = rows.join('').split('').map((c) => (c === '=' ? 'path' : c === '#' ? 'pave' : 'grass'))
    const junctions = roadJunctions(ground, 12, 12)
    expect(junctions).toHaveLength(1)
    // traffic keeps right: coming in from the west on the south lane, from the north on the west lane, and so on
    expect(junctions[0].arms.sort((a, b) => `${a.dir}`.localeCompare(`${b.dir}`))).toEqual([
      { dir: [-1, 0], cross: [[4, 6], [4, 5]], stop: [3, 6], pole: [4, 7] },
      { dir: [0, -1], cross: [[5, 4], [6, 4]], stop: [5, 3], pole: [4, 4] },
      { dir: [0, 1], cross: [[6, 7], [5, 7]], stop: [6, 8], pole: [7, 7] },
      { dir: [1, 0], cross: [[7, 5], [7, 6]], stop: [8, 5], pole: [7, 4] },
    ])
  })

  it('take a street three wide for one, and where a road joins it from the side for a junction', () => {
    const rows = [
      '..........',
      '#========#',
      '#========#',
      '#========#',
      '....==....',
      '....==....',
      '....##....',
    ]
    const ground: Array<Ground | null> = rows.join('').split('').map((c) => (c === '=' ? 'path' : c === '#' ? 'pave' : 'grass'))
    const { kind, side, wide } = roadCells(ground, 10, 7)
    // the street, three wide, from row 1
    for (const x of [1, 2, 7, 8]) for (const z of [1, 2, 3]) expect([kind[z * 10 + x], side[z * 10 + x], wide[z * 10 + x]], `${x},${z}`).toEqual([ALONG_X, 1, 3])
    // where the road from below joins it, though no wider than five, is no short stretch of a street five wide
    for (const x of [4, 5]) for (const z of [1, 2, 3]) expect(kind[z * 10 + x], `${x},${z}`).toBe(NODE)
    const [j] = roadJunctions(ground, 10, 7)
    const west = j.arms.find((a) => a.dir[0] === -1)
    // traffic heading in keeps right: in from the west along the south edge
    expect(west?.cross).toEqual([[3, 3], [3, 2], [3, 1]])
    expect(west?.pole).toEqual([3, 4])
    expect(j.arms.map((a) => a.cross.length).sort()).toEqual([2, 3, 3])
  })

  it('take a road run a cell past a turn for its corner, unless a door is on it', () => {
    const rows = [
      '..........',
      '#=====....',
      '#=====....',
      '...==.....',
      '...==.....',
      '...##.....',
    ]
    const ground: Array<Ground | null> = rows.join('').split('').map((c) => (c === '=' ? 'path' : c === '#' ? 'pave' : 'grass'))
    expect(roadJunctions(ground, 10, 6)).toEqual([])
    // a plot's paving beside that last cell: a road to its door, too short for a stop line; the pole on the paving
    ground[5] = 'pave'
    const [j] = roadJunctions(ground, 10, 6)
    expect(j.arms.find((a) => a.dir[0] === 1)).toEqual({ dir: [1, 0], cross: [[5, 1], [5, 2]], stop: null, pole: [5, 0] })
    // two cells out to paving leaves room for one, one cell before it
    expect(j.arms.find((a) => a.dir[0] === -1)?.stop).toEqual([1, 2])
  })

  it('go round what is not grass, and leave a walled-off door out', () => {
    // '.' grass, '#' paving; the hub is top left, door A below the wall, door B shut in on the right
    const rows = [
      '..........##..',
      '..........##..',
      '######..####..',
      '######..####..',
      '..........##..',
      '..........##..',
    ]
    const cols = rows[0].length
    const ground: Array<Ground | null> = rows.join('').split('').map((c) => (c === '.' ? 'grass' : 'pave'))
    const doors: Spot[] = [[0, 4], [12, 0]]
    layFootpaths(ground, cols, rows.length, [0, 0], doors)
    const t = { cols, rows: rows.length, ground }
    const net = along(t, 0, 0)
    expect(net.has(4 * cols + 0)).toBe(true)
    // nothing laid over the paving
    rows.join('').split('').forEach((c, k) => c === '#' && expect(ground[k]).toBe('pave'))
    // the gap at x 6..7 is the only way down; door B gets nothing
    expect([ground[2 * cols + 6], ground[3 * cols + 7]]).toEqual(['path', 'path'])
    expect(ground[12]).toBe('grass')
  })
})
