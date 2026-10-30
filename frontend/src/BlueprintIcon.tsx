// An employee blueprint drawn as a real blueprint: white paper with a faint grid, the head (as in an
// employee's face icon) in blue line work with light blue fills. The face is generated: hair, eyes, brows,
// nose, mouth and facial hair are picked from the look's `style` (or, without one, from the name), and
// what it wears (glasses, sunglasses, a cap, a beanie, a bow or a headset) comes from its `extra`, so a
// roll of the die draws a new one.

import type { Look } from './core/domain/types'

const LINE = '#2563b8'
const FILL = '#dbe8fb'
const GRID = '#e3ecf8'

/** What the face is drawn with, from a seed. */
export interface Features {
  hair: number
  eyes: number
  brows: number
  mouth: number
  nose: number
  /** 0 none, 1 a moustache, 2 a beard; mostly none. */
  facial: number
}

const HAIRS = 10
const EYES = 7
const BROWS = 5
const MOUTHS = 7
const NOSES = 3
/** Facial hair, weighted: four in six have none. */
const FACIAL = [0, 0, 0, 0, 1, 2]

/** A seed from a name, for blueprints that have no `style`. */
function hashName(name: string) {
  let h = 2166136261
  for (const c of name) h = Math.imul(h ^ c.codePointAt(0)!, 16777619)
  return h >>> 0
}

export function featuresOf(look: Look, name: string): Features {
  // each feature reads its own digits of the seed, so they vary apart from one another
  let s = (look.style ?? hashName(name)) >>> 0
  const take = (n: number) => {
    const v = s % n
    s = Math.floor(s / n)
    return v
  }
  return {
    hair: take(HAIRS), eyes: take(EYES), brows: take(BROWS), mouth: take(MOUTHS),
    nose: take(NOSES), facial: FACIAL[take(FACIAL.length)],
  }
}

export function BlueprintIcon({ look, name, size = 40 }: { look: Look; name: string; size?: number }) {
  const solid = { fill: 'none', stroke: LINE, strokeWidth: 0.9, strokeLinejoin: 'round' as const, strokeLinecap: 'round' as const }
  const f = featuresOf(look, name)
  return (
    <svg className="fx-bp-icon" width={size} height={size} viewBox="0 0 40 40" role="img" aria-label={name}>
      <title>{name}</title>
      <rect width="40" height="40" fill="#fff" />
      {/* the drafting grid */}
      {[5, 10, 15, 20, 25, 30, 35].map((v) => (
        <g key={v} stroke={GRID} strokeWidth="0.4">
          <line x1={v} y1="0" x2={v} y2="40" />
          <line x1="0" y1={v} x2="40" y2={v} />
        </g>
      ))}
      {/* the head, filling the sheet like an employee's face icon */}
      <rect x="9" y="7" width="22" height="26" fill="#fff" stroke={LINE} strokeWidth="0.9" />
      {look.extra === 'cap' ? (
        <path d="M8,13 L8,8 Q8,4 20,4 Q32,4 32,8 L32,13 Z M31,13 L37,13" {...solid} fill={FILL} />
      ) : look.extra === 'beanie' ? (
        <g {...solid} fill={FILL}>
          <path d="M9,11 L9,9 Q9,2.5 20,2.5 Q31,2.5 31,9 L31,11 Z" />
          <rect x="8.5" y="10" width="23" height="3.5" />
          <circle cx="20" cy="2.5" r="1.8" />
        </g>
      ) : (
        <Hair kind={f.hair} line={solid} />
      )}
      {f.facial === 2 && <path d="M9,23 Q10,33 20,33 Q30,33 31,23 L31,33 L9,33 Z" {...solid} fill={FILL} />}
      <Brows kind={f.brows} line={solid} />
      {look.extra === 'sunglasses' ? (
        <g {...solid} fill={LINE}>
          <rect x="11.5" y="16.5" width="7.5" height="5" rx="1" />
          <rect x="21" y="16.5" width="7.5" height="5" rx="1" />
          <line x1="19" y1="18" x2="21" y2="18" />
        </g>
      ) : (
        <Eyes kind={f.eyes} line={solid} />
      )}
      <Nose kind={f.nose} line={solid} />
      {f.facial === 1 && <path d="M16,25.2 Q18,23.6 20,24.6 Q22,23.6 24,25.2 Q20,25.8 16,25.2 Z" {...solid} fill={FILL} />}
      <Mouth kind={f.mouth} line={solid} />
      {look.extra === 'bow' && (
        <g {...solid} fill={FILL}>
          <path d="M28,7 L23.5,3.5 L23.5,10.5 Z" />
          <path d="M28,7 L32.5,3.5 L32.5,10.5 Z" />
          <circle cx="28" cy="7" r="1.4" />
        </g>
      )}
      {look.extra === 'glasses' && (
        <g {...solid}>
          <rect x="11.5" y="15.5" width="7.5" height="7.5" />
          <rect x="21" y="15.5" width="7.5" height="7.5" />
          <line x1="19" y1="19" x2="21" y2="19" />
        </g>
      )}
      {look.extra === 'headset' && (
        <g {...solid}>
          <path d="M7,19 Q7,3 20,3 Q33,3 33,19" />
          <rect x="5.5" y="16" width="3.5" height="7" fill={FILL} />
          <rect x="31" y="16" width="3.5" height="7" fill={FILL} />
          <path d="M8,23 Q9,29 15,29" />
        </g>
      )}
    </svg>
  )
}

type Line = Record<string, string | number>

/** Hair as a filled band across the top of the head: a fringe, a side part, spikes, a bun or a crop. */
function Hair({ kind, line }: { kind: number; line: Line }) {
  const fill = { ...line, fill: FILL }
  switch (kind) {
    case 1: return <path d="M9,15 L9,7 L31,7 L31,11 L21,11 L13,15 Z" {...fill} />
    case 2: return <path d="M9,13 L9,7 L31,7 L31,13 L27.5,10 L24,13 L20,10 L16,13 L12.5,10 Z" {...fill} />
    case 3: return <g {...fill}><circle cx="20" cy="5" r="3" /><path d="M9,12 L9,7 L31,7 L31,12 Z" /></g>
    case 4: return <path d="M9,10 L9,7 L31,7 L31,10 Z" {...fill} />
    // a cloud of curls, wider than the head
    case 5: return <g {...fill}>{[[10, 9, 3.5], [14, 5.5, 4], [20, 4, 4.5], [26, 5.5, 4], [30, 9, 3.5]].map(([cx, cy, r]) => <circle key={cx} cx={cx} cy={cy} r={r} />)}</g>
    // long, down both sides of the face
    case 6: return <path d="M9,31 L9,7 L31,7 L31,31 L28,31 L28,11 L12,11 L12,31 Z" {...fill} />
    // a mohawk: one strip standing up, the sides shaved
    case 7: return <path d="M17,7 L17,1.5 L23,1.5 L23,7 Z" {...fill} />
    // bald, with a shine
    case 8: return <path d="M12,10.5 Q13.5,8.8 16.5,8.8" {...line} />
    // tied back in a tail that swings out to the side
    case 9: return <g {...fill}><path d="M9,12 L9,7 L31,7 L31,12 Z" /><path d="M31,8.5 Q37.5,10 36,21 Q34.5,15 31,13.5 Z" /></g>
    default: return <path d="M9,14 L9,7 L31,7 L31,14 L28,14 L28,11 L12,11 L12,14 Z" {...fill} />
  }
}

/** Square, round, shut or tall eyes. */
function Eyes({ kind, line }: { kind: number; line: Line }) {
  switch (kind) {
    case 1: return <g fill={LINE}><circle cx="15.25" cy="19.25" r="2" /><circle cx="24.75" cy="19.25" r="2" /></g>
    case 2: return <path d="M13.5,19.5 h3.5 M23,19.5 h3.5" {...line} strokeWidth={1.4} />
    case 3: return <g fill={LINE}><rect x="14" y="17" width="2.5" height="4.5" /><rect x="23.5" y="17" width="2.5" height="4.5" /></g>
    // a wink
    case 4: return <g><rect x="13.5" y="17.5" width="3.5" height="3.5" fill={LINE} /><path d="M23,19.8 L24.75,18.2 L26.5,19.8" {...line} /></g>
    // round, with a highlight
    case 5: return <g><circle cx="15.25" cy="19.25" r="2.2" fill={LINE} /><circle cx="24.75" cy="19.25" r="2.2" fill={LINE} /><circle cx="15.9" cy="18.5" r="0.7" fill="#fff" /><circle cx="25.4" cy="18.5" r="0.7" fill="#fff" /></g>
    // smiling shut: two arches
    case 6: return <path d="M13.5,20.5 L15.25,18.2 L17,20.5 M23,20.5 L24.75,18.2 L26.5,20.5" {...line} />
    default: return <g fill={LINE}><rect x="13.5" y="17.5" width="3.5" height="3.5" /><rect x="23" y="17.5" width="3.5" height="3.5" /></g>
  }
}

/** No brows, level ones, or raised ones. */
function Brows({ kind, line }: { kind: number; line: Line }) {
  if (kind === 1) return <path d="M13.5,15.2 h3.5 M23,15.2 h3.5" {...line} />
  if (kind === 2) return <path d="M13.5,15.8 L17,14.6 M23,14.6 L26.5,15.8" {...line} />
  // frowning, down to the middle
  if (kind === 3) return <path d="M13.5,14.6 L17,15.8 M23,15.8 L26.5,14.6" {...line} />
  // thick and bushy
  if (kind === 4) return <g fill={LINE}><rect x="13" y="14.2" width="4.5" height="1.6" /><rect x="22.5" y="14.2" width="4.5" height="1.6" /></g>
  return null
}

/** A straight mouth, a smile, an open one or a crooked one. */
function Mouth({ kind, line }: { kind: number; line: Line }) {
  switch (kind) {
    case 1: return <path d="M16.5,26 Q20,29.5 23.5,26" {...line} />
    case 2: return <rect x="18" y="25.5" width="4" height="3" {...line} fill={FILL} />
    case 3: return <path d="M17,27.6 L23,26.2" {...line} />
    // a grin, teeth showing
    case 4: return <g {...line}><rect x="16" y="25.5" width="8" height="3.2" rx="0.6" fill="#fff" /><line x1="16" y1="27.1" x2="24" y2="27.1" /></g>
    // surprised: a small O
    case 5: return <circle cx="20" cy="27" r="1.5" {...line} fill={FILL} />
    // a cat mouth
    case 6: return <path d="M16.5,26 Q18.25,28.6 20,26 Q21.75,28.6 23.5,26" {...line} />
    default: return <line x1="17" y1="27" x2="23" y2="27" {...line} />
  }
}

/** No nose, a hooked line, or a button. */
function Nose({ kind, line }: { kind: number; line: Line }) {
  if (kind === 1) return <path d="M20.5,20.5 L19.5,23.5 L21,23.5" {...line} />
  if (kind === 2) return <circle cx="20" cy="23" r="0.9" fill={LINE} />
  return null
}
