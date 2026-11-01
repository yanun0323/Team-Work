// The blueprints and flows built into the app, in every language. The text is shared with the backend, which keeps them
// the same way: the world holds them in the language picked, and they cannot be changed, only copied.

import data from '../../../../backend/internal/usecase/presets.json'
import { autoLayout, isFixed } from '../domain/graph'
import type { Blueprint, Locale, Look, Tool, Workflow, WorkflowNode, World } from '../domain/types'

type Text = { zh: string; en: string }
type Step = { name: Text; prompt?: Text; talk?: boolean }

/** Built-in blueprints and flows have ids of this form; a copy gets an id of its own. */
export const isPreset = (id: string) => id.startsWith('preset-')

/** What the two ends of every flow and every discussion are called and told. */
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
 * Puts what the app itself wrote in a flow into a language: all of a built-in flow, and in any flow the instructions of the
 * fixed steps and discussions, and the two ends' names unless renamed by hand. What a user wrote stays as written.
 */
export function localizeFlow(wf: Workflow, language: Locale) {
  const flow = data.flows.find((f) => f.id === wf.id)
  if (flow) wf.name = flow.name[language]
  const steps = stepsOf(wf.id)
  for (const n of wf.nodes) {
    const s = steps.get(n.id)
    if (s) {
      n.name = s.name[language]
      if (s.prompt) n.prompt = s.prompt[language]
    }
    if (n.kind === 'talk') n.prompt = data.talk[language]
    else if (isFixed(wf, n.id)) {
      const fixed = n.kind === 'task' ? data.start : data.end
      n.prompt = fixed.prompt[language]
      if (n.name === fixed.name.zh || n.name === fixed.name.en) n.name = fixed.name[language]
    }
  }
}

const node = (id: string, kind: WorkflowNode['kind'], name: string, prompt: string): WorkflowNode => ({
  id, kind, name, prompt, replicaIds: [], assignment: 'firstAvailable', handoff: 'all', join: 'all', pos: { x: 0, y: 0 },
})

function presetFlow(f: (typeof data.flows)[number], language: Locale): Workflow {
  const start = `${f.id}-start`
  const end = `${f.id}-end`
  const wf: Workflow = {
    id: f.id, name: f.name[language], edges: [],
    nodes: [node(start, 'task', data.start.name[language], data.start.prompt[language]), node(end, 'work', data.end.name[language], data.end.prompt[language])],
  }
  const link = (from: string[], to: string[]) => {
    for (const a of from) for (const b of to) wf.edges.push({ id: `${f.id}-e${wf.edges.length + 1}`, from: a, to: b, condition: '' })
  }
  let prev = [start]
  ;(f.layers as Step[][]).forEach((layer, i) => {
    const ids = layer.map((s, j) => {
      const id = nodeIdOf(f.id, i, j)
      wf.nodes.push(node(id, s.talk ? 'talk' : 'work', s.name[language], (s.talk ? data.talk : s.prompt!)[language]))
      return id
    })
    link(prev, ids)
    prev = ids
  })
  link(prev, [end])
  autoLayout(wf)
  return wf
}

/** Puts the built-in blueprints and flows into the world in its language, and every flow's fixed text too. */
export function installPresets(w: World) {
  const language = w.language
  for (const b of data.blueprints) {
    w.blueprints[b.id] = {
      id: b.id, name: b.name[language], prompt: b.prompt[language], comment: '', autoUpdate: false, source: { kind: 'preset' },
      tools: b.tools as Tool[], look: b.look as Look,
      skills: data.skillFolders.map((path) => ({ source: { kind: 'local', path }, include: null, exclude: [] })),
    } satisfies Blueprint
  }
  for (const wf of Object.values(w.workflows)) localizeFlow(wf, language)
  for (const f of data.flows) w.workflows[f.id] = presetFlow(f, language)
}
