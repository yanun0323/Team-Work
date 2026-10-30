import type { Look } from '../domain/types'
import { seedOf, shade, styleOf, type Hair } from '../../figureStyle'

type Px = [number, number, number, number, string]

/** Columns of the top row left open by a cut, so its outline shows against the frame; the rest is skin. */
const OPEN_TOP: Partial<Record<Hair, number[]>> = {
  spiky: [0, 3, 6, 9],
  bun: [0, 1, 2, 7, 8, 9],
  mohawk: [0, 1, 2, 3, 6, 7, 8, 9],
}

/** The hair of each cut, from the front, as rectangles on the 10 × 10 head. */
function hairOf(cut: Hair, h: string, skin: string): Px[] {
  const top: Px[] = [[0, 0, 10, 2, h]]
  const sides = (from: number, to: number): Px[] => [[0, from, 1, to - from + 1, h], [9, from, 1, to - from + 1, h]]
  switch (cut) {
    case 'long': return [...top, ...sides(2, 9), [1, 2, 1, 1, h], [8, 2, 1, 1, h]]
    case 'bun': return [[3, 0, 4, 1, h], [0, 1, 10, 1, h], ...sides(2, 3)]
    case 'fringe': return [[0, 0, 10, 3, h], ...sides(3, 4)]
    case 'buzz': return [[0, 0, 10, 1, h], ...sides(1, 1)]
    case 'spiky': return [[1, 0, 2, 1, h], [4, 0, 2, 1, h], [7, 0, 2, 1, h], [0, 1, 10, 1, h], ...sides(2, 3)]
    // the tail falls over one shoulder
    case 'ponytail': return [...top, [0, 2, 1, 3, h], [9, 2, 1, 6, h]]
    case 'bob': return [[0, 0, 10, 3, h], [0, 3, 2, 4, h], [8, 3, 2, 4, h]]
    // a cloud wider than the face, with a few lighter curls
    case 'afro': return [[0, 0, 10, 3, h], ...sides(3, 8), [2, 0, 1, 1, shade(h, 1.35)], [6, 1, 1, 1, shade(h, 1.35)], [4, 2, 1, 1, shade(h, 1.35)]]
    case 'mohawk': return [[4, 0, 2, 2, h]]
    case 'bald': return [[2, 1, 2, 1, shade(skin, 1.08)]]
    case 'side': return [...top, [0, 2, 6, 1, h], ...sides(2, 4)]
    default: return [...top, ...sides(2, 4)]
  }
}

/**
 * The front of an employee's head as pixel art, so 2D panels show the same person as the scene: their
 * cut, facial hair and what they wear on their head come from the same style seed as the 3D figure.
 */
export function PixelFace({ look, name, size = 28 }: { look: Look; name: string; size?: number }) {
  const st = styleOf(look.style ?? seedOf(name))
  const px: Px[] = []
  const r = (x: number, y: number, w: number, h: number, c: string) => px.push([x, y, w, h, c])
  const eye = '#1d1d24'
  const hat = look.extra === 'cap' || look.extra === 'beanie'
  // the top row: open where the cut (or a beanie's round crown) shows the frame behind
  const open = look.extra === 'cap' ? [] : look.extra === 'beanie' ? [0, 9] : OPEN_TOP[st.hair] ?? []
  for (let x = 0; x < 10; x++) if (!open.includes(x)) r(x, 0, 1, 1, look.skin)
  r(0, 1, 10, 9, look.skin)
  for (const p of hairOf(st.hair, look.hair, look.skin)) if (!(hat && p[1] < 2)) px.push(p)
  r(2, 4, 2, 2, eye)
  r(6, 4, 2, 2, eye)
  if (st.facial === 'beard') r(0, 7, 10, 3, look.hair)
  if (st.facial === 'stubble') r(1, 8, 8, 2, shade(look.skin, 0.84))
  if (st.facial === 'mustache' || st.facial === 'beard') r(3, 7, 4, 1, shade(look.hair, st.facial === 'beard' ? 0.8 : 1))
  r(4, 8, 2, 1, '#b8735a')
  if (look.extra === 'glasses') {
    r(1, 3, 8, 1, eye)
    r(1, 4, 1, 2, eye)
    r(8, 4, 1, 2, eye)
    r(4, 4, 2, 1, eye)
  }
  if (look.extra === 'sunglasses') {
    r(1, 4, 3, 2, '#16161c')
    r(6, 4, 3, 2, '#16161c')
    r(4, 4, 2, 1, '#16161c')
  }
  if (look.extra === 'cap') {
    r(0, 0, 10, 2, look.shirt)
    r(2, 2, 8, 1, look.shirt)
  }
  if (look.extra === 'beanie') {
    r(1, 0, 8, 1, st.accent)
    r(0, 1, 10, 1, st.accent)
    r(0, 2, 10, 1, shade(st.accent, 0.82))
  }
  if (look.extra === 'bow') {
    r(5, 0, 5, 2, '#e5484d')
    r(7, 0, 1, 2, '#b8323a')
  }
  if (look.extra === 'headset') {
    r(0, 3, 1, 4, '#2a2a33')
    r(9, 3, 1, 4, '#2a2a33')
    r(0, 0, 10, 1, '#2a2a33')
  }
  return (
    <svg className="pixel-face" width={size} height={size} viewBox="0 0 10 10" shapeRendering="crispEdges" role="img" aria-label={name}>
      <title>{name}</title>
      {px.map(([x, y, w, h, c], i) => <rect key={i} x={x} y={y} width={w} height={h} fill={c} />)}
    </svg>
  )
}
