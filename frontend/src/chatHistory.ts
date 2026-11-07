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
  const id = summary?.id
  const version = summary?.history?.version
  useEffect(() => {
    earlierRequest.current?.abort()
    const abort = new AbortController()
    const c = current.current
    if (!c?.history) { setLoaded(null); setError(''); setBusy(false); return }
    const h = c.history
    const previous = saved.current?.snapshot === snapshot ? saved.current : null
    // Only an explicitly contiguous transition can reuse pages. Reconnects and skipped versions re-read them.
    const keep = previous?.id === c.id && previous.version === h.previous && h.changedFrom >= previous.start
      ? Math.min(h.changedFrom, previous.total, h.count) : h.count
    const retained = previous?.id === c.id && keep < h.count && previous.version === h.previous && keep >= previous.start
      ? previous : null
    if (previous?.id === c.id && previous.version === h.version) { setBusy(false); setError(''); return () => earlierRequest.current?.abort() }
    setBusy(true)
    setError('')
    void (async () => {
      let before = h.count
      const pages: ChatPage[] = []
      do {
        const page = await readPage(c.id, h.version, before, retained ? Math.min(100, Math.max(1, before - keep)) : 100, abort.signal)
        pages.unshift(page)
        before = page.start
      } while (retained && before > keep)
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
  // Keep an unchanged prefix visible while fetching an append, but disable index-based actions until current.
  const display = valid || (!!loaded && loaded.id === id && loaded.snapshot === snapshot && summary?.history?.previous === loaded.version && summary.history.changedFrom >= loaded.total)
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
