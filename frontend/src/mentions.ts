// What the word at the cursor of a message box is asking for: "$" a skill, "#" a file or folder, "@" an employee.
// Each counts at the start of any word. A quoted "#" may hold spaces, as a path can.

import type { FileInfo, SkillInfo } from './core/domain/types'

export interface Mention {
  kind: '$' | '#' | '@'
  start: number
  /** The word as typed so far, with its sign. */
  token: string
  query: string
}

export interface MentionChoice {
  key: string
  name: string
  hint: string
  /** What replaces the word when picked. */
  text: string
  /** A file or folder's, for its icon and to show it faint when git ignores it. */
  file?: { dir: boolean; ignored?: boolean }
}

const isSpace = (c: string) => /\s/.test(c)

function openQuoteStart(before: string) {
  for (let i = 0; i + 1 < before.length; i++) {
    if (before[i] !== '#' || before[i + 1] !== '"' || (i > 0 && !isSpace(before[i - 1]))) continue
    let j = i + 2
    while (j < before.length && before[j] !== '"' && before[j] !== '\n') j += before[j] === '\\' ? 2 : 1
    if (j >= before.length) return i
    i = j
  }
  return -1
}

export function mentionAt(text: string, cursor: number): Mention | null {
  const before = text.slice(0, cursor)
  let start = openQuoteStart(before)
  if (start < 0) {
    start = before.length
    while (start > 0 && !isSpace(before[start - 1])) start--
  }
  const token = before.slice(start)
  if (token[0] === '$') return { kind: '$', start, token, query: token.slice(1) }
  if (token[0] === '#') return { kind: '#', start, token, query: fileQuery(token.slice(1)) }
  if (token[0] === '@') return { kind: '@', start, token, query: token.slice(1) }
  return null
}

function fileQuery(typed: string) {
  if (!typed.startsWith('"')) return typed
  try { return JSON.parse(`${typed}"`) as string } catch { return typed.slice(1) }
}

/** Names that start with the query, then names that hold it, then descriptions that do. */
export function skillChoices(query: string, skills: SkillInfo[]): MentionChoice[] {
  const q = query.toLowerCase()
  const score = (s: SkillInfo) => {
    const name = s.name.toLowerCase()
    if (name.startsWith(q)) return 0
    if (name.includes(q)) return 1
    return q && s.description.toLowerCase().includes(q) ? 2 : 3
  }
  return skills
    .map((s) => ({ s, at: score(s) }))
    .filter((x) => x.at < 3)
    .sort((a, b) => a.at - b.at)
    .map(({ s }) => ({ key: s.name, name: s.name, hint: s.description, text: `$${s.name} ` }))
}

export interface Person { id: string; name: string; hint?: string }

/** Employees whose names start with the query, then those whose names hold it. */
export function personChoices(query: string, people: Person[]): MentionChoice[] {
  const q = query.toLowerCase()
  const score = (p: Person) => (p.name.toLowerCase().startsWith(q) ? 0 : p.name.toLowerCase().includes(q) ? 1 : 2)
  return people
    .map((p) => ({ p, at: score(p) }))
    .filter((x) => x.at < 2)
    .sort((a, b) => a.at - b.at)
    .map(({ p }) => ({ key: p.id, name: p.name, hint: p.hint ?? '', text: `@${p.name} ` }))
}

/**
 * Who a message mentions with "@", in the order they come. A name counts unless a Latin word runs into it on either
 * side, as in an email address (Chinese runs on with no space), and the longest first, so "@Ada Lovelace" is not also "@Ada".
 */
export function mentionedPeople(text: string, people: Person[]): string[] {
  return [...new Set(peopleAt(text, people).map((x) => x.id))]
}

/** Where each "@name" of people is in a text, in order, as mentionedPeople counts them. */
function peopleAt(text: string, people: Person[]) {
  const found: { id: string; at: number; end: number }[] = []
  for (const p of [...people].sort((a, b) => b.name.length - a.name.length)) {
    const sign = `@${p.name}`
    for (let at = text.indexOf(sign); at >= 0; at = text.indexOf(sign, at + 1)) {
      const end = at + sign.length
      if ((at > 0 && /\w/.test(text[at - 1])) || (end < text.length && /\w/.test(text[end]))) continue
      if (found.some((x) => at < x.end && end > x.at)) continue
      found.push({ id: p.id, at, end })
    }
  }
  return found.sort((a, b) => a.at - b.at)
}

export interface SaidPart {
  text: string
  kind?: Mention['kind']
  /** Who "@" names. */
  id?: string
  /** What "#" names, unquoted and without the sign, and whether it is a folder: one written with a "/" at its end. */
  path?: string
  dir?: boolean
  /** The skill "$" names. */
  skill?: string
}

/** What a "#" word names: its path, out of any quotes, and whether it ends with "/". */
function pathOf(word: string) {
  let path = word.slice(1)
  if (path.startsWith('"')) {
    try { path = JSON.parse(path) as string } catch { path = path.slice(1, -1) }
  }
  const dir = path.endsWith('/')
  return { path: dir ? path.replace(/\/+$/, '') : path, dir }
}

/**
 * A message cut where it mentions someone, a file or a skill, to show those apart. `signs` are which to look for: a
 * reply's own "#" or "$" is as likely a number or a price. A "#" or "$" counts at the start of a word, a "$" before a
 * letter only.
 */
export function saidParts(text: string, people: Person[], signs: string = '@#$'): SaidPart[] {
  const found: { at: number; end: number; kind: Mention['kind']; id?: string }[] = signs.includes('@') ? peopleAt(text, people).map((x) => ({ ...x, kind: '@' as const })) : []
  const words = [signs.includes('#') && /#(?:"(?:[^"\\\n]|\\.)*"|[^\s#"，。；：！？、（）「」]+)/g, signs.includes('$') && /\$[A-Za-z][\w.:-]*/g].filter((x): x is RegExp => !!x)
  for (const re of words) {
    for (const m of text.matchAll(re)) {
      // punctuation after the word is the sentence's, not the path's
      const word = m[0].startsWith('#"') ? m[0] : m[0].replace(/[,.;:!?，。；：！？、)）\]]+$/, '')
      const at = m.index, end = at + word.length
      if (word.length < 2 || (at > 0 && !isSpace(text[at - 1])) || found.some((x) => at < x.end && end > x.at)) continue
      found.push({ at, end, kind: word[0] as Mention['kind'] })
    }
  }
  found.sort((a, b) => a.at - b.at)
  const out: SaidPart[] = []
  let from = 0
  for (const x of found) {
    if (x.at > from) out.push({ text: text.slice(from, x.at) })
    const word = text.slice(x.at, x.end)
    out.push(x.kind === '@' ? { text: word, kind: x.kind, id: x.id }
      : x.kind === '#' ? { text: word, kind: x.kind, ...pathOf(word) }
      : { text: word, kind: x.kind, skill: word.slice(1) })
    from = x.end
  }
  if (from < text.length) out.push({ text: text.slice(from) })
  return out
}

/** A file ends the mention; a folder leaves it open, so the search carries on inside it. */
export function fileChoices(files: FileInfo[]): MentionChoice[] {
  return files.map(({ path, dir, ignored }) => {
    const at = path.lastIndexOf('/')
    const name = path.slice(at + 1)
    return { key: path, name: dir ? `${name}/` : name, hint: path.slice(0, at + 1), text: dir ? mentionText(`${path}/`, false) : mentionText(path, true), file: { dir, ignored: !!ignored } }
  })
}

function mentionText(path: string, complete: boolean) {
  if (/[\s"\\]/.test(path)) {
    const quoted = JSON.stringify(path)
    return complete ? `#${quoted} ` : `#${quoted.slice(0, -1)}`
  }
  return complete ? `#${path} ` : `#${path}`
}

/** The text with the word replaced by the choice, and where the cursor goes. */
export function acceptMention(text: string, m: Mention, choice: MentionChoice) {
  return { text: text.slice(0, m.start) + choice.text + text.slice(m.start + m.token.length), cursor: m.start + choice.text.length }
}

/** "@All" in a meeting: everyone in it replies. */
export const ALL: Person = { id: '@all', name: 'All' }

/** Mentions with "@All" made everyone in the meeting: the guests, then others it mentions, the chair last to sum up. */
export function withAll(mentions: string[], guests: string[], chair: string): string[] {
  if (!mentions.includes(ALL.id)) return mentions
  return [...new Set([...guests, ...mentions.filter((x) => x !== ALL.id && x !== chair)]), chair]
}

/** Who a message is for: those it mentions, or else the one whose question it answers, so the rest stay quiet. */
export function answerMentions(mentions: string[], asker: string | undefined): string[] {
  return mentions.length || !asker ? mentions : [asker]
}
