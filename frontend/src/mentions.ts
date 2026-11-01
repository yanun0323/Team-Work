// What the word at the cursor of a message box is asking for: "$" a skill, "@" a file or folder. Either counts at
// the start of any word. A quoted "@" may hold spaces, as a path can.

import type { FileInfo, SkillInfo } from './core/domain/types'

export interface Mention {
  kind: '$' | '@'
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
}

const isSpace = (c: string) => /\s/.test(c)

function openQuoteStart(before: string) {
  for (let i = 0; i + 1 < before.length; i++) {
    if (before[i] !== '@' || before[i + 1] !== '"' || (i > 0 && !isSpace(before[i - 1]))) continue
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
  if (token[0] === '@') return { kind: '@', start, token, query: fileQuery(token.slice(1)) }
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

/** A file ends the mention; a folder leaves it open, so the search carries on inside it. */
export function fileChoices(files: FileInfo[]): MentionChoice[] {
  return files.map(({ path, dir }) => {
    const at = path.lastIndexOf('/')
    const name = path.slice(at + 1)
    return { key: path, name: dir ? `${name}/` : name, hint: path.slice(0, at + 1), text: dir ? mentionText(`${path}/`, false) : mentionText(path, true) }
  })
}

function mentionText(path: string, complete: boolean) {
  if (/[\s"\\]/.test(path)) {
    const quoted = JSON.stringify(path)
    return complete ? `@${quoted} ` : `@${quoted.slice(0, -1)}`
  }
  return complete ? `@${path} ` : `@${path}`
}

/** The text with the word replaced by the choice, and where the cursor goes. */
export function acceptMention(text: string, m: Mention, choice: MentionChoice) {
  return { text: text.slice(0, m.start) + choice.text + text.slice(m.start + m.token.length), cursor: m.start + choice.text.length }
}
