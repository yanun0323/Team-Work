// A blueprint written by hand as YAML: what it says, checked, or the first thing wrong with it.
//
//   name: Reviewer                  # required
//   prompt: |                       # the system prompt; empty when left out
//     You are a reviewer.
//   comment: |                      # the author's note; empty when left out
//     Suits a GPT model.
//   skills:                         # none when left out
//     - path: ~/.agents/            # skills on this computer: ~/.agents/ or ~/.agents/skills/
//       include: [code-review]      # every skill there when left out
//       exclude: []                 # none when left out
//     - repo: anthropics/skills     # skills from a GitHub repo: owner/repo or its address
//       ref: main                   # branch, tag or commit; the default branch (master, else main) when left out
//       include: [summarize]
//   tools: [read_file, write_file, web_search, run_command]   # none when left out
//
// There is no model: each employee picks their own.

import { isMap, isScalar, isSeq, parseDocument, type YAMLMap } from 'yaml'
import { TOOLS, type Blueprint, type GitSource, type SkillPack, type Tool } from './core/domain/types'
import { parseGithub } from './github'

/** The tool names a YAML blueprint uses, in the order of `TOOLS`. */
export const YAML_TOOLS: Record<Tool, string> = {
  readFile: 'read_file',
  writeFile: 'write_file',
  webSearch: 'web_search',
  runCommand: 'run_command',
}

/** What a new YAML blueprint starts as: a working example of every field. */
export const YAML_TEMPLATE = `name: Reviewer
prompt: |
  你是程式碼審查者。先找出會出錯的地方，再把風格問題列為建議。
  每個問題都附上檔案與行號，並說明怎麼改。
comment: |
  建議搭配推理能力強的模型。
skills:
  # 本機的 skill：全部載入，排除 deploy
  - path: ~/.agents/
    exclude: [deploy]
  # GitHub 上的 skill：全部載入
  - repo: anthropics/skills
    ref: main
  # GitHub 上的 skill：只載入列出的
  - repo: anthropics/skills
    ref: main
    include: [code-review, summarize]
tools: [read_file, write_file, web_search, run_command]
`

export type BlueprintYaml = Pick<Blueprint, 'name' | 'prompt' | 'comment' | 'skills' | 'tools'>

export type Parsed = { ok: true; value: BlueprintYaml } | { ok: false; error: string; line?: number }

const TOP = ['name', 'prompt', 'comment', 'skills', 'tools']
const SKILL_KEYS = ['path', 'repo', 'ref', 'include', 'exclude']

/** A mistake, and the YAML node it is in (for its line). */
class Invalid extends Error {
  constructor(message: string, readonly node?: unknown) {
    super(message)
  }
}

/** A text value, trimmed; '' when missing. */
function text(map: YAMLMap, key: string, required = false): string {
  const node: unknown = map.get(key, true)
  if (node === undefined || (isScalar(node) && node.value === null && !required)) {
    if (required) throw new Invalid(`缺少 ${key}`)
    return ''
  }
  const value: unknown = isScalar(node) ? node.value : undefined
  if (typeof value !== 'string' || (required && !value.trim())) throw new Invalid(`${key} 要是文字`, node)
  return value.trim()
}

/** A list of names; null when missing. */
function names(map: YAMLMap, key: string): string[] | null {
  const node: unknown = map.get(key, true)
  if (node === undefined) return null
  const items = isSeq(node) ? node.items.map((x) => (isScalar(x) && typeof x.value === 'string' ? x.value.trim() : '')) : null
  if (!items || items.some((x) => !x)) throw new Invalid(`${key} 要是名稱的清單，例如 [a, b]`, node)
  return items
}

/** Keys other than `known` are mistakes, most likely typos. */
function onlyKeys(map: YAMLMap, known: string[], where: string) {
  for (const pair of map.items) {
    const key = isScalar(pair.key) ? String(pair.key.value) : ''
    if (!known.includes(key)) throw new Invalid(`${where}不支援 ${key || '這個'} 欄位，只能用 ${known.join('、')}`, pair.key)
  }
}

/**
 * Read a YAML blueprint. A skill repo becomes a Git source at `ref` (`commit` is what it resolves to; the
 * prototype has nothing to resolve it against), found and fetched at `now`.
 */
export function parseBlueprintYaml(input: string, now = 0, commit = () => '0000000'): Parsed {
  const doc = parseDocument(input, { prettyErrors: false })
  if (doc.errors.length) return { ok: false, error: 'YAML 格式錯誤', line: doc.errors[0].linePos?.[0].line }
  const root = doc.contents
  if (!isMap(root)) return { ok: false, error: '內容要是 key: value 的設定' }
  try {
    onlyKeys(root, TOP, '')
    const name = text(root, 'name', true)
    const prompt = text(root, 'prompt')
    const comment = text(root, 'comment')

    const skills: SkillPack[] = []
    const list: unknown = root.get('skills', true)
    if (list !== undefined && !(isScalar(list) && list.value === null)) {
      if (!isSeq(list)) throw new Invalid('skills 要是清單', list)
      for (const item of list.items) {
        if (!isMap(item)) throw new Invalid('skills 的每一項要有 path 或 repo', item)
        onlyKeys(item, SKILL_KEYS, 'skills 裡')
        const path = item.has('path') ? text(item, 'path', true) : ''
        const repo = item.has('repo') ? text(item, 'repo', true) : ''
        if (!path === !repo) throw new Invalid(path ? 'path 和 repo 只能擇一' : 'skills 的每一項要有 path 或 repo', item)
        const include = names(item, 'include')
        const exclude = names(item, 'exclude') ?? []
        if (path) {
          if (item.has('ref')) throw new Invalid('ref 只用在 repo', item.get('ref', true))
          skills.push({ source: { kind: 'local', path }, include: include && [...new Set(include)], exclude: [...new Set(exclude)] })
          continue
        }
        const g = parseGithub(repo)
        if (!g) throw new Invalid('repo 要是 owner/repo 或 GitHub 網址', item.get('repo', true))
        const version = g.ref || text(item, 'ref')
        const at = commit()
        const source: GitSource = {
          kind: 'git', repo: `git@github.com:${g.repo}`, ref: version, commit: at, latestRef: version, latest: at,
          private: false, upstream: true, update: { at: now, ok: true },
        }
        skills.push({ source, include: include && [...new Set(include)], exclude: [...new Set(exclude)] })
      }
    }

    const tools: Tool[] = []
    for (const [i, n] of (names(root, 'tools') ?? []).entries()) {
      const tool = TOOLS.find((t) => YAML_TOOLS[t] === n)
      const seq = root.get('tools', true)
      if (!tool) throw new Invalid(`tools 只能是 ${TOOLS.map((t) => YAML_TOOLS[t]).join('、')}`, isSeq(seq) ? seq.items[i] : seq)
      tools.push(tool)
    }

    return { ok: true, value: { name, prompt, comment, skills, tools: TOOLS.filter((t) => tools.includes(t)) } }
  } catch (e) {
    if (!(e instanceof Invalid)) throw e
    const range = (e.node as { range?: [number, number, number] } | undefined)?.range
    return { ok: false, error: e.message, line: range ? input.slice(0, range[0]).split('\n').length : undefined }
  }
}
