// The blueprints and flows built into the app, in every language. The text is shared with the backend, which keeps them
// the same way: the world holds them in the language picked, and they cannot be changed, only copied.

import data from '../../../../backend/internal/usecase/presets.json'
import { autoLayout, canSendBack } from '../domain/graph'
import { sourceFor } from '../domain/sources'
import type { Blueprint, Locale, Look, Tool, Workflow, WorkflowNode, World } from '../domain/types'

type Text = { zh: string; en: string }
type Step = { name: Text; prompt?: Text; talk?: boolean }
/** The folder (none: the whole repo) of a repo at a branch that a built-in blueprint reads its skills from. */
type Pack = { repo: string; ref: string; path?: string }

/** Built-in blueprints and flows have ids of this form; a copy gets an id of its own. */
export const isPreset = (id: string) => id.startsWith('preset-')

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

/** Sorts built-in blueprints and flows by their place in the shared list; anything else comes before them. */
export const presetRank = (id: string) =>
  [...data.blueprints, ...data.flows].findIndex((p) => p.id === id)

const nodeIdOf = (flow: string, layer: number, step: number) => `${flow}-${layer}-${step}`

const stepsOf = (flowId: string) => {
  const steps = new Map<string, Step>()
  data.flows.find((f) => f.id === flowId)?.layers.forEach((layer, i) => (layer as Step[]).forEach((s, j) => steps.set(nodeIdOf(flowId, i, j), s)))
  return steps
}

/**
 * Puts what the app itself wrote in a flow into a language: all of a built-in flow, and in any flow the instructions of
 * discussions, and a step's name and instructions while they are still the start or end template's. What a user wrote
 * stays as written.
 */
export function localizeFlow(wf: Workflow, language: Locale) {
  const flow = data.flows.find((f) => f.id === wf.id)
  if (flow) wf.name = flow.name[language]
  const steps = stepsOf(wf.id)
  for (const n of wf.nodes) {
    const s = steps.get(n.id)
    // a task's copy from before the flow changed may hold another step at this place, so the name must match too
    if (s && (n.name === s.name.zh || n.name === s.name.en)) {
      n.name = s.name[language]
      if (s.prompt) n.prompt = s.prompt[language]
    }
    if (n.kind === 'talk') {
      n.prompt = data.talk[language]
      continue
    }
    if (n.kind === 'task') n.prompt = data.start.prompt[language]
    for (const fixed of [data.start, data.end]) {
      if (n.prompt === fixed.prompt.zh || n.prompt === fixed.prompt.en) n.prompt = fixed.prompt[language]
      if (n.name === fixed.name.zh || n.name === fixed.name.en) n.name = fixed.name[language]
    }
  }
}

const node = (id: string, kind: WorkflowNode['kind'], name: string, prompt: string): WorkflowNode => ({
  id, kind, name, prompt, replicaIds: [], handoff: 'all', join: 'all', pos: { x: 0, y: 0 },
})

function presetFlow(f: (typeof data.flows)[number], language: Locale): Workflow {
  const wf: Workflow = { id: f.id, name: f.name[language], edges: [], nodes: [] }
  const link = (from: string[], to: string[]) => {
    for (const a of from) for (const b of to) wf.edges.push({ id: `${f.id}-e${wf.edges.length + 1}`, from: a, to: b, condition: '' })
  }
  let prev: string[] = []
  ;(f.layers as Step[][]).forEach((layer, i) => {
    const ids = layer.map((s, j) => {
      const id = nodeIdOf(f.id, i, j)
      const n = node(id, s.talk ? 'talk' : 'work', s.name[language], (s.talk ? data.talk : s.prompt!)[language])
      if (i > 0 && !s.talk) n.sendBack = false
      wf.nodes.push(n)
      return id
    })
    link(prev, ids)
    prev = ids
  })
  // a last step may send work back, as a new flow's would
  for (const n of wf.nodes) if (n.sendBack !== undefined && prev.includes(n.id)) n.sendBack = canSendBack(wf, n.id)
  autoLayout(wf)
  return wf
}

/**
 * Puts the built-in blueprints and flows into the world in its language, and every flow's fixed text too. A built-in
 * blueprint's repos are kept as sources, like ones the user added.
 */
export function installPresets(w: World) {
  const language = w.language
  w.sources ??= {}
  for (const b of data.blueprints) {
    const packs = 'skills' in b ? (b.skills as Pack[]) : undefined
    w.blueprints[b.id] = {
      id: b.id, name: b.name[language], prompt: b.prompt[language], comment: '', source: { kind: 'preset' },
      tools: b.tools as Tool[], look: b.look as Look,
      skills: packs
        ? packs.map((p) => ({ sourceId: sourceFor(w, 'git', p.repo, p.ref).id, ...(p.path && { path: p.path }), include: null, exclude: [] }))
        : data.skillFolders.map((path) => ({ source: { kind: 'local', path }, include: null, exclude: [] })),
    } satisfies Blueprint
  }
  for (const wf of Object.values(w.workflows)) localizeFlow(wf, language)
  for (const f of data.flows) w.workflows[f.id] = presetFlow(f, language)
}
