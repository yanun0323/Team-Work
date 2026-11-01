// What the user can do to the world. Every function has the simulator's signature, so a screen calls
// `act((x) => mergeTask(x, id))` the same way in both modes: under `make dev-mock` it runs the simulator, and
// otherwise it asks the backend, and the answer comes back as a change to the world.

import { request } from './backend'
import * as sim from './domain/sim'
import type { Attachment, Blueprint, Chat, Effort, Locale, Look, Replica, TalkEnd, Team, Workflow, World } from './domain/types'
import { MOCK } from './mode'

/** Reports a request that failed; the store shows it. Set once at start. */
let onFailure: (message: string) => void = () => {}
export const setFailureHandler = (fn: (message: string) => void) => { onFailure = fn }

/** Sends a request whose outcome the screen does not wait on. */
function fire_(method: string, path: string, body?: unknown) {
  request(method, path, body).catch((e: Error) => onFailure(e.message))
}

/** Sends a request a form waits on, staying open if it fails. */
export async function attempt<T>(work: () => Promise<T>): Promise<T | undefined> {
  try {
    return await work()
  } catch (e) {
    onFailure((e as Error).message)
    return undefined
  }
}

type Sim = typeof sim

const pick = <K extends keyof Sim>(name: K, real: (...args: never[]) => unknown) => (MOCK ? sim[name] : real) as Sim[K]

export const setLanguage = pick('setLanguage', (_w: World, language: Locale) => fire_('PUT', '/settings/language', { language }))

// ---------- tasks ----------

export const createTask = pick('createTask', (_w: World, i: sim.NewTask) => fire_('POST', '/tasks', i))
export const deleteTask = pick('deleteTask', (_w: World, id: string) => fire_('DELETE', `/tasks/${id}`))
export const pauseTask = pick('pauseTask', (_w: World, id: string) => fire_('POST', `/tasks/${id}/pause`))
export const resumeTask = pick('resumeTask', (_w: World, id: string) => fire_('POST', `/tasks/${id}/resume`))
export const mergeTask = pick('mergeTask', (_w: World, id: string) => fire_('POST', `/tasks/${id}/merge`))
export const returnTask = pick('returnTask', (_w: World, id: string, feedback: string) => fire_('POST', `/tasks/${id}/return`, { feedback }))
export const resolveReview = pick('resolveReview', (_w: World, id: string, optionId: string, note = '') =>
  fire_('POST', `/subtasks/${id}/review`, { optionId, note }))
export const sayInTalk = pick('sayInTalk', (_w: World, id: string, text: string) => fire_('POST', `/subtasks/${id}/talk`, { text }))
export const endTalk = pick('endTalk', (_w: World, id: string, end: TalkEnd) => fire_('POST', `/subtasks/${id}/talk/end`, end))

// ---------- chats ----------

export const sayInChat = pick('sayInChat', (_w: World, id: string, text: string, images: Attachment[] = []) => fire_('POST', `/chats/${id}/say`, { text, images }))
export const rewindChat = pick('rewindChat', (_w: World, id: string, index: number) => fire_('POST', `/chats/${id}/rewind`, { index }))
export const stopChat = pick('stopChat', (_w: World, id: string) => fire_('POST', `/chats/${id}/stop`))
export const deleteChat = pick('deleteChat', (_w: World, id: string) => fire_('DELETE', `/chats/${id}`))

/** Starts a chat with its first message. Its sheet waits for this, to go on as that chat. */
export function startChat(act: (fn: (w: World) => void) => void, input: sim.NewChat): Promise<Chat | undefined> {
  if (MOCK) {
    let made: Chat | undefined
    act((w) => { made = JSON.parse(JSON.stringify(sim.createChat(w, input))) as Chat })
    return Promise.resolve(made)
  }
  return attempt(() => request<Chat>('POST', '/chats', input))
}

/** A task written from a chat, for the new-task sheet. */
export const chatTaskDraft = (w: World, id: string) => (MOCK
  ? Promise.resolve(sim.chatTaskDraft(w, id))
  : request<{ title: string; description: string }>('POST', `/chats/${id}/task-draft`))

/** Whether a company's folder has changes not committed. */
export const hasUncommitted = (teamId: string) => (MOCK
  ? Promise.resolve(false)
  : request<{ uncommitted: boolean }>('GET', `/teams/${teamId}/uncommitted`).then((r) => r.uncommitted))

/** Change a task's title, description, staff and owner. */
export function updateTask(w: World, id: string, p: { title: string; description: string; staff: Record<string, string[]>; ownerId: string | null }) {
  if (!MOCK) return fire_('PATCH', `/tasks/${id}`, p)
  const t = w.tasks[id]
  if (!t) return
  t.title = p.title
  t.description = p.description
  for (const n of t.workflow.nodes) if (p.staff[n.id]) n.replicaIds = [...p.staff[n.id]]
  sim.setOwner(t, p.ownerId)
}

// ---------- flows ----------

export const deleteWorkflow = pick('deleteWorkflow', (_w: World, id: string) => fire_('DELETE', `/workflows/${id}`))
export const duplicateWorkflow = pick('duplicateWorkflow', (_w: World, id: string) => fire_('POST', `/workflows/${id}/duplicate`))

/** Save a flow (`id` null makes a new one). */
export function saveWorkflow(w: World, id: string | null, flow: Pick<Workflow, 'name' | 'nodes' | 'edges'>) {
  if (MOCK) {
    const wf = id ? w.workflows[id] : sim.newWorkflow(w, '')
    if (wf) Object.assign(wf, flow)
    return
  }
  void attempt(async () => {
    const wid = id ?? (await request<Workflow>('POST', '/workflows', { name: flow.name })).id
    await request('PUT', `/workflows/${wid}`, flow)
  })
}

// ---------- companies ----------

type TeamEdit = Partial<Pick<Team, 'name' | 'prompt' | 'targetBranch' | 'settings'>>

const SEND_AFTER = 400
const edits = new Map<string, { timer: number; patch: TeamEdit }>()

/** A company with typing not sent yet; what the backend says about it meanwhile is older than the screen. */
export const editing = (id: string) => edits.has(id)

/** Change a company. The screen follows at once; the backend gets it when the typing pauses. */
/** Reread the company's AGENTS.md, which can change outside the app. Quiet: nobody asked, and the next run reads it anyway. */
export function refreshPrompt(id: string) {
  if (!MOCK) void request('POST', `/teams/${id}/prompt/refresh`).catch(() => {})
}

export function editTeam(w: World, id: string, patch: TeamEdit) {
  const team = w.teams[id]
  if (!team) return
  Object.assign(team, patch)
  if (MOCK) return
  const pending = edits.get(id)
  if (pending) window.clearTimeout(pending.timer)
  const merged = { ...pending?.patch, ...patch }
  const timer = window.setTimeout(() => {
    edits.delete(id)
    fire_('PATCH', `/teams/${id}`, merged)
  }, SEND_AFTER)
  edits.set(id, { timer, patch: merged })
}

/** Shows a company's folder in Finder. */
export const openFolder = (id: string) => fire_('POST', `/teams/${id}/open-folder`)

export const deleteTeam = pick('deleteTeam', (_w: World, id: string) => fire_('DELETE', `/teams/${id}`))

// ---------- employees ----------

export const hire = pick('hire', (_w: World, teamId: string, blueprintId: string, name: string, look: Look | undefined, mind: { model?: string; effort?: Effort } = {}) =>
  fire_('POST', '/replicas', { teamId, blueprintId, name, look, ...mind }))
export const fire = pick('fire', (_w: World, id: string, heir: string) => fire_('DELETE', `/replicas/${id}?heir=${encodeURIComponent(heir)}`))

export function updateReplica(w: World, id: string, p: Pick<Replica, 'name' | 'blueprintId' | 'model' | 'effort' | 'look'>) {
  if (!MOCK) return fire_('PATCH', `/replicas/${id}`, p)
  if (w.replicas[id]) Object.assign(w.replicas[id], p)
}

// ---------- blueprints ----------

export const deleteBlueprint = pick('deleteBlueprint', (_w: World, id: string) => fire_('DELETE', `/blueprints/${id}`))

/** Save a blueprint (`id` null makes a new one). One from a repo is moved to that repo's newest version. */
export function saveBlueprint(w: World, id: string | null, make: (key: string, prev: Blueprint | undefined) => Blueprint) {
  if (MOCK) {
    if (id && !w.blueprints[id]) return
    const key = id ?? `bp${++w.seq}`
    w.blueprints[key] = make(key, w.blueprints[key])
    return
  }
  const body = make(id ?? '', id ? w.blueprints[id] : undefined)
  void attempt(async () => {
    const saved = id ? (await request('PUT', `/blueprints/${id}`, body), id) : (await request<Blueprint>('POST', '/blueprints', body)).id
    if (sim.gitSources(body).some((s) => !s.commit)) await request('POST', `/blueprints/${saved}/update`)
  })
}

// ---------- model providers ----------

export const deleteProvider = pick('deleteProvider', (_w: World, id: string) => fire_('DELETE', `/providers/${id}`))

export const startLogin = (id: string, method?: 'browser' | 'device') => request('POST', `/providers/${id}/login`, { method })
export const pasteLogin = (id: string, value: string) => request('POST', `/providers/${id}/login/paste`, { value })
export const cancelLogin = (id: string) => request('DELETE', `/providers/${id}/login`)

// ---------- the repo of a new company ----------

export const branchesOf = (folder: string, signal: AbortSignal) =>
  request<{ branches: string[]; repo: boolean }>('GET', `/branches?folder=${encodeURIComponent(folder)}`, undefined, signal)
