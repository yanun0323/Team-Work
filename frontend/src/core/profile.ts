// The user's own profile: their milestones on this computer's island, and the look they wear until they pick one.
// Always this computer's, whichever island is shown.

import { mockStats, type UsageTotals } from '../Stats'
import { WARDROBE, seedOf } from '../figureStyle'
import { localRequest } from './backend'
import type { Look, World } from './domain/types'
import { MOCK } from './mode'
import { useStore } from './store'

export interface ProfilePartner { id: string; name: string; look: Look; count: number }

export interface ProfileStats {
  /** When the island first saw use, in Unix seconds; 0 before it has. */
  since: number
  tasksDone: number
  chats: number
  /** What the user said in chats. */
  messages: number
  /** The employee worked with most: chats with them and steps they finished. */
  partner?: ProfilePartner
  usage: UsageTotals
}

/** The milestones as the simulator's world has them. */
export function mockProfileStats(w: World): ProfileStats {
  const together = new Map<string, number>()
  const bump = (id: string | null | undefined) => { if (id && w.replicas[id]) together.set(id, (together.get(id) ?? 0) + 1) }
  const chats = Object.values(w.chats)
  for (const s of Object.values(w.subTasks)) if (s.status === 'complete' && !s.skipped && !s.cancelled) bump(s.replicaId)
  for (const c of chats) bump(c.replicaId)
  let partner: ProfilePartner | undefined
  for (const [id, count] of together) {
    const r = w.replicas[id]
    if (!partner || count > partner.count) partner = { id, name: r.name, look: r.look, count }
  }
  const starts = [...Object.values(w.tasks).map((t) => t.createdAt), ...chats.flatMap((c) => c.messages.map((m) => m.at))].filter((t) => t > 0)
  return {
    // the simulator keeps its own clock: as long ago as that, from now
    since: starts.length ? Date.now() / 1000 - (w.now - Math.min(...starts)) : 0,
    tasksDone: Object.values(w.tasks).filter((t) => t.stage === 'done').length,
    chats: chats.length,
    messages: chats.reduce((n, c) => n + c.messages.filter((m) => m.from === 'user').length, 0),
    partner,
    usage: mockStats(w, 'all', 0).total,
  }
}

export const readProfileStats = (signal?: AbortSignal): Promise<ProfileStats> => (MOCK
  ? Promise.resolve(mockProfileStats(useStore.getState().world))
  : localRequest<ProfileStats>('GET', '/profile/stats', undefined, signal))

/** The person at a computer as they look now: as they picked, or as they look before picking. */
export const lookOf = (me: { id: string; look?: Look }) => me.look ?? defaultLook(me.id)

/** How the person at a computer looks before they pick: steady for its id, from the newest wardrobe. */
export function defaultLook(id: string): Look {
  const n = seedOf(id || 'me')
  const of = <T,>(xs: readonly T[], k: number) => xs[Math.floor(n / k) % xs.length]
  return {
    skin: of(['#f2c9a0', '#e0ac7e', '#c68a5a', '#8d5a3b', '#f6d7b8'], 1),
    hair: of(['#2b1d14', '#5a3a22', '#c99a4a', '#1c1c1c', '#8a3b2a'], 5),
    shirt: of(['#3f7fbf', '#d9644a', '#4f9a6a', '#8a5bb8', '#e0b13a'], 25),
    pants: of(['#2f3542', '#3b4a6b', '#5b4a3a', '#6b6f78'], 125),
    extra: 'none', style: n, wardrobe: WARDROBE,
  }
}
