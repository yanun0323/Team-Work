// What the user can do to the world. Every function has the simulator's signature, so a screen calls
// `act((x) => mergeTask(x, id))` the same way in both modes: under `make dev-mock` it runs the simulator, and
// otherwise it asks the backend, and the answer comes back as a change to the world.

import { request } from './backend'
import * as sim from './domain/sim'
import type { Attachment, Blueprint, Chat, Source, SourceChanges, SourceItem, SourcePreview, Effort, FileInfo, Locale, Look, MemoryEntry, Replica, SkillInfo, SkillText, TalkEnd, Team, Workflow, World } from './domain/types'
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
export const sayInTalk = pick('sayInTalk', (_w: World, id: string, text: string, mentions: string[] = []) => fire_('POST', `/subtasks/${id}/talk`, { text, mentions }))
export const endTalk = pick('endTalk', (_w: World, id: string, end: TalkEnd) => fire_('POST', `/subtasks/${id}/talk/end`, end))

// ---------- chats ----------

export const sayInChat = pick('sayInChat', (_w: World, id: string, text: string, images: Attachment[] = [], files: Attachment[] = [], mentions: string[] = []) => fire_('POST', `/chats/${id}/say`, { text, images, files, mentions }))
export const setChatChair = pick('setChatChair', (_w: World, id: string, replicaId: string) => fire_('PATCH', `/chats/${id}/chair`, { replicaId }))
export const setChatMind = pick('setChatMind', (_w: World, id: string, model: string, effort: string) => fire_('PATCH', `/chats/${id}/mind`, { model, effort }))
export const renameChat = pick('renameChat', (_w: World, id: string, title: string) => fire_('PATCH', `/chats/${id}/title`, { title }))
export const pinChat = pick('pinChat', (_w: World, id: string, pinned: boolean) => fire_('PATCH', `/chats/${id}/pin`, { pinned }))
export const rewindChat = pick('rewindChat', (_w: World, id: string, index: number) => fire_('POST', `/chats/${id}/rewind`, { index }))
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
  return attempt(() => request<Chat>('POST', '/chats', input))
}

export function startAirportChat(act: (fn: (w: World) => void) => void, input: sim.NewAirportChat): Promise<Chat | undefined> {
  if (MOCK) {
    let made: Chat | undefined
    act((w) => { made = JSON.parse(JSON.stringify(sim.createAirportChat(w, input))) as Chat })
    return Promise.resolve(made)
  }
  return attempt(() => request<Chat>('POST', '/airport/chats', input))
}

/** Copies a chat up to a message, for an employee of the company to go on with. The answer can arrive ahead of the change to the world, and the copy opens at once. */
export async function handOffChat(act: (fn: (w: World) => void) => void, id: string, index: number, replicaId: string): Promise<Chat | undefined> {
  if (MOCK) {
    let made: Chat | undefined
    act((w) => { const fork = sim.handOffChat(w, id, index, replicaId); made = fork && JSON.parse(JSON.stringify(fork)) as Chat })
    return made
  }
  const made = await attempt(() => request<Chat>('POST', `/chats/${id}/handoff`, { index, replicaId }))
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

/** Change a task's title, description, staff and owner. */
export function updateTask(w: World, id: string, p: { title: string; description: string; staff: Record<string, string[]>; ownerId: string | null }) {
  if (!MOCK) return fire_('PATCH', `/tasks/${id}`, p)
  const t = w.tasks[id]
  if (!t) return
  t.title = p.title
  t.description = p.description
  for (const n of t.workflow.nodes) if (p.staff[n.id]) n.replicaIds = [...p.staff[n.id]]
  t.ownerId = p.ownerId
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

/** Shows a company's folder in Finder, or a folder in it; with no company, one at home. The prototype has no folders to show. */
export const openFolder = (id: string, path = '') => {
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
export interface TreeEntry { name: string; path: string; kind: 'dir' | 'file' }

const projectBase = (teamId: string) => `/teams/${encodeURIComponent(teamId)}`

/** One level of a folder in a company's project ('' is the project itself), straight from disk; at most 5000 entries. */
export const listProjectTree = (teamId: string, path: string, signal?: AbortSignal) =>
  request<{ entries: TreeEntry[] | null; truncated: boolean }>('GET', `${projectBase(teamId)}/tree?path=${encodeURIComponent(path)}`, undefined, signal)
    .then((r) => ({ entries: r.entries ?? [], truncated: r.truncated }))

/** A text file in a company's project to edit, with the fingerprint (sha256) of its content to save against. */
export const openProjectFile = (teamId: string, path: string, signal?: AbortSignal) =>
  request<{ text: string; hash: string }>('GET', `${projectBase(teamId)}/file?path=${encodeURIComponent(path)}`, undefined, signal)

/** Writes a text file in a company's project, only if it still has the content `hash` was taken of; answers the new hash. */
export const saveProjectFile = (teamId: string, path: string, text: string, hash: string) =>
  request<{ hash: string }>('PUT', `${projectBase(teamId)}/file`, { path, text, hash }).then((r) => r.hash)

/** A new empty file or folder in a folder of a company's project ('' is the project itself). */
export const createProjectEntry = (teamId: string, parent: string, name: string, kind: TreeEntry['kind']) =>
  request<TreeEntry>('POST', `${projectBase(teamId)}/tree`, { parent, name, kind })

/** Where an `<img>` loads a picture in a company's folder, or at home with no company, as it is now. */
export const projectImageUrl = (teamId: string, path: string) => `/api/v1${mentionBase(teamId)}/image?path=${encodeURIComponent(path)}`

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
  saveMemory(w, id, (w.replicas[id]?.memory ?? []).map((m) => (m.id === memoryId ? { ...m, text, source: 'user' as const, at: w.now } : m)))
}

export function deleteMemory(w: World, id: string, memoryId: string) {
  saveMemory(w, id, (w.replicas[id]?.memory ?? []).filter((m) => m.id !== memoryId))
}

// ---------- blueprints ----------

export const deleteBlueprint = pick('deleteBlueprint', (_w: World, id: string) => fire_('DELETE', `/blueprints/${id}`))

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

/** What putting a source's newest version in use would change, and whom. */
export const sourceChanges = (w: World, id: string, signal?: AbortSignal) => (MOCK
  ? Promise.resolve(sim.sourceChanges(w, id))
  : request<SourceChanges>('GET', `/sources/${id}/changes`, undefined, signal))

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

// ---------- the repo of a new company ----------

export const branchesOf = (folder: string, signal: AbortSignal) =>
  request<{ branches: string[]; repo: boolean }>('GET', `/branches?folder=${encodeURIComponent(folder)}`, undefined, signal)
