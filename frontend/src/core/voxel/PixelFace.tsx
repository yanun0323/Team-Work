import type { Look } from '../domain/types'
import { seedOf, shade, styleOf, type Hair, type Style } from '../../figureStyle'

/** What a rectangle of the face is, so each drawing of a face can colour it its own way. */
export type FacePart =
  | 'skin' | 'shine' | 'stubble' | 'hair' | 'curl' | 'mustache' | 'beardLip' | 'eye' | 'mouth' | 'shades'
  | 'cap' | 'beanie' | 'beanieBand' | 'bow' | 'bowKnot' | 'headset'

export type FacePixel = [x: number, y: number, w: number, h: number, part: FacePart]

/** Columns of the top row left open by a cut, so its outline shows against the frame; the rest is skin. */
const OPEN_TOP: Partial<Record<Hair, number[]>> = {
  spiky: [0, 3, 6, 9],
  bun: [0, 1, 2, 7, 8, 9],
  mohawk: [0, 1, 2, 3, 6, 7, 8, 9],
}

/** The hair of each cut, from the front, as rectangles on the 10 × 10 head. */
function hairOf(cut: Hair): FacePixel[] {
  const top: FacePixel[] = [[0, 0, 10, 2, 'hair']]
  const sides = (from: number, to: number): FacePixel[] => [[0, from, 1, to - from + 1, 'hair'], [9, from, 1, to - from + 1, 'hair']]
  switch (cut) {
    case 'long': return [...top, ...sides(2, 9), [1, 2, 1, 1, 'hair'], [8, 2, 1, 1, 'hair']]
    case 'bun': return [[3, 0, 4, 1, 'hair'], [0, 1, 10, 1, 'hair'], ...sides(2, 3)]
    case 'fringe': return [[0, 0, 10, 3, 'hair'], ...sides(3, 4)]
    case 'buzz': return [[0, 0, 10, 1, 'hair'], ...sides(1, 1)]
    case 'spiky': return [[1, 0, 2, 1, 'hair'], [4, 0, 2, 1, 'hair'], [7, 0, 2, 1, 'hair'], [0, 1, 10, 1, 'hair'], ...sides(2, 3)]
    // the tail falls over one shoulder
    case 'ponytail': return [...top, [0, 2, 1, 3, 'hair'], [9, 2, 1, 6, 'hair']]
    case 'bob': return [[0, 0, 10, 3, 'hair'], [0, 3, 2, 4, 'hair'], [8, 3, 2, 4, 'hair']]
    // a cloud wider than the face, with a few lighter curls
    case 'afro': return [[0, 0, 10, 3, 'hair'], ...sides(3, 8), [2, 0, 1, 1, 'curl'], [6, 1, 1, 1, 'curl'], [4, 2, 1, 1, 'curl']]
    case 'mohawk': return [[4, 0, 2, 2, 'hair']]
    case 'bald': return [[2, 1, 2, 1, 'shine']]
    case 'side': return [...top, [0, 2, 6, 1, 'hair'], ...sides(2, 4)]
    default: return [...top, ...sides(2, 4)]
  }
}

/**
 * The front of a head as rectangles on a 10 × 10 grid, painted in order: the person's cut, facial hair and
 * what they wear on their head, from the same style seed as the 3D figure.
 */
export function facePixels(extra: Look['extra'], style: Style): FacePixel[] {
  const px: FacePixel[] = []
  const r = (x: number, y: number, w: number, h: number, part: FacePart) => px.push([x, y, w, h, part])
  const hat = extra === 'cap' || extra === 'beanie'
  // the top row: open where the cut (or a beanie's round crown) shows the frame behind
  const open = extra === 'cap' ? [] : extra === 'beanie' ? [0, 9] : OPEN_TOP[style.hair] ?? []
  for (let x = 0; x < 10; x++) if (!open.includes(x)) r(x, 0, 1, 1, 'skin')
  r(0, 1, 10, 9, 'skin')
  for (const p of hairOf(style.hair)) if (!(hat && p[1] < 2)) px.push(p)
  r(2, 4, 2, 2, 'eye')
  r(6, 4, 2, 2, 'eye')
  if (style.facial === 'beard') r(0, 7, 10, 3, 'hair')
  if (style.facial === 'stubble') r(1, 8, 8, 2, 'stubble')
  if (style.facial === 'mustache') r(3, 7, 4, 1, 'mustache')
  if (style.facial === 'beard') r(3, 7, 4, 1, 'beardLip')
  r(4, 8, 2, 1, 'mouth')
  if (extra === 'glasses') {
    r(1, 3, 8, 1, 'eye')
    r(1, 4, 1, 2, 'eye')
    r(8, 4, 1, 2, 'eye')
    r(4, 4, 2, 1, 'eye')
  }
  if (extra === 'sunglasses') {
    r(1, 4, 3, 2, 'shades')
    r(6, 4, 3, 2, 'shades')
    r(4, 4, 2, 1, 'shades')
  }
  if (extra === 'cap') {
    r(0, 0, 10, 2, 'cap')
    r(2, 2, 8, 1, 'cap')
  }
  if (extra === 'beanie') {
    r(1, 0, 8, 1, 'beanie')
    r(0, 1, 10, 1, 'beanie')
    r(0, 2, 10, 1, 'beanieBand')
  }
  if (extra === 'bow') {
    r(5, 0, 5, 2, 'bow')
    r(7, 0, 1, 2, 'bowKnot')
  }
  if (extra === 'headset') {
    r(0, 3, 1, 4, 'headset')
    r(9, 3, 1, 4, 'headset')
    r(0, 0, 10, 1, 'headset')
  }
  return px
}

/** An employee's face as pixel art, so 2D panels show the same person as the scene. */
export function PixelFace({ look, name, size = 28 }: { look: Look; name: string; size?: number }) {
  const st = styleOf(look.style ?? seedOf(name))
  const colour: Record<FacePart, string> = {
    skin: look.skin,
    shine: shade(look.skin, 1.08),
    stubble: shade(look.skin, 0.84),
    hair: look.hair,
    curl: shade(look.hair, 1.35),
    mustache: look.hair,
    beardLip: shade(look.hair, 0.8),
    eye: '#1d1d24',
    mouth: '#b8735a',
    shades: '#16161c',
    cap: look.shirt,
    beanie: st.accent,
    beanieBand: shade(st.accent, 0.82),
    bow: '#e5484d',
    bowKnot: '#b8323a',
    headset: '#2a2a33',
  }
  return (
    <svg className="pixel-face" width={size} height={size} viewBox="0 0 10 10" shapeRendering="crispEdges" role="img" aria-label={name}>
      <title>{name}</title>
      {facePixels(look.extra, st).map(([x, y, w, h, part], i) => <rect key={i} x={x} y={y} width={w} height={h} fill={colour[part]} />)}
    </svg>
  )
}
