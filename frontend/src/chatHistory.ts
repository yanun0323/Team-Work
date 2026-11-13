// History lives only in its open sheet; summaries in world never hold loaded pages.
import { useEffect, useRef, useState } from 'react'
import { request } from './core/backend'
import { useStore } from './core/store'
import type { Chat, ChatHandoff, ChatJoin, ChatMessage } from './core/domain/types'

export interface ChatPage {
  version: string
  start: number
  total: number
  messages: ChatMessage[]
  handoffs: ChatHandoff[] | null
  joins: ChatJoin[] | null
}
interface Loaded extends ChatPage { id: string; snapshot: number }

async function readPage(id: string, version: string, before: number, limit: number, signal: AbortSignal) {
  const page = await request<ChatPage>('GET', `/chats/${encodeURIComponent(id)}/messages?before=${before}&limit=${limit}&version=${encodeURIComponent(version)}`, undefined, signal)
  if (page.version !== version || page.start !== Math.max(0, before - limit) || page.total < before || !Array.isArray(page.messages) || page.messages.length !== before - page.start) {
    throw new Error('Invalid history page')
  }
  return page
}

type Links = Map<string, { previous: string; changedFrom: number }>

/** From which message on the history may differ between two versions, by the summaries seen in between; 0 when one
 * of them was missed. */
function changedSince(links: Links, from: string, to: string) {
  let at = Infinity
  for (let v = to, steps = 0; v !== from; steps++) {
    const link = links.get(v)
    // a history can come back to an earlier version, so a walk longer than the links goes round in circles
    if (!link || steps > links.size) return 0
    at = Math.min(at, link.changedFrom)
    v = link.previous
  }
  return at
}

export function useChatHistory(summary: Chat | undefined) {
  const snapshot = useStore((s) => s.snapshot)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [retry, setRetry] = useState(0)
  const current = useRef(summary)
  current.current = summary
  const saved = useRef(loaded)
  saved.current = loaded
  const earlierRequest = useRef<AbortController | null>(null)
  // each summary says what it changed from the one before; several can come while a page is read
  const links = useRef<Links>(new Map())
  const told = summary?.history
  if (told?.previous) links.current.set(told.version, { previous: told.previous, changedFrom: told.changedFrom })
  const id = summary?.id
  const version = summary?.history?.version
  useEffect(() => {
    earlierRequest.current?.abort()
    const abort = new AbortController()
    const c = current.current
    if (!c?.history) { setLoaded(null); setError(''); setBusy(false); return }
    const h = c.history
    // a reconnect may have missed changes, so its pages are all read again
    const previous = saved.current?.id === c.id && saved.current.snapshot === snapshot ? saved.current : null
    if (previous?.version === h.version) { setBusy(false); setError(''); return () => earlierRequest.current?.abort() }
    // the messages before keep are as shown, so only those after are read; the last one is read at least, for a
    // history that only got shorter
    const keep = previous ? Math.min(changedSince(links.current, previous.version, h.version), previous.total, h.count - 1) : -1
    const retained = previous && keep > previous.start ? previous : null
    // else as many of the newest as were shown are read again, 100 at least
    const floor = retained ? keep : Math.max(0, h.count - Math.max(100, previous ? previous.total - previous.start : 0))
    setBusy(true)
    setError('')
    void (async () => {
      let before = h.count
      const pages: ChatPage[] = []
      do {
        const page = await readPage(c.id, h.version, before, Math.min(100, Math.max(1, before - floor)), abort.signal)
        pages.unshift(page)
        before = page.start
      } while (before > floor)
      if (abort.signal.aborted || current.current?.history?.version !== h.version) return
      const head = pages[0]
      const messages = pages.flatMap((p) => p.messages)
      const handoffs = pages.flatMap((p, i) => (p.handoffs ?? []).filter((h) => i === pages.length - 1 || h.before < pages[i + 1].start))
      const joins = pages.flatMap((p, i) => (p.joins ?? []).filter((j) => i === pages.length - 1 || j.before < pages[i + 1].start))
      if (retained) {
        messages.unshift(...retained.messages.slice(0, keep - retained.start))
        handoffs.unshift(...(retained.handoffs ?? []).filter((x) => x.before < keep))
        joins.unshift(...(retained.joins ?? []).filter((x) => x.before < keep))
      }
      setLoaded({ snapshot, id: c.id, version: h.version, total: h.count, start: retained?.start ?? head.start, messages, handoffs, joins })
    })().catch((e: Error) => {
      if (!abort.signal.aborted) setError(e.message)
    }).finally(() => { if (!abort.signal.aborted) setBusy(false) })
    return () => { abort.abort(); earlierRequest.current?.abort() }
  }, [id, version, retry, snapshot])

  const valid = !!summary?.history && !!loaded && loaded.id === id && loaded.snapshot === snapshot && loaded.version === version
  // What is shown stays while a newer version is read, so the list never empties under the reader; index-based
  // actions wait until it is current.
  const display = !!summary?.history && !!loaded && loaded.id === id
  const start = display && loaded ? loaded.start : summary?.history?.count ?? 0
  const more = async () => {
    if (!valid || busy || !loaded || !summary?.history || loaded.start === 0) return false
    const abort = new AbortController()
    earlierRequest.current?.abort()
    earlierRequest.current = abort
    setBusy(true); setError('')
    try {
      const page = await readPage(loaded.id, loaded.version, loaded.start, 100, abort.signal)
      if (abort.signal.aborted || current.current?.history?.version !== loaded.version) return false
      setLoaded({ ...loaded, start: page.start, messages: [...page.messages, ...loaded.messages],
        handoffs: [...(page.handoffs ?? []).filter((x) => x.before < loaded.start), ...(loaded.handoffs ?? [])],
        joins: [...(page.joins ?? []).filter((x) => x.before < loaded.start), ...(loaded.joins ?? [])] })
      return true
    } catch (e) {
      if (!abort.signal.aborted) setError((e as Error).message)
      return false
    } finally { if (!abort.signal.aborted) setBusy(false) }
  }
  const chat: Chat | undefined = !summary?.history ? summary : { ...summary,
    messages: display && loaded ? loaded.messages : [],
    handoffs: display && loaded ? (loaded.handoffs ?? []).map((h) => ({ ...h, before: h.before - start })) : [],
    joins: display && loaded ? (loaded.joins ?? []).map((j) => ({ ...j, before: j.before - start })) : [],
  }
  return { chat, start, busy, error, more, ready: !summary?.history || valid, retry: () => { if (valid) void more(); else setRetry((n) => n + 1) } }
}
