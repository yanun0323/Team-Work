// A handed file compared with how it was when its step began: numbering, folding long unchanged runs, and pairing
// lines side by side. The lines come from the backend, every line of the file kept.

export type DiffOp = 'same' | 'add' | 'del'
export type DiffLine = { op: DiffOp; text: string }
/** A line with its numbers in the old file and the new one; a deleted line has no new number, an added one no old. */
export type Numbered = DiffLine & { old?: number; new?: number }
/** Lines shown as they are, or an unchanged run folded away until asked for. */
export type Piece = { fold: boolean; lines: Numbered[] }
/** One row of the side-by-side view: the old line on the left, the new one on the right. */
export type Row = { left?: Numbered; right?: Numbered }

/** How many lines were added and removed. */
export function tally(lines: DiffLine[]) {
  let added = 0, removed = 0
  for (const l of lines) {
    if (l.op === 'add') added++
    else if (l.op === 'del') removed++
  }
  return { added, removed }
}

export function numbered(lines: DiffLine[]): Numbered[] {
  let o = 0, n = 0
  return lines.map((l) => l.op === 'add' ? { ...l, new: ++n } : l.op === 'del' ? { ...l, old: ++o } : { ...l, old: ++o, new: ++n })
}

/**
 * Runs of unchanged lines folded, keeping `keep` lines next to each change. A run is folded only when that hides at
 * least `least` lines, as a fold that hides one or two costs more than it saves.
 */
export function folded(lines: Numbered[], keep = 3, least = 4): Piece[] {
  const pieces: Piece[] = []
  const shown = (xs: Numbered[]) => {
    if (!xs.length) return
    const last = pieces[pieces.length - 1]
    if (last && !last.fold) last.lines.push(...xs)
    else pieces.push({ fold: false, lines: [...xs] })
  }
  let i = 0
  while (i < lines.length) {
    if (lines[i].op !== 'same') { shown([lines[i++]]); continue }
    let j = i
    while (j < lines.length && lines[j].op === 'same') j++
    const head = i === 0 ? 0 : keep, tail = j === lines.length ? 0 : keep
    if (j - i - head - tail >= least) {
      shown(lines.slice(i, i + head))
      pieces.push({ fold: true, lines: lines.slice(i + head, j - tail) })
      shown(lines.slice(j - tail, j))
    } else {
      shown(lines.slice(i, j))
    }
    i = j
  }
  return pieces
}

/** Lines side by side: unchanged ones on both sides, each run of deletions beside the additions that follow it. */
export function paired(lines: Numbered[]): Row[] {
  const rows: Row[] = []
  let i = 0
  while (i < lines.length) {
    if (lines[i].op === 'same') { rows.push({ left: lines[i], right: lines[i] }); i++; continue }
    const dels: Numbered[] = [], adds: Numbered[] = []
    while (i < lines.length && lines[i].op === 'del') dels.push(lines[i++])
    while (i < lines.length && lines[i].op === 'add') adds.push(lines[i++])
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push({ left: dels[k], right: adds[k] })
  }
  return rows
}
