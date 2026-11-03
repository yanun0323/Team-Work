// What each tab of the company file needs before its work can run, and what to say about what is missing. Pure, no React.

import { listOf, tr } from './core/i18n'
import { teamReplicas } from './core/model'
import type { ModelProvider, World } from './core/domain/types'

/** What only the backend can see: the company's folder as it is now. */
export interface ProjectHealth {
  folder: boolean
  repo: boolean
  targetBranch: boolean
}

export type PrereqTab = 'chats' | 'airportChats' | 'tasks' | 'crew' | 'terminal'

export interface Prereq {
  id: string
  text: string
  /** Nothing new can start without it; otherwise it is a warning about what exists. */
  blocks: boolean
}

/** A provider that can be used: it lists models and, for a subscription, is signed in. */
const usable = (p: ModelProvider) =>
  p.models.length > 0 && (p.auth.kind !== 'subscription' || !!p.auth.signedIn)

function providers(w: World): Prereq | null {
  const all = Object.values(w.providers)
  if (!all.length) return { id: 'provider', text: tr('沒有模型供應商。請先到機場新增模型供應商'), blocks: true }
  if (!all.some(usable)) return { id: 'providerReady', text: tr('模型供應商無法使用。請先到機場登入或重新取得模型'), blocks: true }
  return null
}

/** Employees on a model no usable provider offers: it was dropped from a provider's list, or its provider was signed out of or removed. */
function stranded(w: World, teamId: string): Prereq | null {
  const offered = Object.values(w.providers).filter(usable).flatMap((p) => p.models)
  const names = teamReplicas(w, teamId).filter((r) => !offered.includes(r.model)).map((r) => r.name)
  if (!names.length) return null
  return { id: 'crewModel', text: tr('{a} 的模型無法使用。請先更換模型，或到機場檢查模型供應商', { a: listOf(names) }), blocks: false }
}

const folder = (h: ProjectHealth | null): Prereq | null =>
  (h && !h.folder ? { id: 'folder', text: tr('找不到專案資料夾。請把資料夾放回原位'), blocks: true } : null)

/** Tasks work in branches of the repo and merge into the target branch. */
const repo = (w: World, teamId: string, h: ProjectHealth | null): Prereq | null => {
  if (!h?.folder) return null
  if (!h.repo) return { id: 'repo', text: tr('專案資料夾不是 git repo。請先在終端機執行 git init'), blocks: true }
  if (!h.targetBranch) return { id: 'targetBranch', text: tr('找不到目標分支 {targetBranch}。請先到「設定」頁籤更換目標分支', { targetBranch: w.teams[teamId]?.targetBranch }), blocks: true }
  return null
}

/** What is missing for a tab, in the order to deal with it. `health` is null until it is known. */
export function prereqsOf(w: World, teamId: string, tab: PrereqTab, health: ProjectHealth | null): Prereq[] {
  const provider = providers(w)
  // with no provider at all, that is the thing to fix and not each employee's model
  const models = provider ? null : stranded(w, teamId)
  const noCrew: Prereq | null = teamReplicas(w, teamId).length ? null : { id: 'crew', text: tr('沒有員工。請先新增員工'), blocks: true }
  const list = {
    chats: [provider, noCrew, models, folder(health)],
    airportChats: [provider],
    tasks: [
      provider, noCrew,
      Object.keys(w.workflows).length ? null : { id: 'workflow', text: tr('沒有任務流程。請先到機場新增任務流程'), blocks: true },
      models, folder(health), repo(w, teamId, health),
    ],
    crew: [
      provider,
      Object.keys(w.blueprints).length ? null : { id: 'blueprint', text: tr('沒有員工藍圖。請先到機場新增員工藍圖'), blocks: true },
      models,
    ],
    terminal: [folder(health)],
  }[tab]
  return list.filter((x): x is Prereq => !!x)
}

export const blocked = (list: Prereq[]) => list.some((x) => x.blocks)
