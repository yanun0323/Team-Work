// Tab and Shift+Tab in a text box: indent or outdent every line the selection touches.

export const INDENT = '    '

export type Edit = { text: string; start: number; end: number }

/** The lines touched by [start, end) get one more indent, or one less with `outdent`; the selection moves with its text. */
export function indentLines(text: string, start: number, end: number, outdent = false): Edit {
  const from = text.lastIndexOf('\n', start - 1) + 1
  // a selection ending right after a line break leaves the next line alone
  const last = end > start && text[end - 1] === '\n' ? end - 1 : end
  const stop = text.indexOf('\n', last)
  const to = stop < 0 ? text.length : stop
  const lines = text.slice(from, to).split('\n')

  // per line: where it started, where it starts now, and how much its start moved
  const moves: { old: number; now: number; shift: number }[] = []
  let old = from
  let now = from
  const out = lines.map((line) => {
    const cut = outdent ? (line.startsWith('\t') ? 1 : line.length - line.replace(new RegExp(`^ {1,${INDENT.length}}`), '').length) : 0
    const next = outdent ? line.slice(cut) : INDENT + line
    moves.push({ old, now, shift: outdent ? -cut : INDENT.length })
    old += line.length + 1
    now += next.length + 1
    return next
  })

  const map = (p: number) => {
    if (p < from) return p
    if (p > to) return p + (now - old)
    const m = moves.findLast((x) => x.old <= p)!
    return m.now + Math.max(0, p - m.old + m.shift)
  }
  return { text: text.slice(0, from) + out.join('\n') + text.slice(to), start: map(start), end: map(end) }
}
