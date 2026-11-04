// The tutorial: steps that teach the app by doing it, listed beside the clock on the main screen. Which steps
// there are and when each is met is decided here; the backend only keeps the lists in tutorial.yaml.

import { request } from './core/backend'
import type { Key } from './core/i18n'
import { isPreset } from './core/data/presets'
import type { TutorialState, World } from './core/domain/types'
import { MOCK } from './core/mode'
import { attempt } from './core/ops'
import { useStore } from './core/store'
import type { AirportTab } from './prefs'
import type { Tab as CompanyTab } from './DrawerTabs'

/** Where a step takes the user when they click it. */
export type TutorialGoal =
  | { kind: 'help' }
  | { kind: 'newCompany' }
  | { kind: 'airport'; tab: AirportTab }
  | { kind: 'company'; tab?: CompanyTab }

export interface TutorialStep {
  id: string
  /** What to do, in one line. */
  text: Key
  /** Steps that must be done before this one shows. */
  after: string[]
  /** Met by what is in the world; steps without it are met by an action of the same id. */
  met?: (w: World) => boolean
  goal: TutorialGoal
}

const some = <T,>(book: Record<string, T>, ok: (x: T) => boolean) => Object.values(book).some(ok)
const DEFAULT_COST_LIMIT = 3

/** In the order they are suggested; the list shows the first ones not done. */
export const STEPS: TutorialStep[] = [
  { id: 'help', text: '打開說明頁', after: [], goal: { kind: 'help' } },
  { id: 'provider', text: '到機場新增模型供應商', after: ['help'], met: (w) => Object.keys(w.providers).length > 0, goal: { kind: 'airport', tab: 'providers' } },
  { id: 'company', text: '新增一間公司', after: ['provider'], met: (w) => Object.keys(w.teams).length > 0, goal: { kind: 'newCompany' } },
  { id: 'airportChat', text: '到機場找機場服務人員聊天', after: ['provider'], met: (w) => some(w.chats, (c) => !c.teamId), goal: { kind: 'airport', tab: 'chats' } },
  { id: 'globalAgents', text: '到機場 > 設定填寫全域 AGENTS.md', after: ['provider'], goal: { kind: 'airport', tab: 'prefs' } },
  { id: 'sound', text: '到機場 > 設定調整音樂或音效', after: ['provider'], goal: { kind: 'airport', tab: 'prefs' } },
  { id: 'hire', text: '新增一個員工', after: ['company'], met: (w) => Object.keys(w.replicas).length > 0, goal: { kind: 'company', tab: 'crew' } },
  { id: 'openFolder', text: '從公司的資料夾按鈕打開 Finder', after: ['company'], goal: { kind: 'company' } },
  { id: 'costLimit', text: '設定公司的任務費用上限', after: ['company'], met: (w) => some(w.teams, (t) => t.settings.costLimitUsd !== DEFAULT_COST_LIMIT), goal: { kind: 'company', tab: 'settings' } },
  { id: 'chat', text: '跟員工聊天', after: ['hire'], met: (w) => some(w.chats, (c) => !!c.teamId), goal: { kind: 'company', tab: 'chats' } },
  { id: 'copyBlueprint', text: '複製一個員工藍圖並且修改', after: ['hire'], goal: { kind: 'airport', tab: 'blueprints' } },
  { id: 'hireCopied', text: '用修改過的藍圖再新增一位員工', after: ['copyBlueprint'], met: (w) => some(w.replicas, (r) => !isPreset(r.blueprintId) && w.blueprints[r.blueprintId]?.source.kind === 'yaml'), goal: { kind: 'company', tab: 'crew' } },
  { id: 'mention', text: '在對話中用 # 引用一個檔案', after: ['chat'], met: (w) => some(w.chats, (c) => !!c.teamId && c.messages.some((m) => m.from === 'user' && /(^|\s)#\S/.test(m.text))), goal: { kind: 'company', tab: 'chats' } },
  { id: 'attach', text: '在對話中加入附件或貼上截圖', after: ['chat'], met: (w) => some(w.chats, (c) => c.messages.some((m) => m.from === 'user' && !!(m.images?.length || m.files?.length))), goal: { kind: 'company', tab: 'chats' } },
  { id: 'queue', text: '員工回覆時再送一則訊息', after: ['chat'], goal: { kind: 'company', tab: 'chats' } },
  { id: 'fork', text: '從某則訊息把對話交給員工', after: ['chat'], goal: { kind: 'company', tab: 'chats' } },
  { id: 'chatTask', text: '把對話整理成任務', after: ['chat'], met: (w) => some(w.tasks, (t) => t.origin?.kind === 'chat') || tutorialOf(w).actions.includes('chatTask'), goal: { kind: 'company', tab: 'chats' } },
  { id: 'task', text: '新增一個任務', after: ['chat'], met: (w) => Object.keys(w.tasks).length > 0, goal: { kind: 'company', tab: 'tasks' } },
  { id: 'review', text: '審核一次子任務', after: ['task'], goal: { kind: 'company', tab: 'tasks' } },
  { id: 'pause', text: '暫停一個任務再恢復', after: ['task'], goal: { kind: 'company', tab: 'tasks' } },
  { id: 'terminal', text: '打開公司的終端機', after: ['task'], goal: { kind: 'company', tab: 'terminal' } },
  { id: 'merge', text: '合併一個任務', after: ['task'], met: (w) => some(w.tasks, (t) => t.stage === 'done'), goal: { kind: 'company', tab: 'tasks' } },
  { id: 'copyFlow', text: '複製一個任務藍圖並且修改', after: ['task'], goal: { kind: 'airport', tab: 'flows' } },
  { id: 'ownFlowTask', text: '用自己的任務藍圖建立任務', after: ['copyFlow'], met: (w) => some(w.tasks, (t) => !isPreset(t.workflowId)), goal: { kind: 'company', tab: 'tasks' } },
]

export const EMPTY_TUTORIAL: TutorialState = { seeded: false, hidden: false, done: [], shown: [], played: [], actions: [] }

export const isMet = (step: TutorialStep, w: World, t: TutorialState) => (step.met ? step.met(w) : t.actions.includes(step.id))

/** Steps met now and not yet put down as done. */
export const newlyMet = (w: World, t: TutorialState) => STEPS.filter((s) => !t.done.includes(s.id) && isMet(s, w, t)).map((s) => s.id)

/** Steps whose earlier steps are all done. */
const open = (t: TutorialState) => STEPS.filter((s) => s.after.every((id) => t.done.includes(id)))

/**
 * What the list holds: steps open and not done, and done steps whose tick has yet to play. A step done before it
 * was ever shown is `quiet`: it goes without a tick, since the user never saw it to cross it off.
 */
export function listed(t: TutorialState) {
  const items = open(t).filter((s) => !t.played.includes(s.id))
  return {
    items: items.filter((s) => !t.done.includes(s.id) || t.shown.includes(s.id)),
    quiet: items.filter((s) => t.done.includes(s.id) && !t.shown.includes(s.id)).map((s) => s.id),
  }
}

/** The first run: what is met already is done, shown and played, so an old hand starts without a burst of ticks. */
export function seed(w: World, t: TutorialState) {
  const done = STEPS.filter((s) => t.done.includes(s.id) || isMet(s, w, t)).map((s) => s.id)
  const next = { ...t, done }
  const shown = [...done, ...listed(next).items.map((s) => s.id)]
  return { seeded: true, done, shown, played: done }
}

export interface TutorialPatch {
  /** Empties it first, to start over. */
  reset?: boolean
  seeded?: boolean
  hidden?: boolean
  done?: string[]
  shown?: string[]
  played?: string[]
  actions?: string[]
}

export const tutorialOf = (w: World) => w.tutorial ?? EMPTY_TUTORIAL

const union = (a: string[], b: string[] = []) => [...a, ...b.filter((x) => !a.includes(x))]

/** Adds to the tutorial's lists. The screen follows at once; the backend's answer arrives as the same change. */
export function updateTutorial(p: TutorialPatch) {
  useStore.setState((s) => {
    const t = p.reset || !s.world.tutorial ? { ...EMPTY_TUTORIAL } : s.world.tutorial
    s.world.tutorial = {
      seeded: p.seeded ?? t.seeded, hidden: p.hidden ?? t.hidden,
      done: union(t.done, p.done), shown: union(t.shown, p.shown), played: union(t.played, p.played), actions: union(t.actions, p.actions),
    }
  })
  if (!MOCK) void attempt(() => request('PATCH', '/tutorial', p))
}

// The tab a clicked step wants the airport or a company to open on; the page takes it as it opens.
let airportTab: AirportTab | null = null
let companyTab: CompanyTab | null = null
export const askTab = (goal: TutorialGoal) => {
  airportTab = goal.kind === 'airport' ? goal.tab : null
  companyTab = goal.kind === 'company' ? goal.tab ?? null : null
}
export const takeAirportTab = () => { const t = airportTab; airportTab = null; return t }
export const takeCompanyTab = () => { const t = companyTab; companyTab = null; return t }

/** The company used last, for steps that need one. */
const LAST_TEAM = 'tutorial.lastTeam'
export const rememberTeam = (id: string) => { try { localStorage.setItem(LAST_TEAM, id) } catch { /* private mode */ } }
export function lastTeam(w: World) {
  let id: string | null = null
  try { id = localStorage.getItem(LAST_TEAM) } catch { /* private mode */ }
  return id && w.teams[id] ? id : Object.keys(w.teams)[0] ?? null
}

/** Records something the user did that leaves nothing in the world to show for it. */
export function learn(action: string) {
  if (!tutorialOf(useStore.getState().world).actions.includes(action)) updateTutorial({ actions: [action] })
}
