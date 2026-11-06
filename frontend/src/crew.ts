// Employees are always shown under their blueprint, blueprints in the order the company knows them; those with settings
// of their own come first, together.

import { HAIRS, SKINS } from './core/domain/sim'
import { AIRPORT_STAFF_LOOK } from './core/domain/sim'
import type { Blueprint, Chat, Look, ModelProvider, Replica, World } from './core/domain/types'
import { tr } from './core/i18n'
import { blueprintList } from './core/model'
import { softLean, WARDROBE } from './figureStyle'

/**
 * The groups, `bp` null for those with settings of their own; those whose blueprint is gone come first, `gone`, as
 * they wait for another to be picked.
 */
export function byBlueprint(w: World, crew: Replica[]): { bp: Blueprint | null; gone?: true; list: Replica[] }[] {
  const gone = { bp: null, gone: true as const, list: crew.filter((r) => blueprintGone(w, r)) }
  const custom = { bp: null, list: crew.filter((r) => isCustom(w, r)) }
  return [gone, custom, ...blueprintList(w).map((bp) => ({ bp, list: crew.filter((r) => r.blueprintId === bp.id) }))]
    .filter((g) => g.list.length > 0)
}

/** Whether an employee works by settings of their own rather than a blueprint. */
export const isCustom = (w: World, r: Replica) => w.blueprints[r.blueprintId]?.owner === r.id

/** Whether an employee's blueprint is gone, so they work no more until another is picked. */
export const blueprintGone = (w: World, r: Replica) => !w.blueprints[r.blueprintId]

/** What an employee works by, as shown beside their name: their blueprint, 自訂, or that it is gone. */
export function blueprintLabel(w: World, r: Replica): string {
  if (blueprintGone(w, r)) return tr('藍圖已不存在')
  return isCustom(w, r) ? tr('自訂') : w.blueprints[r.blueprintId].name
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

/** What a provider's models can read when it has no size of its own and none was set. */
export const CONTEXT_UNKNOWN = 128_000

/** How many tokens a provider's models can read: Anthropic's and OpenAI's are fixed, the others' are set by the user. */
export function providerWindow(p: Pick<ModelProvider, 'kind' | 'contextWindow'>): number {
  if (p.kind === 'anthropic') return 1_000_000
  if (p.kind === 'openai') return 272_000
  return p.contextWindow || CONTEXT_UNKNOWN
}

/** How many tokens a model can read, from the provider the backend runs it on: the one with the shortest id. */
export function contextWindowOf(w: World, model: string): number {
  const p = providerOf(w, model)
  return p ? providerWindow(p) : CONTEXT_UNKNOWN
}

/** The provider the backend runs a model on: of those offering it, the one with the shortest id. */
export const providerOf = (w: World, model: string): ModelProvider | undefined =>
  Object.values(w.providers).filter((x) => x.models.includes(model))
    .sort((a, b) => a.id.length - b.id.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0]

/** Each kind's stretch of the colour wheel (OKLCH hue); green is left out, being the user's own notes. */
const KIND_HUES: Partial<Record<ModelProvider['kind'], number>> = { anthropic: 55, openai: 195, google: 255 }
/** The stretches compatible providers take in turn, by id. */
const COMPATIBLE_HUES = [95, 345, 305]
/** How far the 2nd and 3rd of a group step off its hue; the 4th starts over. Stretches lie 40 apart, so groups stay clear. */
export const HUE_STEPS = [0, 12, -12]

/**
 * The colour group a provider belongs to and the hue at its centre, the same in chats and on the usage tab: one
 * group per kind, each compatible provider a group of its own. None for a provider no longer there.
 */
export function providerHue(providers: World['providers'], id: string | undefined): { group: string; hue: number } | undefined {
  const p = id ? providers[id] : undefined
  if (!p) return undefined
  const hue = KIND_HUES[p.kind]
  if (hue !== undefined) return { group: p.kind, hue }
  // placed among every compatible provider, not just those in sight, so one keeps its place wherever it shows
  const at = Object.values(providers).filter((x) => x.kind === 'compatible').map((x) => x.id).sort().indexOf(p.id)
  return { group: `compatible:${p.id}`, hue: COMPATIBLE_HUES[at % COMPATIBLE_HUES.length] }
}

/** Sorts ids into their providers' groups, each list by id; those with no provider go under no hue. */
export function hueGroups(providers: World['providers'], list: { id: string; providerId?: string }[]) {
  const groups = new Map<string, { hue?: number; ids: string[] }>()
  const seen = new Set<string>()
  for (const { id, providerId } of list) {
    if (seen.has(id)) continue
    seen.add(id)
    const h = providerHue(providers, providerId)
    const key = h?.group ?? ''
    if (!groups.has(key)) groups.set(key, { hue: h?.hue, ids: [] })
    groups.get(key)!.ids.push(id)
  }
  for (const g of groups.values()) g.ids.sort()
  return [...groups.values()]
}

/** The least anyone in a chat can read, each on the model they joined with; the chat is summed up to fit it. */
export const chatWindow = (w: World, c: Chat) =>
  Math.min(...[c.model, ...(c.guests ?? []).map((g) => g.model)].map((m) => contextWindowOf(w, m)))

export const SHIRTS = [
  '#3f7fbf', '#d9644a', '#4f9a6a', '#8a5bb8', '#e0b13a', '#2f3b52', '#c94f7c', '#5fa8a0', '#eae4d6',
  '#f08a5d', '#6c8ebf', '#b5c96a', '#4a4a52', '#e86f8a',
]
const PANTS = ['#2f3542', '#3b4a6b', '#5b4a3a', '#6b6f78', '#1f2a36', '#7a6a52', '#4f6a4a', '#c8b48a', '#8a3b3b']
/** What people wear on their heads, by which way their look leans (`softLean`); most wear nothing. */
const SOFT_EXTRAS: Look['extra'][] = ['none', 'none', 'none', 'none', 'glasses', 'sunglasses', 'beanie', 'bow', 'strawhat', 'beret', 'headband', 'hairclip', 'flower', 'headset']
const SHARP_EXTRAS: Look['extra'][] = ['none', 'none', 'none', 'none', 'glasses', 'cap', 'headset', 'sunglasses', 'beanie', 'strawhat', 'beret', 'bandana']

/**
 * A fresh face and figure: colours for the icon and the 3D model, plus the seed for its cut and clothes, from the
 * newest wardrobe.
 */
export function randomLook(rand: () => number = Math.random): Look {
  const of = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]
  const style = Math.floor(rand() * 2 ** 31)
  return {
    skin: of(SKINS), hair: of(HAIRS), shirt: of(SHIRTS), pants: of(PANTS), extra: of(softLean(style) ? SOFT_EXTRAS : SHARP_EXTRAS),
    style, wardrobe: WARDROBE,
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

/** When a chat last moved up the list: a reply under way waits to finish, so only the user's own message counts; a copy made of a chat starts on top, though its messages are older. */
export function chatSortAt(c: Chat) {
  const counted = c.replyAt === undefined ? c.messages : c.messages.filter((m) => m.from === 'user')
  return Math.max(counted[counted.length - 1]?.at ?? c.createdAt, c.createdAt)
}

/** The chat list's order: the pinned first, the latest pinned on top, then the rest by their latest activity. */
export function chatOrder(a: Chat, b: Chat) {
  if (a.pinnedAt !== undefined || b.pinnedAt !== undefined) return (b.pinnedAt ?? -Infinity) - (a.pinnedAt ?? -Infinity)
  return chatSortAt(b) - chatSortAt(a)
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

/** Everyone in a chat as they are now, or were if they left: its chair first, then the guests in the order they joined. */
export function chatPeople(w: World, c: Chat): { id: string; name: string; look: Look }[] {
  const chair = { id: c.replicaId, ...chatWho(w, c) }
  return [chair, ...(c.guests ?? []).map((g) => {
    const r = w.replicas[g.replicaId]
    return { id: g.replicaId, name: r?.name ?? g.name, look: r?.look ?? g.look }
  })]
}

/** What one employee in a chat runs on: the chair as chatMindOf says, a guest on the model they joined with, at their level when they still run on it. */
export function personMindOf(w: World, c: Chat, id: string) {
  if (id === c.replicaId) return chatMindOf(w, c)
  const g = c.guests?.find((x) => x.replicaId === id)
  if (!g) return ''
  const r = w.replicas[id]
  if (!r) return g.model
  const effort = r.model === g.model && effortsOf(w, g.model).includes(r.effort) ? r.effort : DEFAULT_EFFORT
  return `${g.model} · ${effort}`
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

/** A note's lightness and chroma by its place in its group, the hue stepping as HUE_STEPS. */
const NOTE_SHADES = [[0.92, 0.06], [0.87, 0.07], [0.95, 0.05]]

const noteGroups = (w: World, people: { id: string; model?: string }[]) =>
  hueGroups(w.providers, people.map(({ id, model }) => ({ id, providerId: model ? providerOf(w, model)?.id : undefined })))

/**
 * Each employee's note colour, from the provider their model runs on: their group's hue, and when the chat has more
 * of that group, a step off it by their place among them by id. Whoever chairs or speaks first makes no difference.
 * A model no provider offers is on a white note.
 */
export function noteColors(w: World, people: { id: string; model?: string }[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const { hue, ids } of noteGroups(w, people)) {
    ids.forEach((id, i) => {
      const [l, c] = NOTE_SHADES[i % NOTE_SHADES.length]
      out[id] = hue === undefined ? 'var(--note-fixed)' : `oklch(${l} ${c} ${hue + HUE_STEPS[i % HUE_STEPS.length]})`
    })
  }
  return out
}

/** Those in a group of four or more, whose colours come round again: their notes carry their name. */
export function namedNotes(w: World, people: { id: string; model?: string }[]): Set<string> {
  return new Set(noteGroups(w, people).filter((g) => g.ids.length > NOTE_SHADES.length).flatMap((g) => g.ids))
}

/** Who is in a chat on which model: the chair on the chat's, a guest on the one they joined with, those who left too. */
export const chatModels = (c: Chat) => [{ id: c.replicaId, model: c.model }, ...(c.guests ?? []).map((g) => ({ id: g.replicaId, model: g.model }))]
