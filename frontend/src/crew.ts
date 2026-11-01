// Employees are always shown under their blueprint, blueprints in the order the company knows them.

import { HAIRS, SKINS } from './core/domain/sim'
import type { Blueprint, Chat, Look, Replica, World } from './core/domain/types'
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
  const offered = Object.values(w.providers).flatMap((p) => p.models)
  return [...new Set([...offered, ...Object.values(w.replicas).map((r) => r.model)])]
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
export function chatMindOf(w: World, c: Chat) {
  const r = w.replicas[c.replicaId]
  if (!r) return c.model
  const effort = r.model === c.model && effortsOf(w, c.model).includes(r.effort) ? r.effort : DEFAULT_EFFORT
  return `${c.model} · ${effort}`
}

/** Who the company's latest chat was started with, if they are still there. */
export function lastChatReplica(w: World, teamId: string): string | undefined {
  const chats = Object.values(w.chats).filter((c) => c.teamId === teamId)
  const last = chats.reduce<Chat | undefined>((a, c) => (!a || c.createdAt >= a.createdAt ? c : a), undefined)
  return last && w.replicas[last.replicaId] ? last.replicaId : undefined
}
