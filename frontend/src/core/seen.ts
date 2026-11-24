// Ghost companies' chats read on this computer. A chat's unread mark lives on its company's own computer, which keeps
// it for that computer's own user, so what was read here through a ghost company is kept here: each chat, with how many
// messages it had when read. Until it has more, it no longer counts as unread on this island (its list, the name tag
// and the Dock badge).

import { create } from 'zustand'
import type { Chat } from './domain/types'

const KEY = 'team-work.ghost-seen'

/** `peer id \0 chat id` to how many messages the chat had when read here. */
type Seen = Record<string, number>

function load(): Seen {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    return v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).filter(([, n]) => typeof n === 'number')) as Seen
      : {}
  } catch {
    return {}
  }
}

export const useSeen = create<Seen>(() => load())

function keep(next: Seen) {
  useSeen.setState(next, true)
  try { localStorage.setItem(KEY, JSON.stringify(next)) } catch { /* private mode, or no storage */ }
}

const keyOf = (peerId: string, chatId: string) => `${peerId}\u0000${chatId}`
const said = (c: Chat) => c.history?.count ?? c.messages?.length ?? 0

/** Keeps that a paired computer's chat was read here, as it is now. */
export function markSeen(peerId: string, chat: Chat) {
  const key = keyOf(peerId, chat.id)
  const n = said(chat)
  if (useSeen.getState()[key] !== n) keep({ ...useSeen.getState(), [key]: n })
}

/** The unread chats among a paired computer's `chats` that were read here, with nothing new since. */
export function seenChats(peerId: string, chats: Record<string, Chat>, seen: Seen = useSeen.getState()): string[] {
  return Object.values(chats).filter((c) => c.unread && (seen[keyOf(peerId, c.id)] ?? -1) >= said(c)).map((c) => c.id)
}

/** Lets go of what was kept for a paired computer's chats it no longer has unread: its own mark says enough then. */
export function forgetSeen(peerId: string, chats: Record<string, Chat>) {
  const seen = useSeen.getState()
  const prefix = keyOf(peerId, '')
  const stale = Object.keys(seen).filter((k) => k.startsWith(prefix) && !chats[k.slice(prefix.length)]?.unread)
  if (stale.length) keep(Object.fromEntries(Object.entries(seen).filter(([k]) => !stale.includes(k))))
}
