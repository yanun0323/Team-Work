// What the app itself writes in every language, and the airport staff's blueprint, shared with the backend. The
// official source's blueprints and flows are downloaded by the backend; the simulator reads the copy of that source the
// backend's tests read instead, which only it carries. The world holds them all in the language picked, and they
// cannot be changed, only copied.

import { parse } from 'yaml'
import data from '../../../../backend/internal/usecase/presets.json'
import { autoLayout } from '../domain/graph'
import { MOCK } from '../mode'
import { OFFICIAL_SOURCE, sourceFor, sourceOfId } from '../domain/sources'
import type { Blueprint, Locale, Look, SkillPack, Tool, Workflow, WorkflowNode, World } from '../domain/types'

type Text = Record<Locale, string>
/** Whether s is this text in any language. */
const is = (t: Text, s: string) => Object.values(t).includes(s)

/** Built-in blueprints have ids of this form; a copy gets an id of its own. */
export const isPreset = (id: string) => id.startsWith('preset-')

/** Whether a blueprint or flow is kept by something other than the user, built in or read from a source: it cannot be changed, only copied. */
export const isLocked = (id: string) => isPreset(id) || sourceOfId(id) !== ''

/** The airport staff's blueprint: theirs alone, shown with the others but not hired from. */
export const AIRPORT_BLUEPRINT = 'preset-airport'

/** The templates for a step that sorts out the task and one that reviews it, and what every discussion is told. */
export const fixedSteps = (language: Locale) => ({
  startName: data.start.name[language],
  startPrompt: data.start.prompt[language],
  endName: data.end.name[language],
  endPrompt: data.end.prompt[language],
  talkPrompt: data.talk[language],
})

/** Sorts built-in blueprints by their place in the shared list; anything else comes before them. */
export const presetRank = (id: string) => data.blueprints.findIndex((p) => p.id === id)

/** A text a source's file writes: one for every language, or one for each language by its code. */
type SourcedText = string | Partial<Record<Locale, string>> | undefined

/** The text in a language, or else in English, or else the first one written. */
export const textIn = (t: SourcedText, language: Locale): string =>
  typeof t === 'string' ? t : t?.[language] ?? t?.en ?? Object.values(t ?? {})[0] ?? ''

/** Whether s is a text in any language. */
const isText = (t: SourcedText, s: string) => (typeof t === 'string' ? t === s : Object.values(t ?? {}).includes(s))

type BlueprintFile = {
  name: SourcedText; prompt?: SourcedText; comment?: SourcedText; tools?: string[]; look?: Look
  skills?: { repo?: string; ref?: string; path?: string; include?: string[]; exclude?: string[] }[]
}
type FlowFile = {
  name: SourcedText
  nodes: { id: string; kind?: WorkflowNode['kind']; name: SourcedText; prompt?: SourcedText; sendBack?: boolean }[]
  edges: { from: string; to: string; condition?: string }[]
}

// only the simulator has them: the app reads what the backend downloaded
const FILES: Record<string, string> = MOCK
  ? import.meta.glob<string>(['../../../../backend/internal/usecase/testdata/official/*/*.yaml', '../../../../backend/internal/usecase/testdata/official/commit'], { eager: true, query: '?raw', import: 'default' })
  : {}

/** The official source's files, by folder and name without the extension. */
const official = (folder: string) => Object.entries(FILES)
  .map(([path, text]) => ({ folder: path.split('/').at(-2), name: path.split('/').at(-1)!.replace(/\.yaml$/, ''), text }))
  .filter((f) => f.folder === folder)
  .sort((a, b) => a.name.localeCompare(b.name))

const officialBlueprints = official('blueprints').map((f) => ({ ...f, file: parse(f.text) as BlueprintFile }))
const officialFlows = official('workflows').map((f) => ({ ...f, file: parse(f.text) as FlowFile }))

const officialId = (name: string) => `${OFFICIAL_SOURCE}--${name}`

const TOOL_OF: Record<string, Tool> = { read_file: 'readFile', write_file: 'writeFile', web_search: 'webSearch', run_command: 'runCommand' }

/**
 * Puts what the app and the official source wrote in a flow into a language: all of an official flow, a step's name
 * and instructions while its name is still one the source wrote for it, and in any flow the instructions of
 * discussions, and a step's name and instructions while they are still the start or end template's. What a user
 * wrote stays as written.
 */
export function localizeFlow(wf: Workflow, language: Locale) {
  const flow = officialFlows.find((f) => officialId(f.name) === wf.id)?.file
  if (flow) wf.name = textIn(flow.name, language)
  for (const n of wf.nodes) {
    const s = flow?.nodes.find((x) => x.id === n.id)
    if (s && isText(s.name, n.name)) {
      n.name = textIn(s.name, language)
      if (s.prompt !== undefined) n.prompt = textIn(s.prompt, language)
    }
    if (n.kind === 'talk') {
      n.prompt = data.talk[language]
      continue
    }
    if (n.kind === 'task') n.prompt = data.start.prompt[language]
    for (const fixed of [data.start, data.end]) {
      if (is(fixed.prompt, n.prompt)) n.prompt = fixed.prompt[language]
      if (is(fixed.name, n.name)) n.name = fixed.name[language]
    }
  }
}

function officialFlow(name: string, f: FlowFile, language: Locale): Workflow {
  const wf: Workflow = {
    id: officialId(name), name: textIn(f.name, language),
    nodes: f.nodes.map((n) => ({
      id: n.id, kind: n.kind ?? 'work', name: textIn(n.name, language), prompt: textIn(n.prompt, language), replicaIds: [],
      handoff: 'all', join: 'all', pos: { x: 0, y: 0 }, ...(n.sendBack !== undefined && { sendBack: n.sendBack }),
    })),
    edges: f.edges.map((e, i) => ({ id: `edge-${i + 1}`, from: e.from, to: e.to, condition: e.condition ?? '' })),
  }
  autoLayout(wf)
  localizeFlow(wf, language)
  return wf
}

/** Every world keeps the official source, applying its updates by itself; it cannot be removed. */
function officialSource(w: World) {
  const commit = (Object.entries(FILES).find(([path]) => path.endsWith('/official/commit'))?.[1] ?? '').trim().slice(0, 7)
  w.sources[OFFICIAL_SOURCE] ??= {
    id: OFFICIAL_SOURCE, kind: 'git', repo: 'https://github.com/yanun0323/Team-Work-Source', ref: '', commit, latest: commit,
    upstream: true, autoApply: true,
  }
}

/**
 * Puts the airport staff's blueprint and what the official source brings into the world in its language, and every
 * flow's fixed text too. A blueprint's folders and repos are kept as sources, like ones the user added.
 */
export function installPresets(w: World) {
  const language = w.language
  w.sources ??= {}
  officialSource(w)
  for (const b of data.blueprints) {
    w.blueprints[b.id] = {
      id: b.id, name: b.name[language], prompt: b.prompt[language], comment: '', source: { kind: 'preset' },
      tools: b.tools as Tool[], look: b.look as Look,
      skills: data.skillFolders.map((path) => ({ source: { kind: 'local', path }, include: null, exclude: [] })),
    } satisfies Blueprint
  }
  for (const { name, text, file: f } of officialBlueprints) {
    w.blueprints[officialId(name)] = {
      id: officialId(name), name: textIn(f.name, language), prompt: textIn(f.prompt, language).trim(), comment: textIn(f.comment, language).trim(),
      source: { kind: 'yaml', text }, tools: (f.tools ?? []).map((t) => TOOL_OF[t] ?? (t as Tool)), look: f.look as Look,
      skills: (f.skills ?? []).map((p): SkillPack => {
        const picks = { include: p.include ?? null, exclude: p.exclude ?? [] }
        if (p.repo) return { sourceId: sourceFor(w, 'git', p.repo, p.ref ?? '').id, ...(p.path && { path: p.path }), ...picks }
        if (p.path?.startsWith('~') || p.path?.startsWith('/')) return { sourceId: sourceFor(w, 'local', p.path).id, ...picks }
        return { sourceId: OFFICIAL_SOURCE, ...(p.path && { path: p.path }), ...picks }
      }),
    } satisfies Blueprint
  }
  for (const wf of Object.values(w.workflows)) localizeFlow(wf, language)
  for (const { name, file } of officialFlows) w.workflows[officialId(name)] = officialFlow(name, file, language)
}
