// Street furniture on a building's paved plot: lamp posts, planters and benches, as plain boxes in town space.
// The map draws them; a building's hover shade and pointer area use the same boxes.

import { CELL, hash, rectCenter, type Lot, type Town } from './layout'

/** `glow`: a lamp's lantern, lit after dark. */
export interface Box { p: [number, number, number]; s: [number, number, number]; c: string; glow?: boolean }

/** The light a lit lantern gives off. */
export const LANTERN = '#ffd98a'

const WOOD_SEAT = '#a8774e'
const WOOD_LIGHT = '#bb8a5c'

/** One plot's lamps, planters and benches; less detail drops the lamps and the flowers. */
export function propBoxes(town: Town, lot: Lot, detail: boolean): Box[] {
  const out: Box[] = []
  for (const pr of lot.props) {
    const [x, z] = rectCenter(town, pr)
    if (pr.kind === 'bench') {
      // a wooden seat at knee height on two iron legs, with a backrest on the building side
      const [fx, fz] = pr.face ?? [0, 1]
      const long = (Math.max(pr.w, pr.d) - 0.3) * CELL
      const size = (a: number, b: number, h: number): [number, number, number] => (fx ? [b, h, a] : [a, h, b])
      const off = (t: number, y: number, back: number): [number, number, number] => [x + (fx ? -fx * back : t), y, z + (fz ? -fz * back : t)]
      for (const t of [-1, 1]) {
        out.push({ p: off((t * long) / 2.6, 0.24, 0), s: size(0.14, 0.7, 0.48), c: '#3c4253' })
        out.push({ p: off((t * long) / 2.6, 0.75, 0.32), s: size(0.12, 0.1, 1.0), c: '#3c4253' })
      }
      for (const k of [-0.18, 0.18]) out.push({ p: off(0, 0.52, k), s: size(long, 0.32, 0.08), c: k < 0 ? WOOD_LIGHT : WOOD_SEAT })
      for (const y of [0.85, 1.12]) out.push({ p: off(0, y, 0.36), s: size(long, 0.07, 0.18), c: WOOD_SEAT })
      continue
    }
    if (pr.kind === 'lamp') {
      if (!detail) continue
      // a post 1.75 cells tall with a lantern on top
      const top = 1.75 * CELL
      out.push({ p: [x, 0.2, z], s: [0.5, 0.24, 0.5], c: '#3c4253' })
      out.push({ p: [x, top / 2, z], s: [0.16, top, 0.16], c: '#3c4253' })
      out.push({ p: [x, top + 0.2, z], s: [0.46, 0.4, 0.46], c: '#ffe7a3', glow: true })
      out.push({ p: [x, top + 0.45, z], s: [0.56, 0.1, 0.56], c: '#3c4253' })
      continue
    }
    // a stone trough a little inside its cells, soil, and a hedge with a few flowers
    const w = pr.w * CELL - 0.4
    const d = pr.d * CELL - 0.4
    out.push({ p: [x, 0.38, z], s: [w, 0.6, d], c: '#b9b1a3' })
    out.push({ p: [x, 0.69, z], s: [w - 0.24, 0.02, d - 0.24], c: '#6b4a33' })
    const along = pr.w > pr.d ? 'x' : 'z'
    const n = Math.max(pr.w, pr.d)
    for (let k = 0; k < n; k++) {
      const t = (k - (n - 1) / 2) * CELL
      const [bx, bz] = along === 'x' ? [x + t, z] : [x, z + t]
      out.push({ p: [bx, 1.0, bz], s: [CELL - 0.6, 0.6, CELL - 0.6], c: k % 2 ? '#4fa848' : '#62b955' })
      const f = hash(bx, bz, 4)
      if (detail && f < 0.7) out.push({ p: [bx + (f - 0.35) * 0.8, 1.36, bz - (f - 0.35) * 0.6], s: [0.22, 0.14, 0.22], c: ['#ff8a5c', '#ffd34a', '#f0f0f8', '#e56a9a'][Math.floor(f * 5.7)] })
    }
  }
  return out
}
