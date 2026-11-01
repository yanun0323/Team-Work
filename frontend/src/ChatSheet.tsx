// A chat with an employee, on a detail sheet: who it is with on top, the notes in the middle, the message box below.
// Until the first message it is only a choice of employee, whose model it runs on; after that both stay as they are.

import { colon, tr } from './core/i18n'
import { Markdown } from './Markdown'
import { useEffect, useRef, useState } from 'react'
import { blocked } from './prereqs'
import { Prereqs, usePrereqs } from './PrereqStamps'
import { CrewSelect } from './Pickers'
import { chatMindOf, lastChatReplica, mindOf } from './crew'
import { Gone, Heading, DeleteTool, type Head } from './DrawerDetail'
import { fmtClock, teamReplicas, useStickToBottom } from './core/model'
import type { Attachment, Chat } from './core/domain/types'
import { attempt, chatTaskDraft, deleteChat, hasUncommitted, rewindChat, sayInChat, startChat, stopChat } from './core/ops'
import { useLiveText } from './core/live'
import { useStore } from './core/store'
import { PixelFace } from './core/voxel/PixelFace'
import { readImages } from './draft'

// what every provider can take, as the backend also checks; a message must fit in one request
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
const MAX_IMAGE_BYTES = (5 << 20) / 4 * 3
const MAX_IMAGES = 6

/** The files that can go along, up to the room left, and whether any had to stay behind. */
export const attachable = (files: File[], room: number) => {
  const fit = files.filter((f) => IMAGE_TYPES.includes(f.type) && f.size <= MAX_IMAGE_BYTES).slice(0, Math.max(room, 0))
  return { fit, refused: fit.length < files.length }
}

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
  const [replicaId, setReplicaId] = useState(() => lastChatReplica(w, teamId) ?? crew[0]?.id ?? '')
  // what a new chat needs may go while this is open; one under way says so when it fails
  const needs = usePrereqs(teamId, 'chats').filter((x) => !chat && x.blocks)
  const replica = w.replicas[chat?.replicaId ?? replicaId]
  const [text, setText] = useState('')
  const [images, setImages] = useState<Attachment[]>([])
  const [refused, setRefused] = useState(false)
  const box = useRef<HTMLTextAreaElement>(null)
  const [sending, setSending] = useState(false)
  const [drafting, setDrafting] = useState(false)
  const [uncommitted, setUncommitted] = useState(false)
  const writing = chat?.replyAt !== undefined
  const live = useLiveText(chat?.id)
  const log = useStickToBottom<HTMLOListElement>(`${chat?.messages.length}:${writing}:${live.length}`)

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
  const ready = (!!text.trim() || images.length > 0) && !sending && !writing && !left && !!(chat || replica) && !blocked(needs)

  const send = async () => {
    if (!ready) return
    const words = text.trim()
    if (chat) {
      act((x) => sayInChat(x, chat.id, words, images))
      setText('')
      setImages([])
      return
    }
    setSending(true)
    const made = await startChat(act, { teamId, replicaId, text: words, images })
    setSending(false)
    if (made) {
      setStarted(made)
      setText('')
      setImages([])
    }
  }
  const attach = async (files: File[]) => {
    const { fit, refused } = attachable(files, MAX_IMAGES - images.length)
    setRefused(refused)
    const more = await readImages(fit)
    setImages((now) => [...now, ...more].slice(0, MAX_IMAGES))
  }
  // back to the box, as it was when sent; what came after it is gone
  const edit = (index: number) => {
    if (!chat) return
    const { text, images } = chat.messages[index]
    act((x) => rewindChat(x, chat.id, index))
    setText(text)
    setImages(images ?? [])
    setRefused(false)
    box.current?.focus()
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
            {drafting ? tr('整理中…') : tr('建立任務')}
          </button>
          <DeleteTool what={tr('對話')} onConfirm={() => { act((x) => deleteChat(x, chat.id)); onGoneChat() }} />
        </div>
      )}
      <header className="fx-room-head">
        {look ? <PixelFace look={look} name={name} size={44} /> : <span className="fx-d-noface" />}
        {chat ? (
          <div className="fx-row-main">
            <Heading {...h}>{name}</Heading>
            <span>{chatMindOf(w, chat)}</span>
          </div>
        ) : (
          <div className="fx-room-picks">
            <span className="fx-sr"><Heading {...h}>{tr('新對話')}</Heading></span>
            <CrewSelect label={tr('員工')} value={replicaId} crew={crew} onChange={setReplicaId} />
            <p className="fx-field"><span>{tr('模型')}</span><span className="fx-room-model">{replica && mindOf(replica)}</span></p>
          </div>
        )}
      </header>
      <Prereqs list={needs} />
      <ol ref={log} className="fx-room-log" aria-live="polite" aria-label={tr('和 {name} 的對話', { name })}>
        {chat?.messages.map((m, i) => m.from === 'tool'
          ? <li key={i} className="fx-room-tool"><code>{m.text}</code></li>
          : (
            <li key={i} className={`fx-chat-msg fx-chat-${m.from}`}>
              {m.from === 'agent'
                ? <div className="fx-chat-bubble"><span className="fx-sr">{name}{colon()}</span><Markdown text={m.text} /></div>
                : (
                  <div className="fx-chat-said">
                    {m.images && m.images.length > 0 && (
                      <div className="fx-chat-images">{m.images.map((im, j) => <img key={j} src={im.url} alt={im.name} />)}</div>
                    )}
                    {m.text && <p className="fx-chat-bubble"><span className="fx-sr">{tr('你：')}</span>{m.text}</p>}
                    <div className="fx-chat-foot">
                    <time>{fmtClock(m.at)}</time>
                    {!left && (
                      <button type="button" className="fx-chat-edit fx-hit" aria-label={tr('編輯這則訊息')} title={tr('編輯')} disabled={sending} onClick={() => edit(i)}>
                        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                          <path d="M2.5 13.5l.6-3L10.6 3l2.4 2.4-7.5 7.5z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
                          <path d="M9 4.6l2.4 2.4" stroke="currentColor" strokeWidth="1.5" />
                        </svg>
                      </button>
                    )}
                    </div>
                  </div>
                )}
              {m.from === 'agent' && <time>{fmtClock(m.at)}</time>}
            </li>
          ))}
        {writing && (
          <li className="fx-chat-msg fx-chat-agent fx-chat-writing">
            <span className="fx-sr">{tr('{name} 正在回覆', { name })}</span>
            {live
              // read out when it is done, not piece by piece
              ? <div className="fx-chat-bubble" aria-hidden="true"><Markdown text={live} /></div>
              : <p className="fx-chat-bubble"><span aria-hidden="true">···</span></p>}
          </li>
        )}
      </ol>
      {!chat && !crew.length && <p className="fx-d-muted">{tr('這間公司還沒有員工')}</p>}
      {!chat && uncommitted && <p className="fx-room-warn" role="status">{tr('專案資料夾有未提交的改動，員工可能會改到同一份檔案')}</p>}
      {left
        ? <p className="fx-d-muted">{tr('{name} 已經離開公司', { name })}</p>
        : (
          <form className="fx-room-say" onSubmit={(e) => { e.preventDefault(); void send() }}
            onPaste={(e) => {
              // a screenshot comes in as a picture; text pastes as usual
              const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'))
              if (!files.length) return
              e.preventDefault()
              void attach(files)
            }}>
            {refused && <p className="fx-room-warn fx-room-say-wide" role="status">{tr('圖片只能是 PNG、JPEG、GIF 或 WebP，單張最大 3.75MB，一則最多 {MAX_IMAGES} 張', { MAX_IMAGES })}</p>}
            {images.length > 0 && (
              <div className="fx-thumbs fx-room-say-wide">
                {images.map((im, i) => (
                  <figure key={i} className="fx-thumb">
                    <img src={im.url} alt={im.name} />
                    <button type="button" className="fx-thumb-x" aria-label={tr('移除 {name}', { name: im.name })}
                      onClick={() => setImages((now) => now.filter((_, j) => j !== i))}>×</button>
                  </figure>
                ))}
              </div>
            )}
            <label className="fx-room-attach fx-hit" title={tr('加入圖片')}>
              <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                <path d="M13 7.5 8 12.5a3 3 0 0 1-4.3-4.2l5.4-5.4a2 2 0 0 1 2.9 2.8l-5.4 5.4a1 1 0 0 1-1.4-1.4L10 5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <input type="file" accept={IMAGE_TYPES.join(',')} multiple className="fx-sr" aria-label={tr('加入圖片')}
                onChange={(e) => { void attach([...(e.target.files ?? [])]); e.target.value = '' }} />
            </label>
            <textarea ref={box} className="fx-control" rows={2} value={text} aria-label={tr('訊息')} placeholder={tr('輸入訊息')}
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
                <button type="button" className="fx-room-send" aria-label={tr('暫停')} title={tr('暫停')} onClick={() => act((x) => stopChat(x, chat!.id))}>
                  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M5 3v10M11 3v10" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" /></svg>
                </button>
              ) : (
                <button type="submit" className="fx-room-send" disabled={!ready} aria-label={tr('發送')} title={tr('發送')}>
                  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>
              )}
          </form>
        )}
    </div>
  )
}
