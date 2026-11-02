// A chat with an employee, on a detail sheet: who it is with on top, the notes in the middle, the message box below.
// Until the first message it is only a choice of employee, whose model it runs on; after that both stay as they are.
// With no company it is the airport's: always the airport staff, and the model and level can change between replies.

import { colon, tr } from './core/i18n'
import { Markdown } from './Markdown'
import { useEffect, useRef, useState } from 'react'
import { blocked } from './prereqs'
import { Prereqs, usePrereqs } from './PrereqStamps'
import { Select } from './Controls'
import { CrewSelect } from './Pickers'
import { chatMindOf, DEFAULT_EFFORT, effortsOf, lastAirportMind, lastChatReplica, mindOf, modelGroups, modelsOf } from './crew'
import { Gone, Heading, DeleteTool, type Head } from './DrawerDetail'
import { fmtClock, fmtTokens, teamReplicas, useStickToBottom } from './core/model'
import type { Attachment, Chat } from './core/domain/types'
import { attempt, chatTaskDraft, deleteChat, forkChat, hasUncommitted, readChat, resolveChatChange, rewindChat, sayInChat, setChatMind, startAirportChat, startChat, stopChat } from './core/ops'
import { AIRPORT_STAFF_LOOK, canFork } from './core/domain/sim'
import { useLiveText } from './core/live'
import { useStore } from './core/store'
import { PixelFace } from './core/voxel/PixelFace'
import { MentionBox } from './MentionBox'
import { changeAsk, ChangeLines } from './ChangeCard'
import { attachable, FileAttachment, isImage, MAX_ATTACHMENTS, readAttachments, splitAttachments } from './attachments'

export interface ChatTaskSeed { title: string; description: string; ownerId: string | null }

export function ChatSheet({ id: given, teamId, creating, onTask, onFork, onGoneChat, ...h }: Head & {
  /** The chat to open; none starts a new one. */
  id?: string
  teamId: string
  /** Whether the sheet above is the task being written from this chat. */
  creating: boolean
  onTask: (seed: ChatTaskSeed) => void
  /** Opens the copy just made of this chat. */
  onFork: (id: string) => void
  onGoneChat: () => void
}) {
  const w = useStore((s) => s.world)
  const act = useStore((s) => s.act)
  const [started, setStarted] = useState<Chat | null>(null)
  const id = given ?? started?.id
  // the answer to starting it can arrive ahead of the change to the world
  const chat = id ? w.chats[id] ?? started ?? undefined : undefined
  const airport = !teamId
  const crew = teamReplicas(w, teamId)
  // what a new airport chat will run on; one under way keeps its own
  const [pickedModel, setPickedModel] = useState(() => [lastAirportMind(w)?.model, ...modelsOf(w)].find((m) => m && modelsOf(w).includes(m)) ?? '')
  const [pickedEffort, setPickedEffort] = useState(() => lastAirportMind(w)?.effort ?? DEFAULT_EFFORT)
  const [replicaId, setReplicaId] = useState(() => lastChatReplica(w, teamId) ?? crew[0]?.id ?? '')
  // what a new chat needs may go while this is open; one under way says so when it fails
  const needs = usePrereqs(teamId, airport ? 'airportChats' : 'chats').filter((x) => !chat && x.blocks)
  const replica = w.replicas[chat?.replicaId ?? replicaId]
  const [text, setText] = useState('')
  const [images, setImages] = useState<Attachment[]>([])
  const [reading, setReading] = useState(false)
  const [readFailed, setReadFailed] = useState(false)
  const [refused, setRefused] = useState(false)
  const box = useRef<HTMLTextAreaElement>(null)
  const [sending, setSending] = useState(false)
  const [drafting, setDrafting] = useState(false)
  const [forking, setForking] = useState(false)
  const [uncommitted, setUncommitted] = useState(false)
  const writing = chat?.replyAt !== undefined
  const live = useLiveText(chat?.id)
  const log = useStickToBottom<HTMLOListElement>(`${chat?.messages.length}:${writing}:${live.length}`)
  const readId = chat?.unread ? chat.id : undefined
  const said = chat?.messages.length
  useEffect(() => {
    if (readId) act((x) => readChat(x, readId))
  }, [act, readId, said])

  useEffect(() => {
    if (given || airport) return
    let live = true
    void attempt(() => hasUncommitted(teamId)).then((dirty) => { if (live) setUncommitted(!!dirty) })
    return () => { live = false }
  }, [given, airport, teamId])

  if (given && !chat) return <Gone {...h} />
  const left = !!chat && !airport && !replica
  const name = airport ? tr('機場服務人員') : chat?.name ?? replica?.name ?? ''
  const look = airport ? AIRPORT_STAFF_LOOK : replica?.look ?? chat?.look
  const mindModel = chat?.model ?? pickedModel
  const levels = effortsOf(w, mindModel)
  const wantedEffort = chat ? chat.effort ?? DEFAULT_EFFORT : pickedEffort
  const mindEffort = levels.includes(wantedEffort) ? wantedEffort : DEFAULT_EFFORT
  const ready = (!!text.trim() || images.length > 0) && !reading && !sending && !writing && !left && !!(chat || (airport ? pickedModel : replica)) && !blocked(needs)
  const changeMind = (model: string, effort: string) => {
    const level = effortsOf(w, model).includes(effort) ? effort : DEFAULT_EFFORT
    if (chat) act((x) => setChatMind(x, chat.id, model, level))
    else {
      setPickedModel(model)
      setPickedEffort(level)
    }
  }

  const send = async () => {
    if (!ready) return
    const words = text.trim()
    const attachments = splitAttachments(images)
    if (chat) {
      act((x) => sayInChat(x, chat.id, words, attachments.images, attachments.files))
      setText('')
      setImages([])
      return
    }
    setSending(true)
    const made = airport
      ? await startAirportChat(act, { model: pickedModel, effort: mindEffort, text: words, ...attachments })
      : await startChat(act, { teamId, replicaId, text: words, ...attachments })
    setSending(false)
    if (made) {
      setStarted(made)
      setText('')
      setImages([])
    }
  }
  const attach = async (files: File[]) => {
    if (reading) return
    const { fit, refused } = attachable(files, MAX_ATTACHMENTS - images.length)
    setRefused(refused)
    setReadFailed(false)
    setReading(true)
    try {
      const more = await readAttachments(fit)
      setImages((now) => [...now, ...more].slice(0, MAX_ATTACHMENTS))
    } catch { setReadFailed(true) }
    finally { setReading(false) }
  }

  // back to the box, as it was when sent; what came after it is gone
  const edit = (index: number) => {
    if (!chat) return
    const { text, images, files } = chat.messages[index]
    act((x) => rewindChat(x, chat.id, index))
    setText(text)
    setImages([...(images ?? []), ...(files ?? [])])
    setRefused(false)
    box.current?.focus()
  }
  const fork = async (index: number) => {
    if (!chat) return
    setForking(true)
    const made = await forkChat(act, chat.id, index)
    setForking(false)
    if (made) onFork(made.id)
  }
  const forkButton = (i: number) => !left && !!chat && canFork(chat.messages, i) && (
    <button type="button" className="fx-chat-edit fx-hit" aria-label={tr('從這則訊息複製出新對話')} title="Fork" disabled={writing || forking} onClick={() => void fork(i)}>
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
        <path d="M4 5v1.5a2 2 0 0 0 2 2h4a2 2 0 0 0 2-2V5M8 8.5V11" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <circle cx="4" cy="3.3" r="1.7" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <circle cx="12" cy="3.3" r="1.7" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <circle cx="8" cy="12.7" r="1.7" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    </button>
  )
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
          {!airport && (
            <button type="button" className="fx-tool fx-tool-text fx-hit" disabled={drafting || writing || left} aria-expanded={creating} onClick={() => void draftTask()}>
              {drafting ? tr('整理中…') : tr('建立任務')}
            </button>
          )}
          <DeleteTool what={tr('對話')} onConfirm={() => { act((x) => deleteChat(x, chat.id)); onGoneChat() }} />
        </div>
      )}
      <header className="fx-room-head">
        {look ? <PixelFace look={look} name={name} size={44} /> : <span className="fx-d-noface" />}
        {airport ? (
          <div className="fx-room-picks">
            <div className="fx-row-main">
              <Heading {...h}>{name}</Heading>
              {!!chat?.tokens && <span>{fmtTokens(chat.tokens)} Token</span>}
            </div>
            <Select label={tr('模型')} value={mindModel} disabled={writing} options={modelsOf(w).includes(mindModel) || !mindModel ? modelsOf(w) : [...modelsOf(w), mindModel]}
              groups={modelGroups(w).map((g) => ({ label: g.label, count: g.models.length }))}
              groupOf={(m) => modelGroups(w).findIndex((g) => g.models.includes(m))}
              onChange={(m) => changeMind(m, mindEffort)} />
            <Select label={tr('思考等級')} value={mindEffort} disabled={writing} options={levels} onChange={(e) => changeMind(mindModel, e)} />
          </div>
        ) : chat ? (
          <div className="fx-row-main">
            <Heading {...h}>{name}</Heading>
            <span>{chatMindOf(w, chat)}{chat.tokens > 0 && ` · ${fmtTokens(chat.tokens)} Token`}</span>
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
                ? (
                  <div className="fx-chat-said fx-chat-said-agent">
                    <div className="fx-chat-bubble"><span className="fx-sr">{name}{colon()}</span><Markdown text={m.text} /></div>
                    <div className="fx-chat-foot">
                      <time>{fmtClock(m.at)}</time>
                      {forkButton(i)}
                    </div>
                  </div>
                )
                : (
                  <div className="fx-chat-said">
                    {m.images && m.images.length > 0 && (
                      <div className="fx-chat-images">{m.images.map((im, j) => <img key={j} src={im.url} alt={im.name} />)}</div>
                    )}
                    {!!m.files?.length && <div className="fx-chat-images">{m.files.map((file, j) => <FileAttachment key={j} file={file} />)}</div>}
                    {m.text && <p className="fx-chat-bubble"><span className="fx-sr">{tr('你：')}</span>{m.text}</p>}
                    <div className="fx-chat-foot">
                    <time>{fmtClock(m.at)}</time>
                    {!left && (
                      <button type="button" className="fx-chat-edit fx-hit" aria-label={tr('編輯這則訊息')} title={tr('編輯')} disabled={sending || reading} onClick={() => edit(i)}>
                        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                          <path d="M2.5 13.5l.6-3L10.6 3l2.4 2.4-7.5 7.5z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
                          <path d="M9 4.6l2.4 2.4" stroke="currentColor" strokeWidth="1.5" />
                        </svg>
                      </button>
                    )}
                    {forkButton(i)}
                    </div>
                  </div>
                )}
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
      {!left && !writing && !!chat?.question?.options.length && (
        <div className="fx-d-choices" role="group" aria-label={tr('選項')}>
          {chat.question.options.map((o) => (
            <button key={o} type="button" className="fx-choice" onClick={() => act((x) => sayInChat(x, chat.id, o))}>{o}</button>
          ))}
        </div>
      )}
      {!left && !writing && chat?.change && (
        <section className="fx-d-change-card" aria-label={changeAsk(chat.change)}>
          <p>{changeAsk(chat.change)}</p>
          <ChangeLines change={chat.change} />
          <div className="fx-d-choices">
            <button type="button" className="fx-choice" onClick={() => act((x) => resolveChatChange(x, chat.id, true))}>{tr('同意')}</button>
            <button type="button" className="fx-choice" onClick={() => act((x) => resolveChatChange(x, chat.id, false))}>{tr('拒絕')}</button>
          </div>
        </section>
      )}
      {!chat && !airport && !crew.length && <p className="fx-d-muted">{tr('這間公司還沒有員工')}</p>}
      {!chat && uncommitted && <p className="fx-room-warn" role="status">{tr('專案資料夾有未提交的改動，員工可能會改到同一份檔案')}</p>}
      {left
        ? <p className="fx-d-muted">{tr('{name} 已經離開公司', { name })}</p>
        : (
          <form className="fx-room-say" onSubmit={(e) => { e.preventDefault(); void send() }}
            onPaste={(e) => {
              // a screenshot comes in as a picture; text pastes as usual
              const files = [...e.clipboardData.files]
              if (!files.length) return
              e.preventDefault()
              void attach(files)
            }}>
            {refused && <p className="fx-room-warn fx-room-say-wide" role="status">{tr('圖片最大 3.75MB，其他檔案最大 25MB，最多 6 個附件')}</p>}
            {readFailed && <p className="fx-room-warn fx-room-say-wide" role="alert">{tr('讀取附件失敗，請重試')}</p>}
            {images.length > 0 && (
              <div className="fx-thumbs fx-room-say-wide">
                {images.map((im, i) => (
                  <figure key={i} className={isImage(im) ? "fx-thumb" : "fx-file-wrap"}>
                    {isImage(im) ? <img src={im.url} alt={im.name} /> : <FileAttachment file={im} />}
                    <button type="button" className="fx-thumb-x" aria-label={tr('移除 {name}', { name: im.name })}
                      onClick={() => setImages((now) => now.filter((_, j) => j !== i))}>×</button>
                  </figure>
                ))}
              </div>
            )}
            <label className="fx-room-attach fx-hit" title={tr('加入附件')}>
              <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                <path d="M13 7.5 8 12.5a3 3 0 0 1-4.3-4.2l5.4-5.4a2 2 0 0 1 2.9 2.8l-5.4 5.4a1 1 0 0 1-1.4-1.4L10 5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <input type="file" disabled={reading} multiple className="fx-sr" aria-label={tr('加入附件')}
                onChange={(e) => { void attach([...(e.target.files ?? [])]); e.target.value = '' }} />
            </label>
            <MentionBox box={box} value={text} teamId={teamId} replicaIds={replica ? [replica.id] : []} label={tr('訊息')} placeholder={airport ? tr('輸入訊息，可直接貼上截圖') : tr('輸入訊息，$ 選技能，@ 選檔案，可直接貼上截圖')} onChange={setText} onSend={() => void send()} />
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
