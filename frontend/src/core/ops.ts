// What the user can do to the world. Every function has the simulator's signature, so a screen calls
// `act((x) => mergeTask(x, id))` the same way in both modes: under `make dev-mock` it runs the simulator, and
// otherwise it asks the backend, and the answer comes back as a change to the world.

import { idempotencyKey, localRequest, request } from './backend'
import { apiBase, remoteIsland } from './island'
import { tr } from './i18n'
import { seedWorld } from './data/seed'
import * as sim from './domain/sim'
import type { Attachment, Blueprint, Chat, Source, SourceChanges, SourceItem, SourcePreview, Effort, FileInfo, Locale, Look, MemoryEntry, Replica, SkillInfo, SkillText, TalkEnd, Task, TaskActivity, TaskOperation, Team, Workflow, World } from './domain/types'
import { MOCK } from './mode'
import { usePrefs } from '../prefs'

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

/** The sample world is written in each language, so under `make dev-mock` a new language starts it again in that one. */
export const setLanguage = MOCK
  ? (w: World, language: Locale) => { if (w.language !== language) Object.assign(w, seedWorld(language)) }
  : (w: World, language: Locale) => {
    // the language belongs to this computer; on another island its world says the other's, so the screen follows here
    if (remoteIsland()) w.language = language
    localRequest('PUT', '/settings/language', { language }).catch((e: Error) => onFailure(e.message))
  }

// ---------- tasks ----------

// every new task is run by its owner; the backend decides that itself
export const createTask = MOCK
  ? (w: World, i: sim.NewTask) => sim.createTask(w, { ...i, orchestration: 'owner' })
  : (_w: World, i: sim.NewTask) => fire_('POST', '/tasks', i)
export const deleteTask = pick('deleteTask', (_w: World, id: string) => fire_('DELETE', `/tasks/${id}`))
export const pauseTask = pick('pauseTask', (_w: World, id: string) => fire_('POST', `/tasks/${id}/pause`))
export const resumeTask = pick('resumeTask', (_w: World, id: string) => fire_('POST', `/tasks/${id}/resume`))
export const mergeTask = pick('mergeTask', (_w: World, id: string) => fire_('POST', `/tasks/${id}/merge`))
export const returnTask = pick('returnTask', (_w: World, id: string, feedback: string) => fire_('POST', `/tasks/${id}/return`, { feedback }))
export const resolveReview = pick('resolveReview', (_w: World, id: string, optionId: string, note = '') =>
  fire_('POST', `/subtasks/${id}/review`, { optionId, note }))
export const sayInTalk = pick('sayInTalk', (_w: World, id: string, text: string, mentions: string[] = []) => fire_('POST', `/subtasks/${id}/talk`, { text, mentions }))
export const endTalk = pick('endTalk', (_w: World, id: string, end: TalkEnd) => fire_('POST', `/subtasks/${id}/talk/end`, end))

// ---------- tasks their owner runs ----------
// These are waited on: the screen shows each one received, being worked on, taken effect or failed. A failed one is
// sent again with the same requestId, so one that did go through is not done twice.

/** One user action's id, made once and kept across retries of it. */
export const newRequestId = idempotencyKey

export type OwnerMessage = sim.OwnerMessage
export type OwnerControl = sim.OwnerControl
export interface ActivityPage { version: string; total: number; items: TaskActivity[]; hasMore: boolean }

const taskPath = (id: string) => `/tasks/${encodeURIComponent(id)}`

/** Runs a simulator call in the world and hands back a copy of what it returned, or its refusal. */
function simulate<T>(act: (fn: (w: World) => void) => void, fn: (w: World) => T): Promise<T> {
  let out: { ok: T } | { error: Error } | undefined
  act((w) => {
    try { out = { ok: JSON.parse(JSON.stringify(fn(w))) as T } } catch (e) { out = { error: e as Error } }
  })
  if (!out) return Promise.reject(new Error('simulate'))
  return 'error' in out ? Promise.reject(out.error) : Promise.resolve(out.ok)
}

/** Tells the task's owner something; only the owner reads it. */
export const sayToOwner = (act: (fn: (w: World) => void) => void, taskId: string, m: OwnerMessage) => (MOCK
  ? simulate(act, (w) => sim.sayToOwner(w, taskId, m))
  : request<{ operation: TaskOperation; activity: TaskActivity }>('POST', `${taskPath(taskId)}/messages`, m))

/** Pauses, starts or resumes, sends a step back, retries the owner or answers one of its questions. */
export const controlTask = (act: (fn: (w: World) => void) => void, taskId: string, body: OwnerControl) => (MOCK
  ? simulate(act, (w) => sim.controlOwnerTask(w, taskId, body))
  : request<{ operation: TaskOperation }>('POST', `${taskPath(taskId)}/control`, body))

/** The versions an action other than a pause is decided on: what the screen showed. */
export const seenVersions = (t: Task) => ({ planVersion: t.coordination?.planVersion ?? 0, controlVersion: t.coordination?.controlVersion ?? 0 })

/** A page of a task's conversation, oldest first; `version` pins the pages to one version of it. */
export function readTaskActivity(w: World, taskId: string, q: { before?: number; limit?: number; version?: string }, signal?: AbortSignal): Promise<ActivityPage> {
  if (MOCK) return Promise.resolve().then(() => sim.activityPage(w, taskId, q))
  const params = new URLSearchParams()
  if (q.before !== undefined) params.set('before', String(q.before))
  params.set('limit', String(q.limit ?? 50))
  if (q.version) params.set('version', q.version)
  return request<ActivityPage>('GET', `${taskPath(taskId)}/activity?${params}`, undefined, signal)
}

export type MeetingControl = sim.MeetingControl

/** Goes on with a paused meeting for another batch of model calls, ends it, or asks again for its conclusion. */
export const controlMeeting = (act: (fn: (w: World) => void) => void, taskId: string, meetingId: string, body: MeetingControl) => (MOCK
  ? simulate(act, (w) => sim.controlMeeting(w, taskId, meetingId, body))
  : request<{ operation: TaskOperation }>('POST', `${taskPath(taskId)}/meetings/${encodeURIComponent(meetingId)}/control`, body))

/** A page of one meeting's words and conclusion, oldest first; `version` pins the pages to one version of it. */
export function readMeetingActivity(w: World, taskId: string, meetingId: string, q: { before?: number; limit?: number; version?: string }, signal?: AbortSignal): Promise<ActivityPage> {
  if (MOCK) return Promise.resolve().then(() => sim.meetingActivityPage(w, taskId, meetingId, q))
  const params = new URLSearchParams()
  if (q.before !== undefined) params.set('before', String(q.before))
  params.set('limit', String(q.limit ?? 50))
  if (q.version) params.set('version', q.version)
  return request<ActivityPage>('GET', `${taskPath(taskId)}/meetings/${encodeURIComponent(meetingId)}/activity?${params}`, undefined, signal)
}

/** One message of a task's conversation, to go back to what a question was asked in. */
export const readTaskActivityItem = (w: World, taskId: string, id: string, signal?: AbortSignal) => (MOCK
  ? Promise.resolve().then(() => sim.activityItem(w, taskId, id))
  : request<TaskActivity>('GET', `${taskPath(taskId)}/activity/${encodeURIComponent(id)}`, undefined, signal))

/** Where an action stands, when the task no longer lists it (it closed while the connection was down). */
export const readTaskOperation = (w: World, taskId: string, id: string, signal?: AbortSignal) => (MOCK
  ? Promise.resolve().then(() => {
    const op = w.tasks[taskId]?.coordination?.operations.find((o) => o.id === id)
    if (!op) throw new sim.TaskRefusal('not found', 'not_found')
    return op
  })
  : request<TaskOperation>('GET', `${taskPath(taskId)}/operations/${encodeURIComponent(id)}`, undefined, signal))

// ---------- chats ----------

export const sayInChat = pick('sayInChat', (_w: World, id: string, text: string, images: Attachment[] = [], files: Attachment[] = [], mentions: string[] = []) => fire_('POST', `/chats/${id}/say`, { text, images, files, mentions }))
export const setChatChair = pick('setChatChair', (_w: World, id: string, replicaId: string) => fire_('PATCH', `/chats/${id}/chair`, { replicaId }))
export const setChatMind = pick('setChatMind', (_w: World, id: string, model: string, effort: string) => fire_('PATCH', `/chats/${id}/mind`, { model, effort }))
export const renameChat = pick('renameChat', (_w: World, id: string, title: string) => fire_('PATCH', `/chats/${id}/title`, { title }))
export const pinChat = pick('pinChat', (_w: World, id: string, pinned: boolean) => fire_('PATCH', `/chats/${id}/pin`, { pinned }))
export function rewindChat(w: World, id: string, index: number, version?: string) {
  if (MOCK) return sim.rewindChat(w, id, index)
  fire_('POST', `/chats/${id}/rewind`, { index, version })
}
export const resolveChatChange = pick('resolveChatChange', (_w: World, id: string, approve: boolean) => fire_('POST', `/chats/${id}/change`, { approve }))
export const retryChat = pick('retryChat', (_w: World, id: string) => fire_('POST', `/chats/${id}/retry`))
export const stopChat = pick('stopChat', (_w: World, id: string) => fire_('POST', `/chats/${id}/stop`))
export const steerChat = pick('steerChat', (_w: World, id: string, queued: string) => fire_('POST', `/chats/${id}/queue/${queued}/steer`))
export const unqueueChat = pick('unqueueChat', (_w: World, id: string, queued: string) => fire_('DELETE', `/chats/${id}/queue/${queued}`))
export const readChat = pick('readChat', (_w: World, id: string) => fire_('POST', `/chats/${id}/read`))
export const deleteChat = pick('deleteChat', (_w: World, id: string) => fire_('DELETE', `/chats/${id}`))

/** Starts a chat with its first message. Its sheet waits for this, to go on as that chat. */
export function startChat(act: (fn: (w: World) => void) => void, input: sim.NewChat): Promise<Chat | undefined> {
  if (MOCK) {
    let made: Chat | undefined
    act((w) => { made = JSON.parse(JSON.stringify(sim.createChat(w, input))) as Chat })
    return Promise.resolve(made)
  }
  return attempt(() => request<Chat>('POST', '/chats?chats=paged', input))
}

export function startAirportChat(act: (fn: (w: World) => void) => void, input: sim.NewAirportChat): Promise<Chat | undefined> {
  if (MOCK) {
    let made: Chat | undefined
    act((w) => { made = JSON.parse(JSON.stringify(sim.createAirportChat(w, input))) as Chat })
    return Promise.resolve(made)
  }
  return attempt(() => request<Chat>('POST', '/airport/chats?chats=paged', input))
}

/** Copies a chat up to a message, for an employee of the company to go on with. The answer can arrive ahead of the change to the world, and the copy opens at once. */
export async function handOffChat(act: (fn: (w: World) => void) => void, id: string, index: number, replicaId: string, version?: string): Promise<Chat | undefined> {
  if (MOCK) {
    let made: Chat | undefined
    act((w) => { const fork = sim.handOffChat(w, id, index, replicaId); made = fork && JSON.parse(JSON.stringify(fork)) as Chat })
    return made
  }
  const made = await attempt(() => request<Chat>('POST', `/chats/${id}/handoff?chats=paged`, { index, replicaId, version }))
  if (made) act((w) => { w.chats[made.id] ??= made })
  return made
}

/** A task written from a chat, for the new-task sheet. */
export const chatTaskDraft = (w: World, id: string) => (MOCK
  ? Promise.resolve(sim.chatTaskDraft(w, id))
  : request<{ title: string; description: string }>('POST', `/chats/${id}/task-draft`))

/** The skills "$" offers in a chat with this employee. */
export const replicaSkills = (w: World, replicaId: string, signal?: AbortSignal) => (MOCK
  ? Promise.resolve(sim.replicaSkills(w, replicaId))
  : request<SkillInfo[]>('GET', `/replicas/${replicaId}/skills`, undefined, signal))

/** The skills "$" offers in a chat with the airport staff. */
export const airportSkills = (w: World, signal?: AbortSignal) => (MOCK
  ? Promise.resolve(sim.airportSkills(w))
  : request<SkillInfo[]>('GET', '/airport/skills', undefined, signal))

/** The skills each pack of a blueprint brings, in the order of its packs; null for one that cannot be read. */
export const blueprintSkills = (w: World, id: string, signal?: AbortSignal) => (MOCK
  ? Promise.resolve(sim.blueprintSkills(w, id))
  : request<(string[] | null)[]>('GET', `/blueprints/${id}/skills`, undefined, signal))

/** Where "#" paths are, by the API: a company's folder, or with no company the user's home folder, as at the airport. */
const mentionBase = (teamId: string) => (teamId ? `/teams/${teamId}` : '/airport')

/** The files and folders "#" offers from a company's folder, or from home at the airport. */
export const searchFiles = (teamId: string, query: string, signal?: AbortSignal) => (MOCK
  ? Promise.resolve(sim.searchFiles(query))
  : request<FileInfo[]>('GET', `${mentionBase(teamId)}/files?q=${encodeURIComponent(query)}`, undefined, signal))

/** Whether a company's folder has changes not committed. */
export const hasUncommitted = (teamId: string) => (MOCK
  ? Promise.resolve(false)
  : request<{ uncommitted: boolean }>('GET', `/teams/${teamId}/uncommitted`).then((r) => r.uncommitted))

/**
 * Change a task's title, description, staff and owner, and with `workflow` its own flow; with `swap`, steps under way go
 * to their new employee at once. Answers whether it took: a refusal is shown, and the sheet waiting on it stays open.
 */
export async function updateTask(w: World, act: (fn: (w: World) => void) => void, id: string, p: sim.TaskEdit): Promise<boolean> {
  if (MOCK) return (await attempt(() => simulate(act, (x) => { sim.updateTask(x, id, p); return true }))) === true
  // a task its owner runs is changed only as the user saw it, so an edit cannot undo what happened since
  const t = w.tasks[id]
  const body = t?.coordination ? { ...seenVersions(t), ...p } : p
  return (await attempt(async () => { await request('PATCH', `/tasks/${id}`, body); return true })) === true
}

// ---------- flows ----------

/** Hides a blueprint or flow from every list to pick from and from employees' tools, or shows it again. */
const markHidden = (key: 'hiddenBlueprints' | 'hiddenWorkflows', id: string, hidden: boolean) =>
  usePrefs.setState((p) => ({ [key]: [...p[key].filter((x) => x !== id), ...(hidden ? [id] : [])] }))
export const hideWorkflow = MOCK
  ? (_w: World, id: string, hidden: boolean) => markHidden('hiddenWorkflows', id, hidden)
  : (_w: World, id: string, hidden: boolean) => fire_('PUT', `/workflows/${id}/hidden`, { hidden })
export const hideBlueprint = MOCK
  ? (_w: World, id: string, hidden: boolean) => markHidden('hiddenBlueprints', id, hidden)
  : (_w: World, id: string, hidden: boolean) => fire_('PUT', `/blueprints/${id}/hidden`, { hidden })
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

/** Why something that opens a window on the computer running the backend is off on another island. */
export const remoteWindowReason = () => tr('這會在對方電腦上打開視窗，這裡不能用')

/** Shows a company's folder in Finder, or a folder in it; with no company, one at home. The prototype has no folders to show. */
export const openFolder = (id: string, path = '') => {
  if (remoteIsland()) return onFailure(remoteWindowReason())
  if (!MOCK) fire_('POST', `${mentionBase(id)}/open-folder${path ? `?path=${encodeURIComponent(path)}` : ''}`)
}

/** The prototype's notes, kept until the page reloads. */
const mockNotes = new Map<string, string>()

/** A company's notes, the Markdown in its folder's .team-work/NOTES.md, as they are now. */
export const readNotes = (teamId: string, signal?: AbortSignal) => (MOCK
  ? Promise.resolve(mockNotes.get(teamId) ?? '')
  : request<{ text: string }>('GET', `/teams/${teamId}/notes`, undefined, signal).then((r) => r.text))

export const saveNotes = (teamId: string, text: string) => (MOCK
  ? Promise.resolve(void mockNotes.set(teamId, text))
  : request('PUT', `/teams/${teamId}/notes`, { text }).then(() => {}))

/** A text file in a company's folder, or at home with no company, as it is now. */
export const readProjectFile = (teamId: string, path: string, signal?: AbortSignal) => (MOCK
  ? Promise.resolve().then(() => sim.projectFile(path))
  : request<{ text: string }>('GET', `${mentionBase(teamId)}/file?path=${encodeURIComponent(path)}`, undefined, signal).then((r) => r.text))

/** One thing in a folder of a company's project, as the file browser lists it. */
export interface TreeEntry { name: string; path: string; kind: 'dir' | 'file'; /** git's ignore rules leave it out */ ignored?: boolean }

const projectBase = (teamId: string) => `/teams/${encodeURIComponent(teamId)}`

/**
 * Under `make dev-mock` the file browser shows the simulator's sample project, and what is saved stays in the browser,
 * by company and path. Tests drive the real requests with a fake fetch, so there it is off.
 */
const SAMPLE_PROJECT = import.meta.env.MODE === 'mock'
const mockSaved = new Map<string, string>()

/** One level of a folder in a company's project ('' is the project itself), straight from disk; at most 5000 entries. */
export const listProjectTree = (teamId: string, path: string, signal?: AbortSignal) => (SAMPLE_PROJECT
  ? Promise.resolve().then(() => sim.projectTree(path))
  : request<{ entries: TreeEntry[] | null; truncated: boolean }>('GET', `${projectBase(teamId)}/tree?path=${encodeURIComponent(path)}`, undefined, signal)
    .then((r) => ({ entries: r.entries ?? [], truncated: r.truncated })))

/** A text file in a company's project to edit, with the fingerprint (sha256) of its content to save against. */
export const openProjectFile = (teamId: string, path: string, signal?: AbortSignal) => (SAMPLE_PROJECT
  ? Promise.resolve().then(() => ({ text: mockSaved.get(`${teamId}/${path}`) ?? sim.projectFile(path), hash: 'mock' }))
  : request<{ text: string; hash: string }>('GET', `${projectBase(teamId)}/file?path=${encodeURIComponent(path)}`, undefined, signal))

/** Writes a text file in a company's project, only if it still has the content `hash` was taken of; answers the new hash. */
export const saveProjectFile = (teamId: string, path: string, text: string, hash: string) => (SAMPLE_PROJECT
  ? Promise.resolve(void mockSaved.set(`${teamId}/${path}`, text)).then(() => 'mock')
  : request<{ hash: string }>('PUT', `${projectBase(teamId)}/file`, { path, text, hash }).then((r) => r.hash))

/** Where an `<img>` loads a picture in a company's folder, or at home with no company, as it is now. */
export const projectImageUrl = (teamId: string, path: string) => `${apiBase()}${mentionBase(teamId)}/image?path=${encodeURIComponent(path)}`

/** A skill "$" names in a chat: from the first of its people who has it, the chair first. */
export const readChatSkill = (w: World, chatId: string, name: string, signal?: AbortSignal) => (MOCK
  ? Promise.resolve().then(() => sim.chatSkill(w, chatId, name))
  : request<SkillText>('GET', `/chats/${chatId}/skill?name=${encodeURIComponent(name)}`, undefined, signal))

export const deleteTeam = pick('deleteTeam', (_w: World, id: string) => fire_('DELETE', `/teams/${id}`))

// ---------- employees ----------

export const hire = pick('hire', (_w: World, teamId: string, blueprintId: string, name: string, look: Look | undefined, mind: { model?: string; effort?: Effort } = {},
  custom?: sim.OwnSettings) => fire_('POST', '/replicas', { teamId, blueprintId, name, look, ...mind, custom }))
export const fire = pick('fire', (_w: World, id: string, heir: string) => fire_('DELETE', `/replicas/${id}?heir=${encodeURIComponent(heir)}`))

/** Change an employee; `custom` gives them settings of their own, and without it `blueprintId` is what they work by. */
export function updateReplica(w: World, id: string, p: Pick<Replica, 'name' | 'blueprintId' | 'model' | 'effort' | 'look'>, custom?: sim.OwnSettings) {
  if (!MOCK) return fire_('PATCH', `/replicas/${id}`, { ...p, custom })
  sim.updateReplica(w, id, p, custom)
}

function saveMemory(w: World, id: string, memory: MemoryEntry[]) {
  if (!MOCK) return fire_('PATCH', `/replicas/${id}`, { memory })
  if (w.replicas[id]) w.replicas[id].memory = memory
}

/** Corrects a note. Built from the world at the moment of saving, so notes written while editing stay. */
export function editMemory(w: World, id: string, memoryId: string, text: string) {
  const at = MOCK ? w.now : Date.now() / 1000
  saveMemory(w, id, (w.replicas[id]?.memory ?? []).map((m) => (m.id === memoryId ? { ...m, text, source: 'user' as const, at } : m)))
}

export function deleteMemory(w: World, id: string, memoryId: string) {
  saveMemory(w, id, (w.replicas[id]?.memory ?? []).filter((m) => m.id !== memoryId))
}

// ---------- blueprints ----------

/** Delete a blueprint; the employees made from it move to blueprint `to` first. */
export const deleteBlueprint = pick('deleteBlueprint', (_w: World, id: string, to?: string) =>
  fire_('DELETE', `/blueprints/${id}${to ? `?to=${encodeURIComponent(to)}` : ''}`))

/** Save a blueprint (`id` null makes a new one). One from a repo is moved to that repo's newest version. */
export function saveBlueprint(w: World, id: string | null, make: (key: string, prev: Blueprint | undefined) => Blueprint) {
  if (MOCK) {
    if (id && !w.blueprints[id]) return
    const key = id ?? `bp${++w.seq}`
    w.blueprints[key] = make(key, w.blueprints[key])
    sim.adoptSources(w)
    return
  }
  const body = make(id ?? '', id ? w.blueprints[id] : undefined)
  void attempt(async () => {
    const saved = id ? (await request('PUT', `/blueprints/${id}`, body), id) : (await request<Blueprint>('POST', '/blueprints', body)).id
    if (sim.gitSources(body).some((s) => !s.commit)) await request('POST', `/blueprints/${saved}/update`)
  })
}

// ---------- sources ----------

/**
 * Keeps a repo at a branch, or a folder, as a source, or finds the one kept; a new repo is read at its newest
 * version. `act` changes the simulator's world, as the store's does.
 */
export function addSource(act: (fn: (w: World) => void) => void, kind: Source['kind'], where: string, ref = '', commit = ''): Promise<Source> {
  if (!MOCK) return request<Source>('POST', '/sources', kind === 'git' ? { kind, repo: where, ref, commit } : { kind, path: where })
  let made: Source | undefined
  act((x) => { made = { ...sim.addSource(x, kind, where, ref) } })
  return made ? Promise.resolve(made) : Promise.reject(new Error('add source'))
}

/** What a source would bring before it is kept: a repo's newest version and its skills there. */
export const previewSource = (kind: Source['kind'], where: string, ref = '', signal?: AbortSignal) => (MOCK
  ? new Promise<SourcePreview>((done) => setTimeout(() => done(sim.previewSource(kind, where, ref)), 400))
  : request<SourcePreview>('POST', '/sources/preview', kind === 'git' ? { kind, repo: where, ref } : { kind, path: where }, signal))

/** The skills a source has, at the version in use. */
export const sourceItems = (w: World, id: string, signal?: AbortSignal) => (MOCK
  ? Promise.resolve(w.sources[id] ? sim.itemsOf(w.sources[id]) : [])
  : request<SourceItem[]>('GET', `/sources/${id}/items`, undefined, signal))

/** One of a source's skills, by its path among the source's items, at the version in use. */
export const readSourceSkill = (w: World, id: string, path: string, signal?: AbortSignal) => (MOCK
  ? Promise.resolve().then(() => sim.sourceSkill(w, id, path))
  : request<SkillText>('GET', `/sources/${id}/skill?path=${encodeURIComponent(path)}`, undefined, signal))

/** The employee and task blueprint files of a source that could not be read, and why. */
export const sourceProblems = (id: string, signal?: AbortSignal) => (MOCK
  ? Promise.resolve<string[]>([])
  : request<string[]>('GET', `/sources/${id}/problems`, undefined, signal))

/** What putting a source's newest version in use would change, and whom. */
export const sourceChanges = (w: World, id: string, signal?: AbortSignal) => (MOCK
  ? Promise.resolve(sim.sourceChanges(w, id))
  : request<SourceChanges>('GET', `/sources/${id}/changes`, undefined, signal))

/** Asks a repo source's upstream for its newest version now; settles once the check is recorded on the source. */
export function checkSource(act: (fn: (w: World) => void) => void, id: string): Promise<void> {
  if (!MOCK) return request('POST', `/sources/${id}/check`).then(() => undefined)
  act((x) => sim.checkSource(x, id))
  return Promise.resolve()
}

export const applySource = pick('applySource', (_w: World, id: string) => fire_('POST', `/sources/${id}/apply`))
export const seeSource = pick('seeSource', (_w: World, id: string) => fire_('POST', `/sources/${id}/seen`))
export const setSourceAutoApply = pick('setSourceAutoApply', (_w: World, id: string, on: boolean) => fire_('PUT', `/sources/${id}/auto-apply`, { on }))
export const deleteSource = pick('deleteSource', (_w: World, id: string) => fire_('DELETE', `/sources/${id}`))

// ---------- model providers ----------

export const deleteProvider = pick('deleteProvider', (_w: World, id: string) => fire_('DELETE', `/providers/${id}`))

export const startLogin = (id: string, method?: 'browser' | 'device') => request('POST', `/providers/${id}/login`, { method })
export const pasteLogin = (id: string, value: string) => request('POST', `/providers/${id}/login/paste`, { value })
export const cancelLogin = (id: string) => request('DELETE', `/providers/${id}/login`)
export const logout = (id: string) => request('POST', `/providers/${id}/logout`)
/** Asks a provider for its models now; settles once the answer is in the world. */
export const refreshModels = (id: string): Promise<void> => (MOCK ? Promise.resolve() : request('POST', `/providers/${id}/models`).then(() => undefined))
/** A list of models is being opened: providers not asked for a while are asked again, in the background. */
export const refreshStaleModels = () => { if (!MOCK) request('POST', '/models/stale').catch(() => {}) }

// ---------- the repo of a new company ----------

export const branchesOf = (folder: string, signal: AbortSignal) =>
  request<{ branches: string[]; repo: boolean }>('GET', `/branches?folder=${encodeURIComponent(folder)}`, undefined, signal)
