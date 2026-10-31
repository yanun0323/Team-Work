// A chat with an employee, on a detail sheet: who it is with on top, the notes in the middle, the message box below.
// Until the first message it is only a choice of employee, whose model it runs on; after that both stay as they are.

import { Markdown } from './Markdown'
import { useEffect, useState } from 'react'
import { Select } from './Controls'
import { Gone, Heading, DeleteTool, type Head } from './DrawerDetail'
import { fmtClock, teamReplicas, useStickToBottom } from './core/model'
import type { Chat } from './core/domain/types'
import { attempt, chatTaskDraft, deleteChat, hasUncommitted, sayInChat, startChat, stopChat } from './core/ops'
import { useStore } from './core/store'
import { PixelFace } from './core/voxel/PixelFace'

export interface ChatTaskSeed { title: string; description: string; ownerId: string | null }

export function ChatSheet({ id: given, teamId, creating, onTask, onGoneChat, ...h }: Head & {
  /** The chat to open; none starts a new one. */
  id?: string
  teamId: string
  /** Whether the sheet above is the task being written from this chat. */
  creating: boolean
  onTask: (seed: ChatTaskSeed) => void
  onGoneChat: () => void
}) {
  const w = useStore((s) => s.world)
  const act = useStore((s) => s.act)
  const [started, setStarted] = useState<Chat | null>(null)
  const id = given ?? started?.id
  // the answer to starting it can arrive ahead of the change to the world
  const chat = id ? w.chats[id] ?? started ?? undefined : undefined
  const crew = teamReplicas(w, teamId)
  const [replicaId, setReplicaId] = useState(crew[0]?.id ?? '')
  const replica = w.replicas[chat?.replicaId ?? replicaId]
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [drafting, setDrafting] = useState(false)
  const [uncommitted, setUncommitted] = useState(false)
  const writing = chat?.replyAt !== undefined
  const log = useStickToBottom<HTMLOListElement>(`${chat?.messages.length}:${writing}`)

  useEffect(() => {
    if (given) return
    let live = true
    void attempt(() => hasUncommitted(teamId)).then((dirty) => { if (live) setUncommitted(!!dirty) })
    return () => { live = false }
  }, [given, teamId])

  if (given && !chat) return <Gone {...h} />
  const left = !!chat && !replica
  const name = chat?.name ?? replica?.name ?? ''
  const look = replica?.look ?? chat?.look
  const ready = !!text.trim() && !sending && !writing && !left && !!(chat || replica)

  const send = async () => {
    if (!ready) return
    const words = text.trim()
    if (chat) {
      act((x) => sayInChat(x, chat.id, words))
      setText('')
      return
    }
    setSending(true)
    const made = await startChat(act, { teamId, replicaId, text: words })
    setSending(false)
    if (made) {
      setStarted(made)
      setText('')
    }
  }
  const draftTask = async () => {
    if (!chat) return
    setDrafting(true)
    const draft = await attempt(() => chatTaskDraft(useStore.getState().world, chat.id))
    setDrafting(false)
    if (draft) onTask({ ...draft, ownerId: replica?.id ?? null })
  }

  return (
    <div className="fx-room">
      {chat && (
        <div className="fx-tools">
          <button type="button" className="fx-tool fx-tool-text fx-hit" disabled={drafting || writing || left} aria-expanded={creating} onClick={() => void draftTask()}>
            {drafting ? '整理中…' : '建立任務'}
          </button>
          <DeleteTool what="對話" onConfirm={() => { act((x) => deleteChat(x, chat.id)); onGoneChat() }} />
        </div>
      )}
      <header className="fx-room-head">
        {look ? <PixelFace look={look} name={name} size={44} /> : <span className="fx-d-noface" />}
        {chat ? (
          <div className="fx-row-main">
            <Heading {...h}>{name}</Heading>
            <span>{chat.model}</span>
          </div>
        ) : (
          <div className="fx-room-picks">
            <span className="fx-sr"><Heading {...h}>新對話</Heading></span>
            <Select label="員工" value={replicaId} options={crew.map((r) => r.id)} labelOf={(x) => w.replicas[x]?.name ?? x}
              onChange={setReplicaId} />
            <p className="fx-field"><span>模型</span><span className="fx-room-model">{replica?.model}</span></p>
          </div>
        )}
      </header>
      <ol ref={log} className="fx-room-log" aria-live="polite" aria-label={`和 ${name} 的對話`}>
        {chat?.messages.map((m, i) => m.from === 'tool'
          ? <li key={i} className="fx-room-tool"><code>{m.text}</code></li>
          : (
            <li key={i} className={`fx-chat-msg fx-chat-${m.from}`}>
              {m.from === 'agent'
                ? <div className="fx-chat-bubble"><span className="fx-sr">{name}：</span><Markdown text={m.text} /></div>
                : <p className="fx-chat-bubble"><span className="fx-sr">你：</span>{m.text}</p>}
              <time>{fmtClock(m.at)}</time>
            </li>
          ))}
        {writing && (
          <li className="fx-chat-msg fx-chat-agent fx-chat-writing">
            <p className="fx-chat-bubble"><span className="fx-sr">{name} 正在回覆</span><span aria-hidden="true">···</span></p>
          </li>
        )}
      </ol>
      {!chat && !crew.length && <p className="fx-d-muted">這間公司還沒有員工</p>}
      {!chat && uncommitted && <p className="fx-room-warn" role="status">專案資料夾有未提交的改動，員工可能會改到同一份檔案</p>}
      {left
        ? <p className="fx-d-muted">{name} 已經離開公司</p>
        : (
          <form className="fx-room-say" onSubmit={(e) => { e.preventDefault(); void send() }}>
            <textarea className="fx-control" rows={2} value={text} aria-label="訊息" placeholder="輸入訊息"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                // Enter sends; not while a Chinese word is still being picked in the input method
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  void send()
                }
              }} />
            {writing
              ? (
                <button type="button" className="fx-room-send" aria-label="暫停" title="暫停" onClick={() => act((x) => stopChat(x, chat!.id))}>
                  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M5 3v10M11 3v10" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" /></svg>
                </button>
              ) : (
                <button type="submit" className="fx-room-send" disabled={!ready} aria-label="發送" title="發送">
                  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>
              )}
          </form>
        )}
    </div>
  )
}
