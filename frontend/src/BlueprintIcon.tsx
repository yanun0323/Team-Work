// An employee blueprint drawn as the plan of an employee's face icon: the same head, cut and headwear from
// the same pixel grid, in nothing but blue, white and dashed lines.

import type { Look } from './core/domain/types'
import { facePixels, type FacePart } from './core/voxel/PixelFace'
import { seedOf, styleFor } from './figureStyle'

const PAPER = '#fff'
const INK = '#407bcf'
/** The margin round the head, in cells, so its outer dashes are not cut off. */
const MARGIN = 0.75

/** Small features too narrow to outline: solid blue on the face, and cut out of blue hair in the white behind. */
const FEATURE = new Set<FacePart>(['eye', 'mouth', 'shades', 'shine'])

/** Which shape a part belongs to: dashes run only between different shapes, and hair is solid blue. */
const SHAPE: Partial<Record<FacePart, string>> = {
  curl: 'hair', mustache: 'hair', beardLip: 'hair', tie: 'hair', beanieBand: 'beanie', bowKnot: 'bow', strawBand: 'straw', flowerMid: 'flower',
}

/**
 * The look with its face fixed: one without a `style` (drawn from the name) gets the name's seed as its
 * `style`, so it draws the same face whatever it is later called or shown under.
 */
export function pinLook(look: Look, name: string): Look {
  return look.style === undefined ? { ...look, style: seedOf(name) } : look
}

type Shapes = (string | undefined)[][]

/** The dashed lines of a head: every edge between two shapes, joined into straight runs. Solid hair needs none. */
function outlineOf(shapes: Shapes) {
  const at = (x: number, y: number) => shapes[y]?.[x]
  const edge = (a?: string, b?: string) => a !== b && a !== 'hair' && b !== 'hair'
  let d = ''
  for (let a = 0; a <= 10; a++) {
    let across = -1
    let down = -1
    for (let b = 0; b <= 10; b++) {
      const edgeAcross = b < 10 && edge(at(b, a - 1), at(b, a))
      const edgeDown = b < 10 && edge(at(a - 1, b), at(a, b))
      if (edgeAcross && across < 0) across = b
      if (!edgeAcross && across >= 0) { d += `M${across},${a}H${b}`; across = -1 }
      if (edgeDown && down < 0) down = b
      if (!edgeDown && down >= 0) { d += `M${a},${down}V${b}`; down = -1 }
    }
  }
  return d
}

export function BlueprintIcon({ look, name, size = 40 }: { look: Look; name: string; size?: number }) {
  const pixels = facePixels(look.extra, styleFor(look, look.style ?? seedOf(name)))
  const shapes: Shapes = Array.from({ length: 10 }, () => Array(10).fill(undefined))
  const features = new Set<string>()
  for (const [x, y, w, h, part] of pixels) {
    for (let j = y; j < y + h; j++) {
      for (let i = x; i < x + w; i++) {
        if (FEATURE.has(part)) features.add(`${i},${j}`)
        else shapes[j][i] = SHAPE[part] ?? part
      }
    }
  }
  // a blue feature on the face must not run into blue hair: the hair next to it gives way
  const shows = (x: number, y: number) => features.has(`${x},${y}`) && shapes[y]?.[x] !== 'hair'
  let ink = ''
  shapes.forEach((row, y) => row.forEach((shape, x) => {
    const clear = !shows(x - 1, y) && !shows(x + 1, y) && !shows(x, y - 1) && !shows(x, y + 1)
    if (shape === 'hair' ? !features.has(`${x},${y}`) && clear : features.has(`${x},${y}`)) ink += `M${x},${y}h1v1h-1z`
  }))
  const side = 10 + MARGIN * 2
  // the lines stay at least a pixel wide on the smallest icons
  const stroke = Math.max(1, size / 40) * (side / size)
  return (
    <svg className="fx-bp-icon" width={size} height={size} viewBox={`${-MARGIN} ${-MARGIN} ${side} ${side}`} role="img" aria-label={name}>
      <title>{name}</title>
      <rect x={-MARGIN} y={-MARGIN} width={side} height={side} fill={PAPER} />
      <path d={ink} fill={INK} shapeRendering="crispEdges" />
      <path d={outlineOf(shapes)} fill="none" stroke={INK} strokeWidth={stroke} strokeDasharray={`${stroke * 2} ${stroke * 1.5}`} />
    </svg>
  )
}
