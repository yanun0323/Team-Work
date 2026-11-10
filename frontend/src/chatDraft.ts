// What is written in a chat's message box but not yet sent, kept while the sheet is closed so a stray click on the
// map loses nothing. Only in memory: it goes when the app does.

import { useState, type SetStateAction } from 'react'
import type { Attachment } from './core/domain/types'
import { islandScope } from './core/island'

export interface ChatDraft {
  text: string
  images: Attachment[]
}

const EMPTY: ChatDraft = { text: '', images: [] }
const drafts = new Map<string, ChatDraft>()

/** The draft for a chat, or for a new one in a company ('' for the airport), on the island shown. */
export const draftKey = (chatId: string | undefined, teamId: string) => islandScope(chatId ?? `new:${teamId}`)

export const readDraft = (key: string): ChatDraft => drafts.get(key) ?? EMPTY

/** Keeps the draft; an empty one is dropped. */
export function saveDraft(key: string, draft: ChatDraft) {
  if (draft.text || draft.images.length) drafts.set(key, draft)
  else drafts.delete(key)
}

const apply = <T,>(next: SetStateAction<T>, now: T) => (typeof next === 'function' ? (next as (now: T) => T)(now) : next)

/** The message box's text and attachments, read from and written to the kept draft for key. */
export function useChatDraft(key: string) {
  const [state, setState] = useState(() => ({ key, ...readDraft(key) }))
  // the sheet can turn to another chat without being made again
  if (state.key !== key) setState({ key, ...readDraft(key) })
  const current = state.key === key ? state : { key, ...readDraft(key) }
  // a setter writes to the chat it was made for, even if the sheet has turned to another since
  const update = (f: (d: ChatDraft) => ChatDraft) => setState((prev) => {
    const next = f(prev.key === key ? prev : readDraft(key))
    saveDraft(key, next)
    return prev.key === key ? { key, ...next } : prev
  })
  return {
    text: current.text,
    images: current.images,
    setText: (next: SetStateAction<string>) => update((d) => ({ ...d, text: apply(next, d.text) })),
    setImages: (next: SetStateAction<Attachment[]>) => update((d) => ({ ...d, images: apply(next, d.images) })),
  }
}
