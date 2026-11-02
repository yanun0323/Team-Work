// Employees are always shown under their blueprint, blueprints in the order the company knows them.

import { HAIRS, SKINS } from './core/domain/sim'
import { AIRPORT_STAFF_LOOK } from './core/domain/sim'
import type { Blueprint, Chat, Look, Replica, World } from './core/domain/types'
import { tr } from './core/i18n'
import { blueprintList } from './core/model'

export function byBlueprint(w: World, crew: Replica[]): { bp: Blueprint; list: Replica[] }[] {
  return blueprintList(w)
    .map((bp) => ({ bp, list: crew.filter((r) => r.blueprintId === bp.id) }))
    .filter((g) => g.list.length > 0)
}

/**
 * Models an employee can run on: every provider's, then any other an employee already runs on (its
 * provider since removed, say), so their own stays pickable.
 */
export function modelsOf(w: World): string[] {
  return modelGroups(w).flatMap((g) => g.models)
}

/**
 * The same models under the provider each comes from. A model two providers offer sits under the first, the one its
 * thinking levels are read from, and the ones no provider offers now go last under 其他.
 */
export function modelGroups(w: World): { label: string; models: string[] }[] {
  const seen = new Set<string>()
  const fresh = (models: string[]) => models.filter((m) => !seen.has(m) && !!seen.add(m))
  const groups = Object.values(w.providers).map((p) => ({ label: p.name, models: fresh(p.models) }))
  groups.push({ label: tr('其他'), models: fresh(Object.values(w.replicas).map((r) => r.model)) })
  return groups.filter((g) => g.models.length > 0)
}

/** Leaves the level to the provider; every model takes it. */
export const DEFAULT_EFFORT = 'default'

/** Reported levels take precedence; compatible APIs without metadata get a fallback. */
export function effortsOf(w: World, model: string): string[] {
  const p = Object.values(w.providers).find((x) => x.models.includes(model))
  const levels = p?.thinking?.[model] ?? []
  return [DEFAULT_EFFORT, ...(levels.length || p?.kind !== 'compatible'
    ? levels : ['none', 'low', 'medium', 'high', 'xhigh', 'max'])]
}

const SHIRTS = [
  '#3f7fbf', '#d9644a', '#4f9a6a', '#8a5bb8', '#e0b13a', '#2f3b52', '#c94f7c', '#5fa8a0', '#eae4d6',
  '#f08a5d', '#6c8ebf', '#b5c96a', '#4a4a52', '#e86f8a',
]
const PANTS = ['#2f3542', '#3b4a6b', '#5b4a3a', '#6b6f78', '#1f2a36', '#7a6a52', '#4f6a4a', '#c8b48a', '#8a3b3b']
const EXTRAS: Look['extra'][] = ['none', 'none', 'none', 'glasses', 'cap', 'headset', 'sunglasses', 'beanie', 'bow']

/** A fresh face and figure: colours for the icon and the 3D model, plus the seed for its cut and clothes. */
export function randomLook(rand: () => number = Math.random): Look {
  const of = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]
  return {
    skin: of(SKINS), hair: of(HAIRS), shirt: of(SHIRTS), pants: of(PANTS), extra: of(EXTRAS),
    style: Math.floor(rand() * 2 ** 31),
  }
}

/** What an employee runs on, as one line: model, then how hard they think. */
export const mindOf = (r: Replica) => `${r.model} · ${r.effort}`

/**
 * What a chat runs on. A chat stays on the model it began with but keeps no level of its own: it thinks at its
 * employee's level, or the default once they have moved to another model. Nothing is known of the level of an
 * employee who has left, and their chat takes no more replies.
 */
/** What a chat on the list shows beside it; only the most pressing of these. */
export function chatSign(c: Chat) {
  return c.replyAt !== undefined ? 'replying' : c.question || c.change ? 'question' : c.unread ? 'unread' : undefined
}

export function chatMindOf(w: World, c: Chat) {
  if (!c.teamId) return `${c.model} · ${c.effort ?? DEFAULT_EFFORT}`
  const r = w.replicas[c.replicaId]
  if (!r) return c.model
  const effort = r.model === c.model && effortsOf(w, c.model).includes(r.effort) ? r.effort : DEFAULT_EFFORT
  return `${c.model} · ${effort}`
}

/** What a chat shows in lists when no one has named it. */
export const chatPreview = (c: Chat) => c.messages[0]?.text || (c.messages[0]?.images?.length ? tr('圖片') : c.messages[0]?.files?.length ? tr('附件') : '')

/** Who a chat is with: the employee as they are now, as they were if they left, or the airport staff. */
export function chatWho(w: World, c: Chat): { name: string; look: Look } {
  if (!c.teamId) return { name: tr('機場服務人員'), look: AIRPORT_STAFF_LOOK }
  const r = w.replicas[c.replicaId]
  return { name: r?.name ?? c.name, look: r?.look ?? c.look }
}

/** What the latest airport chat ran on, for a new one to start from. */
export function lastAirportMind(w: World) {
  return Object.values(w.chats).filter((c) => !c.teamId)
    .reduce<Chat | undefined>((a, c) => (!a || c.createdAt >= a.createdAt ? c : a), undefined)
}

/** Who the company's latest chat was started with, if they are still there. */
export function lastChatReplica(w: World, teamId: string): string | undefined {
  const chats = Object.values(w.chats).filter((c) => c.teamId === teamId)
  const last = chats.reduce<Chat | undefined>((a, c) => (!a || c.createdAt >= a.createdAt ? c : a), undefined)
  return last && w.replicas[last.replicaId] ? last.replicaId : undefined
}
