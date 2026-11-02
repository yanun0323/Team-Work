import type { Prefs } from '../../prefs'
import type { BuildingLook, Spot } from '../../layout'
// Domain types. Names follow CONTEXT.md at the repo root.

export type Locale = 'zh' | 'en'

export type Status = 'todo' | 'progressing' | 'review' | 'complete'
export type AssignmentMode = 'firstAvailable' | 'everyone'
export type HandoffMode = 'pickOne' | 'all'
export type JoinMode = 'any' | 'all'

export interface Look {
  skin: string
  hair: string
  shirt: string
  pants: string
  extra: 'none' | 'glasses' | 'cap' | 'headset' | 'sunglasses' | 'beanie' | 'bow'
  /** Seeds what the 3D figure wears beyond these colours (hair cut, top); without it the id does. */
  style?: number
}

/** How hard an employee thinks before answering. */
/** A thinking level, as its provider names it, or `default` to leave it to the provider. */
export type Effort = string

/** A Git repo something is read from, pinned to a commit, and what is known about its upstream. */
export interface GitSource {
  kind: 'git'
  repo: string
  /** Version asked for: a branch, tag or commit; empty for the default branch. */
  ref: string
  /** Commit in use. */
  commit: string
  /** Newest version upstream, as last seen. Equal to `ref` / `commit` when up to date. */
  latestRef: string
  latest: string
  private: boolean
  /** The repo was reached at the last check; false when it is gone, renamed or can no longer be read. */
  upstream: boolean
  /** The last attempt to move to the newest version: when (world seconds), and whether it worked. */
  update?: { at: number; ok: boolean; error?: string }
}

/** A blueprint made here rather than read from a repo; `text` is its YAML, see `src/blueprintYaml.ts`. */
export interface YamlSource {
  kind: 'yaml'
  text: string
}

/** Built into the app: it cannot be changed, only copied. */
export interface PresetSource {
  kind: 'preset'
}

export type BlueprintSource = GitSource | YamlSource | PresetSource

/**
 * A folder of skills on this computer: an agents folder (`~/.agents/`, whose `skills/` is read) or the
 * skills folder itself (`~/.agents/skills/`).
 */
export interface LocalSkills {
  kind: 'local'
  path: string
}

/** Skills read from one place: `source` null means the blueprint's own repo. */
export interface SkillPack {
  source: GitSource | LocalSkills | null
  /** The skills taken from it; null takes every one it has. */
  include: string[] | null
  /** Skills it has that are left out. */
  exclude: string[]
}

/** The only tools an employee can be allowed: read files, write files, search the web, run commands. */
export const TOOLS = ['readFile', 'writeFile', 'webSearch', 'runCommand'] as const
export type Tool = (typeof TOOLS)[number]

export interface Blueprint {
  id: string
  name: string
  source: BlueprintSource
  autoUpdate: boolean
  /** The system prompt every employee made from it starts with; may be empty. */
  prompt: string
  /** The author's note on it, such as which model suits it; may be empty. */
  comment: string
  /** Its skills, grouped by where they come from; a blueprint may draw them from several repos and folders. */
  skills: SkillPack[]
  /** Which of the `TOOLS` it is allowed. */
  tools: Tool[]
  look: Look
}

export type MemorySource = 'work' | 'retro' | 'review' | 'user'

export interface MemoryEntry {
  id: string
  text: string
  source: MemorySource
  at: number
  taskId?: string
}

/** A skill "$" can name. */
export interface SkillInfo {
  name: string
  description: string
}

/** A file or folder "@" can name, relative to the company's folder. */
export interface FileInfo {
  path: string
  dir: boolean
}

export interface Replica {
  id: string
  teamId: string
  blueprintId: string
  name: string
  look: Look
  /** Starts as the blueprint's model. */
  model: string
  effort: Effort
  memory: MemoryEntry[]
  hiredAt: number
}

/**
 * `task` is the step every flow starts with (整理需求); `work` is a step an employee works on their own;
 * `talk` (使用者討論) is one the employee and the user talk through together until the user ends it.
 */
export type NodeKind = 'task' | 'work' | 'talk'

export interface WorkflowNode {
  id: string
  kind: NodeKind
  name: string
  prompt: string
  replicaIds: string[]
  assignment: AssignmentMode
  handoff: HandoffMode
  join: JoinMode
  pos: { x: number; y: number }
}

export interface WorkflowEdge {
  id: string
  from: string
  to: string
  condition: string
}

/** A way of working, shared by every company; staff comes from each task. */
export interface Workflow {
  id: string
  name: string
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
}

export interface TeamSettings {
  timeoutMin: number
  costLimitUsd: number
  retries: number
}

export interface Team {
  plot?: BuildingLook & { at: Spot }
  id: string
  name: string
  folder: string
  targetBranch: string
  branches: string[]
  initializedGit: boolean
  /** 公司規章: the project prompt every employee here works under, on top of their blueprint's own. */
  prompt: string
  settings: TeamSettings
  createdAt: number
}

export interface AgentHandoff {
  goal: string
  done: string[]
  outputs: string[]
  decisions: string[]
  open: string[]
  next?: { nodeId: string; reason: string }
}

export interface HumanSummary {
  headline: string
  did: string[]
  outputs: string[]
  ask?: string
}

export interface Handoff {
  agent: AgentHandoff
  human: HumanSummary
  commit: string
}

export type ReviewKind = 'question' | 'pickRoute' | 'failed' | 'budget' | 'talk'
export type FailReason = 'timeout' | 'error'

export interface ReviewOption {
  id: string
  /** Content label. System options leave it empty and the UI translates `id`. */
  label?: string
  detail?: string
}

export interface Review {
  kind: ReviewKind
  /** Sub-task status before the review, restored when it is resolved. */
  from: Status
  prompt?: string
  reason?: FailReason
  options: ReviewOption[]
  at: number
}

export type LogKind = 'think' | 'tool' | 'say' | 'system' | 'human'

export interface LogLine {
  at: number
  kind: LogKind
  text: string
  /** System lines carry an i18n key so the UI can show them in either language. */
  key?: string
  args?: Record<string, string | number>
}

/** One message in a 使用者討論 step, from the user or from the employee working it. */
export interface ChatMessage {
  at: number
  /** `tool` is something the employee ran, in a chat. */
  from: 'user' | 'agent' | 'tool'
  text: string
  /** What the user attached, in a chat. */
  images?: Attachment[]
  files?: Attachment[]
}

/** The user talking with one employee outside any task. Its employee and model never change. */
export interface Chat {
  id: string
  teamId: string
  replicaId: string
  /** Who it was, for when the employee has left. */
  name: string
  look: Look
  model: string
  messages: ChatMessage[]
  tokens: number
  /** The employee is writing a reply. */
  replyAt?: number
  /** The employee waits for an answer to what they just asked; the next message is it. */
  question?: { options: string[] }
  /** The employee said something the user has not opened the chat to see. */
  unread?: boolean
  createdAt: number
}

/** How the user ended a discussion: hand on (to `to`, when the step picks one of several), send back, or stop the task. */
export type TalkEnd = { kind: 'continue'; to?: string } | { kind: 'back'; reason: string } | { kind: 'stop' }

/** A 使用者討論 step's conversation. */
export interface Talk {
  messages: ChatMessage[]
  /** The employee is writing a reply, which comes in at this time. */
  replyAt?: number
  ended?: TalkEnd['kind']
}

/** Fake events decided when a sub-task is created, keyed by progress (0..1). */
export interface Script {
  lines: { p: number; kind: LogKind; text: string }[]
  ask?: { p: number; prompt: string; options: string[] }
  fail?: { p: number; reason: 'timeout' | 'error'; times: number }
  route?: number | 'unsure'
  memory?: { p: number; text: string }
  retro?: string
  duration?: number
  /** USD per simulated second. */
  costRate?: number
  /**
   * Whether this run, if it is the flow's last step or a step sent back, sends the work back to the steps
   * before it: it does when `roll` is under that step's odds (see sim.ts `sendsBack`), giving `reason`.
   */
  sendBack?: { roll: number; reason: string }
  /** A 使用者討論 step: what the employee opens with once ready, and what they say back, in turn. */
  talk?: { opening: string; replies: string[] }
}

export interface SubTask {
  id: string
  taskId: string
  nodeId: string
  parentId: string | null
  upstreamIds: string[]
  replicaId: string | null
  status: Status
  cancelled: boolean
  progress: number
  duration: number
  createdAt: number
  startedAt?: number
  endedAt?: number
  attempts: number
  costUsd: number
  tokens: number
  routedTo: string[]
  /** Finished and already handed off downstream (or nothing downstream). */
  routed: boolean
  /** Last time an upstream handoff arrived. Work starts after the box reaches the node. */
  arrivedAt: number
  skipped?: boolean
  /** Join sub-task still collecting upstream handoffs. */
  waiting: boolean
  /** Shared by the sub-tasks of one node in Everyone mode; equals the lead sub-task id. */
  group?: string
  asked?: boolean
  /** How many send-backs led to this run; a sub-task's round is the highest of the ones it came from. */
  round?: number
  /** This run sent the work back to the steps before it (by node id) instead of handing it on. */
  sentBack?: { to: string[]; reason: string }
  /** This run redoes a step another one sent back (`from`, a sub-task id). */
  rework?: { from: string; reason: string }
  review?: Review
  /** A 使用者討論 step's conversation, once the employee has opened it. */
  talk?: Talk
  handoff?: Handoff
  log: LogLine[]
  script: Script
}

/**
 * Where a task stands: its flow `running`; every step done and `awaitMerge`, until the user merges it or
 * sends it back; `merging` while the owner merges the task's work tree into the target branch; then `done`.
 */
export type TaskStage = 'running' | 'awaitMerge' | 'merging' | 'done' | 'cancelled'

/** The owner merging a task's work tree into the company's target branch, once the user says so. */
export interface Merge {
  /** Who merges: the task's owner. */
  replicaId: string | null
  /** The target branch moved on in a way that clashes with the task's; the owner resolves it first. */
  conflict: boolean
  /** Set once the owner is free and starts; until then the merge waits for them. */
  startedAt?: number
  endsAt?: number
  log: LogLine[]
}

/** A user attachment, kept as a data URL. */
export interface Attachment {
  name: string
  url: string
}

export interface Task {
  id: string
  teamId: string
  number: number
  title: string
  description: string
  /** Pictures added with the description. */
  images: Attachment[]
  files?: Attachment[]
  workflowId: string
  /** The employee who owns the task and works its first and last steps (整理需求 and 驗收). */
  ownerId: string | null
  /** Copy of the workflow taken when the task starts. Later edits only affect new tasks. */
  workflow: Workflow
  createdAt: number
  doneAt?: number
  stage: TaskStage
  merge?: Merge
  paused: boolean
  pausedAt?: number
  pausedStatus?: Status
  /** The task's work tree branch: the owner makes it at 整理需求, every step commits to it. */
  branch: string
  budgetBonus: number
  /** Cost spent on discarded runs before a workflow change. */
  costCarry: number
  /** Tokens spent on discarded runs before a workflow change, and on resolving merge conflicts. */
  tokensCarry: number
  /** Merging will clash with the target branch (decided up front, as the rest of the fake run is). */
  mergeConflict: boolean
  overrides?: Record<string, Partial<Script>>
}

export type WorldEvent =
  | { kind: 'review'; taskId: string; subId: string }
  | { kind: 'awaitMerge'; taskId: string }
  | { kind: 'blueprintUpdated'; blueprintId: string; commit: string; auto: boolean }

/** The kind of API a model provider speaks. */
export type ProviderKind = 'anthropic' | 'openai' | 'google' | 'compatible'

/**
 * How a provider is signed in to: an API key, of which only the last four characters are kept here (to
 * tell keys apart), or the sign-in of a Claude or ChatGPT subscription (Anthropic and OpenAI only).
 */
export type ProviderAuth = { kind: 'apiKey'; keyHint: string } | { kind: 'subscription'; signedIn?: boolean; login?: LoginPrompt }

/** What the user has to do to sign in to a subscription, as the backend reports it. */
export interface LoginPrompt {
  method: 'browser' | 'device' | 'terminal'
  url?: string
  userCode?: string
  command?: string
  error?: string
}

/** Where models come from: an account with a provider, and the models it offers. */
export interface ModelProvider {
  id: string
  name: string
  kind: ProviderKind
  auth: ProviderAuth
  /** The API address; '' for the provider's own. Unused by a subscription. */
  baseUrl: string
  /** What the provider offers, as it lists them; not typed in. */
  models: string[]
  /** The thinking levels each model reports, weakest first; a model not in it reports none. */
  thinking?: Record<string, string[]>
}

export interface World {
  preferences?: Prefs
  now: number
  seq: number
  /** The language of the app and of what employees write to the user. */
  language: Locale
  teams: Record<string, Team>
  providers: Record<string, ModelProvider>
  blueprints: Record<string, Blueprint>
  replicas: Record<string, Replica>
  workflows: Record<string, Workflow>
  tasks: Record<string, Task>
  subTasks: Record<string, SubTask>
  chats: Record<string, Chat>
  nextDriftAt: number
  rng: number
  events: WorldEvent[]
}
