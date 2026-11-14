import type { Look } from '../domain/types'
import { seedOf, shade, styleFor, type Hair, type Style } from '../../figureStyle'

/** What a rectangle of the face is, so each drawing of a face can colour it its own way. */
export type FacePart =
  | 'skin' | 'shine' | 'stubble' | 'hair' | 'curl' | 'mustache' | 'beardLip' | 'eye' | 'mouth' | 'shades'
  | 'cap' | 'beanie' | 'beanieBand' | 'bow' | 'bowKnot' | 'headset'
  | 'tie' | 'straw' | 'strawBand' | 'beret' | 'bandana' | 'headband' | 'clip' | 'flower' | 'flowerMid'

export type FacePixel = [x: number, y: number, w: number, h: number, part: FacePart]

/** Columns of the top row left open by a cut, so its outline shows against the frame; the rest is skin. */
const OPEN_TOP: Partial<Record<Hair, number[]>> = {
  spiky: [0, 3, 6, 9],
  bun: [0, 1, 2, 7, 8, 9],
  mohawk: [0, 1, 2, 3, 6, 7, 8, 9],
  buns: [0, 4, 5, 9],
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
    // a tail down either side, or one, tied near the top
    case 'twintails': return [...top, ...sides(2, 9), [0, 3, 1, 1, 'tie'], [9, 3, 1, 1, 'tie']]
    case 'sidetail': return [...top, [0, 2, 1, 3, 'hair'], [9, 2, 1, 8, 'hair'], [9, 3, 1, 1, 'tie']]
    // long and full, curling out at the ends
    case 'waves': return [...top, ...sides(2, 9), [1, 2, 1, 1, 'hair'], [8, 2, 1, 1, 'hair'], [1, 7, 1, 3, 'hair'], [8, 7, 1, 3, 'hair']]
    case 'buns': return [[1, 0, 3, 1, 'hair'], [6, 0, 3, 1, 'hair'], [0, 1, 10, 1, 'hair'], ...sides(2, 3)]
    // a plait down the person's right (the picture's left), over the shoulder, tied at the end
    case 'braid': return [...top, ...sides(2, 4), [0, 5, 1, 4, 'hair'], [1, 7, 1, 2, 'hair'], [0, 9, 1, 1, 'tie']]
    case 'halfup': return [...top, ...sides(2, 9)]
    case 'curly': return [...top, [0, 2, 2, 1, 'hair'], [4, 2, 2, 1, 'hair'], [8, 2, 2, 1, 'hair'], ...sides(3, 4), [1, 0, 1, 1, 'curl'], [4, 1, 1, 1, 'curl'], [7, 0, 1, 1, 'curl']]
    // swept up at the front, with a lighter wave
    case 'quiff': return [...top, [0, 2, 1, 2, 'hair'], [9, 2, 1, 2, 'hair'], [3, 0, 5, 1, 'curl']]
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
  const hat = extra === 'cap' || extra === 'beanie' || extra === 'strawhat' || extra === 'beret'
  // the top row: open where the cut (or a hat's round crown) shows the frame behind
  const open = extra === 'cap' ? [] : extra === 'beanie' || extra === 'strawhat' ? [0, 9] : extra === 'beret' ? [8, 9] : OPEN_TOP[style.hair] ?? []
  for (let x = 0; x < 10; x++) if (!open.includes(x)) r(x, 0, 1, 1, 'skin')
  r(0, 1, 10, 9, 'skin')
  for (const p of hairOf(style.hair)) if (!(hat && p[1] < 2)) px.push(p)
  r(2, 4, 2, 2, 'eye')
  r(6, 4, 2, 2, 'eye')
  if (style.facial === 'beard') r(0, 7, 10, 3, 'hair')
  if (style.facial === 'stubble') r(1, 8, 8, 2, 'stubble')
  if (style.facial === 'mustache') r(3, 7, 4, 1, 'mustache')
  if (style.facial === 'goatee') r(4, 9, 2, 1, 'mustache')
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
  if (extra === 'strawhat') {
    r(1, 0, 8, 1, 'straw')
    r(0, 1, 10, 1, 'strawBand')
    r(0, 2, 10, 1, 'straw')
  }
  if (extra === 'beret') {
    r(0, 0, 8, 1, 'beret')
    r(0, 1, 10, 1, 'beret')
  }
  if (extra === 'bandana') r(0, 2, 10, 1, 'bandana')
  if (extra === 'headband') r(0, 1, 10, 1, 'headband')
  if (extra === 'hairclip') r(7, 2, 2, 1, 'clip')
  if (extra === 'flower') {
    r(7, 1, 3, 1, 'flower')
    r(8, 0, 1, 3, 'flower')
    r(8, 1, 1, 1, 'flowerMid')
  }
  if (extra === 'headset') {
    r(0, 3, 1, 4, 'headset')
    r(9, 3, 1, 4, 'headset')
    r(0, 0, 10, 1, 'headset')
  }
  return px
}

/** The face drawn by each look, as a picture's address; cleared once it holds this many, as names typed make new ones. */
const faces = new Map<string, string>()
const MOST_FACES = 500

/**
 * The face of `look` as an SVG picture's address, made once for each look. A panel can show hundreds of faces at once
 * (every chat in a long list), and drawn as rectangles each was a couple of dozen elements to build.
 */
export function faceUrl(look: Look, name: string): string {
  const seed = look.style ?? seedOf(name)
  const p = look.parts
  const key = `${seed}|${look.wardrobe}|${look.skin}|${look.hair}|${look.shirt}|${look.extra}|${p ? `${p.hair},${p.facial}` : ''}`
  let url = faces.get(key)
  if (!url) {
    if (faces.size >= MOST_FACES) faces.clear()
    url = `data:image/svg+xml,${encodeURIComponent(faceSvg(look, styleFor(look, seed)))}`
    faces.set(key, url)
  }
  return url
}

/** The face as a stand-alone SVG document. */
function faceSvg(look: Look, st: Style) {
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
    tie: shade(look.hair, 0.7),
    straw: '#e3c27a',
    strawBand: '#c0453a',
    beret: st.accent,
    bandana: st.accent,
    headband: st.accent,
    clip: '#ffcf5a',
    flower: '#f28bb0',
    flowerMid: '#ffcf5a',
  }
  const rects = facePixels(look.extra, st).map(([x, y, w, h, part]) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${colour[part]}"/>`)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" shape-rendering="crispEdges">${rects.join('')}</svg>`
}

/** An employee's face as pixel art, so 2D panels show the same person as the scene. */
export function PixelFace({ look, name, size = 28 }: { look: Look; name: string; size?: number }) {
  // an svg still, so the panels' styles for faces apply as before
  return (
    <svg className="pixel-face" width={size} height={size} viewBox="0 0 10 10" role="img" aria-label={name}>
      <title>{name}</title>
      <image href={faceUrl(look, name)} width="10" height="10" />
    </svg>
  )
}
