// The island's smooth outline, traced from the land cells. Pure math, no three.js.
//
// Land cells → blurred occupancy (rounds every corner, convex and concave) → grass outline at 0.5.
// A signed distance field around that outline places the beach and colours the sea.

import { CELL, type Town } from './layout'

/** Field samples per world unit. */
export const FIELD_RES = 4
/** Sea kept in the field around the land, in world units. */
const MARGIN = 18
/** How far the corners are rounded, in world units. */
const ROUNDING = 0.45 * CELL

export interface Field {
  /** World position of sample (0, 0)'s centre. */
  x0: number
  z0: number
  nx: number
  nz: number
  /** Signed distance to the grass edge in world units: negative on land, positive at sea. */
  sdf: Float32Array
  /** Blurred land occupancy in [0, 1]; 0.5 is the grass edge. */
  land: Float32Array
}

export type Loop = Array<[number, number]>

export function landField(town: Pick<Town, 'cols' | 'rows' | 'ground'>): Field {
  const nx = (town.cols * CELL + MARGIN * 2) * FIELD_RES
  const nz = (town.rows * CELL + MARGIN * 2) * FIELD_RES
  const x0 = (-town.cols * CELL) / 2 - MARGIN + 0.5 / FIELD_RES
  const z0 = (-town.rows * CELL) / 2 - MARGIN + 0.5 / FIELD_RES
  const mask = new Float32Array(nx * nz)
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const cx = Math.floor((x0 + i / FIELD_RES) / CELL + town.cols / 2)
    const cz = Math.floor((z0 + j / FIELD_RES) / CELL + town.rows / 2)
    if (cx >= 0 && cz >= 0 && cx < town.cols && cz < town.rows && town.ground[cz * town.cols + cx]) mask[j * nx + i] = 1
  }
  const land = blur(mask, nx, nz, ROUNDING * FIELD_RES)
  const inside = new Uint8Array(nx * nz)
  for (let k = 0; k < land.length; k++) inside[k] = land[k] >= 0.5 ? 1 : 0
  const toLand = edt(inside, nx, nz, 1)
  const toSea = edt(inside, nx, nz, 0)
  const raw = new Float32Array(nx * nz)
  for (let k = 0; k < raw.length; k++) raw[k] = (inside[k] ? 0.5 - Math.sqrt(toSea[k]) : Math.sqrt(toLand[k]) - 0.5) / FIELD_RES
  // a light blur takes the sample steps out of the outlines traced from the field
  return { x0, z0, nx, nz, land, sdf: blur(raw, nx, nz, 1) }
}

/** Separable Gaussian blur; `sigma` in samples. Edges repeat the border value. */
function blur(src: Float32Array, nx: number, nz: number, sigma: number) {
  const r = Math.ceil(sigma * 3)
  const k: number[] = []
  let sum = 0
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma))
    k.push(v)
    sum += v
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum
  const tmp = new Float32Array(src.length)
  const out = new Float32Array(src.length)
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    let v = 0
    for (let t = -r; t <= r; t++) v += src[j * nx + Math.min(nx - 1, Math.max(0, i + t))] * k[t + r]
    tmp[j * nx + i] = v
  }
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    let v = 0
    for (let t = -r; t <= r; t++) v += tmp[Math.min(nz - 1, Math.max(0, j + t)) * nx + i] * k[t + r]
    out[j * nx + i] = v
  }
  return out
}

/** Squared distance, in samples, from every sample to the nearest one where `cells[k] === target`. */
function edt(cells: Uint8Array, nx: number, nz: number, target: number) {
  const INF = 1e20
  const d = new Float64Array(nx * nz)
  for (let k = 0; k < d.length; k++) d[k] = cells[k] === target ? 0 : INF
  const n = Math.max(nx, nz)
  const f = new Float64Array(n)
  const out = new Float64Array(n)
  const v = new Int32Array(n)
  const z = new Float64Array(n + 1)
  // exact 1-D transform of a sampled function (lower envelope of parabolas), run along rows then columns
  const pass = (len: number) => {
    let k = 0
    v[0] = 0
    z[0] = -INF
    z[1] = INF
    for (let q = 1; q < len; q++) {
      let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
      while (s <= z[k]) {
        k--
        s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
      }
      k++
      v[k] = q
      z[k] = s
      z[k + 1] = INF
    }
    k = 0
    for (let q = 0; q < len; q++) {
      while (z[k + 1] < q) k++
      out[q] = (q - v[k]) ** 2 + f[v[k]]
    }
  }
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) f[i] = d[j * nx + i]
    pass(nx)
    for (let i = 0; i < nx; i++) d[j * nx + i] = out[i]
  }
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < nz; j++) f[j] = d[j * nx + i]
    pass(nz)
    for (let j = 0; j < nz; j++) d[j * nx + i] = out[j]
  }
  return d
}

/**
 * Closed outlines where `values` crosses `iso` (marching squares), in world x/z.
 * Samples where `inside(v)` holds are land. The field border must be outside, so every loop closes.
 */
export function contours(field: Field, values: Float32Array, iso: number, landAbove: boolean): Loop[] {
  const { nx, nz } = field
  const g = (i: number, j: number) => (landAbove ? values[j * nx + i] - iso : iso - values[j * nx + i])
  // edge ids: horizontal edge (i,j)-(i+1,j) = 2*(j*nx+i), vertical (i,j)-(i,j+1) = 2*(j*nx+i)+1
  const H = (i: number, j: number) => 2 * (j * nx + i)
  const V = (i: number, j: number) => 2 * (j * nx + i) + 1
  const links = new Map<number, number[]>()
  const link = (a: number, b: number) => {
    ;(links.get(a) ?? links.set(a, []).get(a) as number[]).push(b)
    ;(links.get(b) ?? links.set(b, []).get(b) as number[]).push(a)
  }
  for (let j = 0; j < nz - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const a = g(i, j) > 0, b = g(i + 1, j) > 0, c = g(i + 1, j + 1) > 0, d = g(i, j + 1) > 0
    const code = (a ? 1 : 0) | (b ? 2 : 0) | (c ? 4 : 0) | (d ? 8 : 0)
    if (code === 0 || code === 15) continue
    const e0 = H(i, j), e1 = V(i + 1, j), e2 = H(i, j + 1), e3 = V(i, j)
    const centre = g(i, j) + g(i + 1, j) + g(i + 1, j + 1) + g(i, j + 1) > 0
    switch (code) {
      case 1: case 14: link(e3, e0); break
      case 2: case 13: link(e0, e1); break
      case 3: case 12: link(e3, e1); break
      case 4: case 11: link(e1, e2); break
      case 6: case 9: link(e0, e2); break
      case 7: case 8: link(e3, e2); break
      case 5: if (centre) { link(e3, e2); link(e0, e1) } else { link(e3, e0); link(e1, e2) } break
      case 10: if (centre) { link(e0, e3); link(e1, e2) } else { link(e0, e1); link(e2, e3) } break
    }
  }
  const point = (e: number): [number, number] => {
    const k = e >> 1
    const i = k % nx
    const j = (k - i) / nx
    const [i2, j2] = e & 1 ? [i, j + 1] : [i + 1, j]
    const ga = g(i, j)
    const t = ga / (ga - g(i2, j2))
    return [field.x0 + (i + (i2 - i) * t) / FIELD_RES, field.z0 + (j + (j2 - j) * t) / FIELD_RES]
  }
  const loops: Loop[] = []
  const seen = new Set<number>()
  for (const start of links.keys()) {
    if (seen.has(start)) continue
    const loop: Loop = []
    let prev = -1
    let cur = start
    while (!seen.has(cur)) {
      seen.add(cur)
      loop.push(point(cur))
      const next = (links.get(cur) as number[]).find((n) => n !== prev && !seen.has(n))
      if (next === undefined) break
      prev = cur
      cur = next
    }
    if (loop.length > 2) loops.push(loop)
  }
  return loops
}

/** Signed area (positive = counter-clockwise in x/z). */
export function area(loop: Loop) {
  let a = 0
  for (let k = 0; k < loop.length; k++) {
    const [x1, z1] = loop[k]
    const [x2, z2] = loop[(k + 1) % loop.length]
    a += x1 * z2 - x2 * z1
  }
  return a / 2
}

/** Field value at a world point (bilinear). */
export function sample(field: Field, values: Float32Array, x: number, z: number) {
  const fi = Math.min(field.nx - 1.001, Math.max(0, (x - field.x0) * FIELD_RES))
  const fj = Math.min(field.nz - 1.001, Math.max(0, (z - field.z0) * FIELD_RES))
  const i = Math.floor(fi), j = Math.floor(fj)
  const u = fi - i, v = fj - j
  const at = (a: number, b: number) => values[b * field.nx + a]
  return (at(i, j) * (1 - u) + at(i + 1, j) * u) * (1 - v) + (at(i, j + 1) * (1 - u) + at(i + 1, j + 1) * u) * v
}
