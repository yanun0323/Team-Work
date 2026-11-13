// A chat with an employee, on a detail sheet: who it is with on top, the notes in the middle, the message box below.
// Until the first message it is only a choice of one employee, on their own model; others are invited after that.
// With more than one it is a meeting: "@" picks who replies, or asks someone in, and each reply is headed by who wrote it.
// With no company it is the airport's: always the airport staff, and the model and level can change between replies.

import { shownUrl } from './core/island'
import { colon, listOf, tr } from './core/i18n'
import { Markdown } from './Markdown'
import { useChatHistory } from './chatHistory'
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { blocked } from './prereqs'
import { Prereqs, usePrereqs } from './PrereqStamps'
import { Select } from './Controls'
import { CrewPicks, CrewRow, CrewSelect } from './Pickers'
import { chatMindOf, chatPeople, chatPreview, chatWindow, DEFAULT_EFFORT, effortsOf, lastAirportMind, lastChatReplica, chatModels, mindOf, modelGroups, modelsOf, namedNotes, noteColors, personMindOf } from './crew'
import { ChatFaces } from './ChatFaces'
import { ALL, answerMentions, mentionedPeople, withAll } from './mentions'
import { Gone, Heading, DeleteTool, PinTool, type Head } from './DrawerDetail'
import { composing } from './ime'
import { crewOf, fmtClock, fmtTokens, useAtBottom, useStickToBottom } from './core/model'
import type { Attachment, Chat, ChatHandoff, Look, Made, QueuedMessage } from './core/domain/types'
import { attempt, chatTaskDraft, deleteChat, handOffChat, hasUncommitted, openFolder, readChat, refreshStaleModels, renameChat, resolveChatChange, retryChat, rewindChat, sayInChat, setChatChair, setChatMind, skipChatQuestion, startAirportChat, startChat, steerChat, stopChat, unqueueChat } from './core/ops'
import { AIRPORT_STAFF_LOOK, canHandOff, MAX_CHAT_PEOPLE, roundActor } from './core/domain/sim'
import { HandOffIcon, HandOffMenu } from './HandOffMenu'
import { useLiveOutput, useLiveText } from './core/live'
import { useStore } from './core/store'
import { PixelFace } from './core/voxel/PixelFace'
import { MentionBox } from './MentionBox'
import { SaidContext, type SaidActions } from './Said'
import { changeAsk, ChangeLines } from './ChangeCard'
import { attachable, FileAttachment, isImage, MAX_ATTACHMENTS, readAttachments, splitAttachments } from './attachments'
import { draftKey, useChatDraft } from './chatDraft'
import { watchChat } from './sound'
import { MadeCard, TaskCard } from './TaskCard'
import { CopyButton } from './CopyButton'

/** The chat's name, written in place: saved on leaving the field or Enter, put back on Escape; empty shows the first message again. */
/** 送給, then the face and name of each one a message is for. */
export function SentTo({ people, className, live }: { people: { id: string; name: string; look: Look }[]; className?: string; live?: boolean }) {
  return (
    <p className={['fx-room-to', className].filter(Boolean).join(' ')} aria-live={live ? 'polite' : undefined}>
      {tr('送給')}
      {people.map((r, i) => (
        <span key={r.id} className="fx-room-to-one">{i > 0 && listOf(['', ''])}<span aria-hidden="true"><PixelFace look={r.look} name={r.name} size={18} /></span>{r.name}</span>
      ))}
    </p>
  )
}

/** How much the chat's next call sends, of the least anyone in it can read. */
/** The tool line the backend adds where it summed up the earlier conversation. */
export const COMPACT_MARK = 'auto_compact'

/** Where the earlier conversation was summed up, drawn like the line where a chat was handed on. */
export function CompactLine({ index }: { index?: number }) {
  return <li className="fx-room-handoff" data-message-index={index}>{tr('已整理較早的對話')}</li>
}

/** A tool call in the log. A picture image_gen saved shows on its own, without the path it was saved to. */
export function ToolLine({ text, images, index }: { text: string; images?: ReactNode[]; index?: number }) {
  return (
    <li className="fx-room-tool" data-message-index={index}>
      {images?.length ? <div className="fx-chat-images fx-room-tool-images">{images}</div> : <code>{text}</code>}
    </li>
  )
}

/** A question's options under who asked. The heading folds them away to read the log above;
    the message box below still answers by typing while they are folded. Skip sets the question aside unanswered. */
export function AskBox({ to, options, folded, onFold, onPick, onSkip }: {
  to?: { name: string; look: Look }
  options: string[]
  folded: boolean
  onFold: () => void
  onPick: (option: string) => void
  onSkip: () => void
}) {
  return (
    <div className="fx-room-answer" role="group" aria-label={tr('選項')}>
      <div className="fx-room-ask-head">
      <button type="button" className="fx-room-to fx-room-fold" aria-expanded={!folded} onClick={onFold}>
        {to
          ? <>{tr('直接回答')}<span className="fx-room-to-one"><span aria-hidden="true"><PixelFace look={to.look} name={to.name} size={18} /></span>{to.name}</span></>
          : tr('選項')}
        <svg className="fx-room-fold-mark" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
          <path d="M4 6.5L8 10l4-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <button type="button" className="fx-room-skip" onClick={onSkip}>{tr('略過#ask')}</button>
      </div>
      {!folded && (
        <div className="fx-d-choices">
          {options.map((o) => <button key={o} type="button" className="fx-choice" onClick={() => onPick(o)}>{o}</button>)}
        </div>
      )}
    </div>
  )
}

export function ContextUse({ chat }: { chat: Chat }) {
  const window = useStore((s) => chatWindow(s.world, chat))
  const used = (chat.context ?? 0).toLocaleString('en-US')
  return <p className="fx-room-context">{used} / {window.toLocaleString('en-US')}</p>
}

/** The chat's id, copied on a click, saying so for a moment after. */
/** Whose a note is: read out only, or shown on it when others in the chat share its colour. */
export function NoteName({ name, shown }: { name: string; shown: boolean }) {
  return shown
    ? <span className="fx-chat-name">{name}<span className="fx-sr">{colon()}</span></span>
    : <span className="fx-sr">{name}{colon()}</span>
}

export function ChatId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <button type="button" className="fx-room-id fx-hit" title={tr('複製對話 ID')} aria-label={copied ? tr('已複製') : tr('複製對話 ID')}
      onClick={() => navigator.clipboard.writeText(id).then(() => setCopied(true), () => {})}>
      {copied ? tr('已複製') : id}
    </button>
  )
}

/** Under the box: the chat's id on the left, its context use on the right. */
export function ChatFoot({ chat }: { chat: Chat }) {
  return (
    <div className="fx-room-foot fx-room-say-wide">
      <ChatId id={chat.id} />
      <ContextUse chat={chat} />
    </div>
  )
}

function ChatTitle({ chat }: { chat: Chat }) {
  const act = useStore((s) => s.act)
  const saved = chat.title ?? ''
  const [draft, setDraft] = useState(saved)
  useEffect(() => setDraft(saved), [saved])
  const save = () => {
    const next = draft.trim().split(/\s+/).filter(Boolean).join(' ')
    setDraft(next)
    if (next !== saved) act((x) => renameChat(x, chat.id, next))
  }
  return (
    <input className="fx-control fx-room-title" aria-label={tr('對話名稱')} value={draft} placeholder={chatPreview(chat)} maxLength={80}
      spellCheck={false} autoComplete="off" onChange={(e) => setDraft(e.target.value)} onBlur={save}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !composing(e.nativeEvent)) e.currentTarget.blur()
        if (e.key === 'Escape') { setDraft(saved); e.currentTarget.blur() }
      }} />
  )
}

/** A line where a chat was handed to the next: from the chat it was copied from, which it opens unless deleted; one kept before that was recorded says who had it. */
export function HandoffLine({ handoff: h, to, gone, open, onOpen }: { handoff: ChatHandoff; to: string; gone: boolean; open: boolean; onOpen: (id: string) => void }) {
  if (!h.chatId) return <li className="fx-room-handoff">{tr('{from} 交給 {to}', { from: h.name, to })}</li>
  const text = tr('從 {chat} 交給 {to}', { chat: h.chatId, to })
  return (
    <li className="fx-room-handoff">
      {gone ? text : <button type="button" className="fx-hit" aria-expanded={open} onClick={() => onOpen(h.chatId!)}>{text}</button>}
    </li>
  )
}

export interface ChatTaskSeed { title: string; description: string; ownerId: string | null; chatId: string }

export function ChatSheet({ id: given, teamId, creating, crewOpen, onCrew, onFile, onSkill, image, onImage, onTask, onHandOff, chat: chatOpen, onOpenChat, task: taskOpen, onOpenTask, made: madeOpen, onOpenMade, onProvider, onGoneChat, ...h }: Head & {
  /** The chat to open; none starts a new one. */
  id?: string
  teamId: string
  /** Whether the sheet above is the task being written from this chat. */
  creating: boolean
  /** Whether the sheet above is the employee's, opened from the face or name on top. */
  crewOpen: boolean
  onCrew: (id: string) => void
  /** Open a file in the company's folder, or a skill of someone in the chat, that a message mentions. */
  onFile: (path: string) => void
  onSkill: (chat: string, name: string) => void
  /** The picture open on the sheet above, by its key, and how to open one. */
  image: string | null
  onImage: (key: string, image: Attachment, chat?: string) => void
  onTask: (seed: ChatTaskSeed) => void
  /** Opens the copy just made of this chat in its place, so the list marks the chat on screen. */
  onHandOff: (id: string) => void
  /** The chat this one was handed off from that is open on the sheet above, and how to open one. */
  chat: string | null
  onOpenChat: (id: string) => void
  /** The task made in this chat that is open on the sheet above, and how to open one. */
  task: string | null
  onOpenTask: (id: string) => void
  /** The blueprint, flow or provider an employee created in this chat that is open on the sheet above, and how to open one. */
  made: Made | null
  onOpenMade: (made: Made) => void
  /** Opens a provider to sign in to it again. */
  onProvider: (id: string) => void
  onGoneChat: () => void
}) {
  const w = useStore((s) => s.world)
  const act = useStore((s) => s.act)
  const [started, setStarted] = useState<Chat | null>(null)
  const id = given ?? started?.id
  // the answer to starting it can arrive ahead of the change to the world
  const pages = useChatHistory(id ? w.chats[id] ?? started ?? undefined : undefined)
  const chat = pages.chat
  const airport = !teamId
  const crew = crewOf(w, teamId)
  // what a new airport chat will run on; one under way keeps its own
  const [pickedModel, setPickedModel] = useState(() => [lastAirportMind(w)?.model, ...modelsOf(w)].find((m) => m && modelsOf(w).includes(m)) ?? '')
  const [pickedEffort, setPickedEffort] = useState(() => lastAirportMind(w)?.effort ?? DEFAULT_EFFORT)
  // who a new chat is with: one, or with 多人對話 on, several, the first chairing
  const [picks, setPicks] = useState(() => [lastChatReplica(w, teamId) ?? crew[0]?.id].filter((x): x is string => !!x))
  const [several, setSeveral] = useState(false)
  const replicaId = picks[0] ?? ''
  // what a new chat needs may go while this is open; one under way says so when it fails
  const needs = usePrereqs(teamId, airport ? 'airportChats' : 'chats').filter((x) => !chat && x.blocks)
  const replica = w.replicas[chat?.replicaId ?? replicaId]
  const { text, setText, images, setImages } = useChatDraft(draftKey(chat?.id, teamId))
  const [reading, setReading] = useState(false)
  const [readFailed, setReadFailed] = useState(false)
  const [refused, setRefused] = useState(false)
  const box = useRef<HTMLTextAreaElement>(null)
  const [sending, setSending] = useState(false)
  const [drafting, setDrafting] = useState(false)
  const [handingOff, setHandingOff] = useState(false)
  const [uncommitted, setUncommitted] = useState(false)
  // the question whose options are folded away; a new one, or another chat, opens again
  const [foldedAsk, setFoldedAsk] = useState('')
  const writing = chat?.replyAt !== undefined
  const live = useLiveText(chat?.id)
  const output = useLiveOutput(chat?.id)
  const [log, pin] = useStickToBottom<HTMLOListElement>(`${chat?.messages.length}:${writing}:${live.length}:${output}`)
  const atBottom = useAtBottom(log)
  // Keep the first visible index fixed as replies arrive; expanding history never hides it again.
  const length = chat?.messages.length ?? 0
  const [history, setHistory] = useState({ id, length, first: Math.max(0, length - 100) })
  const first = chat?.history ? 0 : history.id !== id ? Math.max(0, length - 100)
    : length < history.length ? Math.min(history.first, Math.max(0, length - 100)) : history.first
  if (history.id !== id || history.length !== length) setHistory({ id, length, first })
  const anchor = useRef<{ element: HTMLElement; top: number; id: typeof id } | null>(null)
  const earlier = async () => {
    const el = log.current
    const element = el?.querySelector<HTMLElement>('[data-message-index]')
    if (element) anchor.current = { element, top: element.getBoundingClientRect().top, id }
    if (chat?.history) {
      if (!await pages.more()) anchor.current = null
    } else setHistory({ id, length, first: Math.max(0, first - 100) })
  }
  useLayoutEffect(() => {
    const saved = anchor.current
    anchor.current = null
    if (saved && saved.id === id && saved.element.isConnected && log.current) {
      log.current.scrollTop += saved.element.getBoundingClientRect().top - saved.top
    }
  }, [first, pages.start, id, log])
  const readId = chat?.unread ? chat.id : undefined
  const said = chat?.history?.count ?? chat?.messages.length
  const openId = chat?.id
  useEffect(() => (openId ? watchChat(openId) : undefined), [openId])
  // a fresh sheet: straight to the box, to write (the sheet leaves the title alone then)
  useEffect(() => box.current?.focus({ preventScroll: true }), [])
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
  const people = airport ? [] : chat ? chatPeople(w, chat) : picks.flatMap((x) => (w.replicas[x] ? [{ id: x, name: w.replicas[x].name, look: w.replicas[x].look }] : []))
  const meeting = people.length > 1
  // in a meeting, an answer to a question goes to the one who asked unless the user mentions someone
  const asker = meeting && chat?.question ? chat.speaker : undefined
  const nameOf = (id?: string) => people.find((x) => x.id === (id || chat?.replicaId))?.name ?? name
  // who the question waiting on the user is from, to answer them by typing
  const askerFace = chat?.question ? people.find((x) => x.id === (chat.speaker || chat.replicaId)) ?? (look ? { name, look } : undefined) : undefined
  // which question that is: the chat, and how far it had come when it was asked
  const askKey = chat?.question ? `${chat.id}:${chat.messages.length}` : ''
  const speaking = nameOf(chat?.speaker)
  // "@" offers those in the chat first, then the company, who join when mentioned, while there is room
  const full = people.length >= MAX_CHAT_PEOPLE
  const inChat = (id: string) => people.some((x) => x.id === id)
  const mentionable = airport ? [] : [...meeting ? [ALL] : [], ...[...crew.filter((r) => inChat(r.id)), ...crew.filter((r) => !full && !inChat(r.id))].map((r) => ({ id: r.id, name: r.name }))]
  const present = people.filter((x) => w.replicas[x.id])
  const mentionRow = (id: string) => id === ALL.id ? (
    <>
      <ChatFaces people={present} size={26} />
      <span className="fx-row-main">
        <b className="fx-crew-head"><span className="fx-crew-name">{ALL.name}</span></b>
        <span>{listOf(present.map((x) => x.name))}</span>
      </span>
    </>
  ) : w.replicas[id] && (
    <CrewRow r={w.replicas[id]} on={inChat(id)} chair={meeting && id === people[0]?.id} mind={chat && inChat(id) ? personMindOf(w, chat, id) : undefined} />
  )
  // who "@" names, in the notes as well: anyone in the chat, with those who have left, and the company
  const named = [...meeting ? [ALL] : [], ...[...people, ...crew.filter((r) => !inChat(r.id))].map((x) => ({ id: x.id, name: x.name }))]
  const chair = people[0]?.id ?? replicaId
  const mentionsIn = (words: string) => answerMentions(withAll(mentionedPeople(words, mentionable), people.slice(1).map((x) => x.id), chair), asker)
  // who the message goes to as it is typed: those it mentions, or else the chair
  // who a sent message was for: those it mentions, or else who took it up, the chair of the time
  const sentTo = (i: number) => {
    const m = chat!.messages[i].mentions ?? []
    const took = chat!.messages.slice(i + 1).find((x) => x.from !== 'tool')
    const ids = m.length ? m : [took?.from === 'agent' && took.by ? took.by : chat!.replicaId]
    return ids.flatMap((id) => people.filter((x) => x.id === id))
  }
  const sendTo = meeting ? (() => { const m = mentionsIn(text); return m.length ? m : [chair] })().flatMap((id) => (w.replicas[id] ? [w.replicas[id]] : [])) : []
  const guests = chat ? people.slice(1).flatMap((x) => (w.replicas[x.id] ? [w.replicas[x.id]] : [])) : []
  // each employee writes on their provider's colour; the airport staff on the plain note
  const colors = chat && !airport ? noteColors(w, chatModels(chat)) : {}
  // when colours come round again in a group, its notes say whose they are
  const shownNames = chat && !airport ? namedNotes(w, chatModels(chat)) : new Set<string>()
  const noteOf = (id?: string) => {
    const color = colors[id || chat?.replicaId || '']
    return color ? { ['--note' as string]: color } : undefined
  }
  const mindModel = chat?.model ?? pickedModel
  const levels = effortsOf(w, mindModel)
  const wantedEffort = chat ? chat.effort ?? DEFAULT_EFFORT : pickedEffort
  const mindEffort = levels.includes(wantedEffort) ? wantedEffort : DEFAULT_EFFORT
  const drafted = !!text.trim() || images.length > 0
  // said while a reply is being written, it waits in the queue
  const ready = drafted && !reading && !sending && !left && !!(chat || (airport ? pickedModel : replica)) && !blocked(needs)
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
    const mentions = mentionsIn(words)
    pin()
    if (chat) {
      act((x) => sayInChat(x, chat.id, words, attachments.images, attachments.files, mentions))
      setText('')
      setImages([])
      return
    }
    setSending(true)
    const made = airport
      ? await startAirportChat(act, { model: pickedModel, effort: mindEffort, text: words, ...attachments })
      : await startChat(act, { teamId, replicaId, ...(picks.length > 1 ? { guests: picks.slice(1) } : {}), ...(mentions.length ? { mentions } : {}), text: words, ...attachments })
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
      const { added, refused: tooLarge } = await readAttachments(fit)
      if (tooLarge) setRefused(true)
      setImages((now) => [...now, ...added].slice(0, MAX_ATTACHMENTS))
    } catch { setReadFailed(true) }
    finally { setReading(false) }
  }

  // back to the box, after whatever is being written there, and out of the queue
  const unqueue = (q: QueuedMessage) => {
    if (!chat) return
    act((x) => unqueueChat(x, chat.id, q.id))
    setText((now) => [now.trim(), q.text].filter(Boolean).join('\n'))
    setImages((now) => [...now, ...(q.images ?? []), ...(q.files ?? [])].slice(0, MAX_ATTACHMENTS))
    setRefused(false)
    box.current?.focus()
  }

  // back to the box, as it was when sent; what came after it is gone
  const edit = (index: number) => {
    if (!chat) return
    const { text, images, files } = chat.messages[index]
    act((x) => rewindChat(x, chat.id, index + (chat.history ? pages.start : 0), chat.history?.version))
    setText(text)
    setImages([...(images ?? []), ...(files ?? [])])
    setRefused(false)
    box.current?.focus()
  }
  const handOff = async (index: number, to: string) => {
    if (!chat) return
    setHandingOff(true)
    const made = await handOffChat(act, chat.id, index + (chat.history ? pages.start : 0), to, chat.history?.version)
    setHandingOff(false)
    if (made) onHandOff(made.id)
  }
  // a picture in message i, opened at full size on a sheet of its own
  const imageButton = (i: number, j: number, im: Attachment) => {
    const key = `chat:${chat?.id}:${i + (chat?.history ? pages.start : 0)}:${j}`
    return (
      <button key={j} type="button" className="fx-chat-image fx-hit" aria-expanded={image === key} onClick={() => chat && onImage(key, im, chat.id)}>
        <img src={shownUrl(im.url)} alt={im.name} />
      </button>
    )
  }
  // the airport staff are the only ones an airport chat can go to; a company's, its employee first, then the rest
  const takers = chat && !airport ? [...(replica ? [replica] : []), ...crew.filter((r) => r.id !== chat.replicaId)] : []
  const handOffButton = (i: number, end?: boolean) => {
    if (!chat || !canHandOff(chat.messages, i, writing)) return null
    if (airport) {
      return (
        <button type="button" className="fx-chat-edit fx-hit" aria-label={tr('從這則訊息複製出新對話')} title={tr('從這則訊息複製出新對話')} disabled={handingOff || !pages.ready} onClick={() => void handOff(i, '')}>
          <HandOffIcon />
        </button>
      )
    }
    return takers.length > 0 && <HandOffMenu crew={takers} chairId={meeting ? chat.replicaId : undefined} end={end} disabled={handingOff || !pages.ready} onPick={(to) => void handOff(i, to)} />
  }
  // what can be done about the failed reply that ends the chat: sign in again first when that is why, then reply again
  const failedActions = (i: number) => {
    const m = chat?.messages[i]
    if (!chat || !m?.failed || i !== chat.messages.length - 1 || writing || left) return null
    const auth = m.signedOut ? w.providers[m.signedOut]?.auth : undefined
    if (auth?.kind === 'subscription' && !auth.signedIn) {
      return <button type="button" className="fx-chat-act fx-hit" onClick={() => onProvider(m.signedOut!)}>{tr('重新登入')}</button>
    }
    return <button type="button" className="fx-chat-act fx-hit" onClick={() => act((x) => retryChat(x, chat.id))}>{tr('重新回覆')}</button>
  }
  // a line where the chat was handed to the next
  const handoffLines = (i: number) => (chat?.handoffs ?? []).flatMap((h, k, all) => {
    if (h.before !== i && !(i === chat?.messages.length && h.before > i)) return []
    return [<HandoffLine key={`handoff-${k}`} handoff={h} to={h.to ?? all[k + 1]?.name ?? chat?.name ?? ''} gone={!!h.chatId && !w.chats[h.chatId]}
      open={!!h.chatId && chatOpen === h.chatId} onOpen={onOpenChat} />]
  })
  // a line where an employee joined the chat
  const joinLines = (i: number) => (chat?.joins ?? []).flatMap((j, k) => (j.before === i || (i === chat?.messages.length && j.before > i))
    ? [<li key={`join-${k}`} className="fx-room-handoff">{tr('{name} 加入對話', { name: j.name })}</li>]
    : [])
  // in a meeting, who wrote what comes next: their face opens their sheet
  const speakerLine = (id: string, key: string) => {
    const who = people.find((x) => x.id === id)
    if (!chat || !who) return null
    return (
      <li key={key} className="fx-room-speaker" aria-hidden="true">
        {w.replicas[id]
          ? <button type="button" className="fx-room-face fx-hit" tabIndex={-1} onClick={() => onCrew(id)}><PixelFace look={who.look} name={who.name} size={20} /></button>
          : <PixelFace look={who.look} name={who.name} size={20} />}
        <b>{who.name}</b>
        <span>{personMindOf(w, chat, id)}</span>
      </li>
    )
  }
  const turnAt = (i: number) => {
    const m = chat?.messages[i]
    if (!chat || !meeting || !m || m.from === 'user') return []
    const prev = i === first ? undefined : chat.messages[i - 1]
    const by = m.by || chat.replicaId
    return prev && prev.from !== 'user' && (prev.by || chat.replicaId) === by ? [] : [speakerLine(by, `speaker-${i}`)]
  }
  const last = chat?.messages[chat.messages.length - 1]
  const writerLine = writing && meeting && chat?.speaker && (!last || last.from === 'user' || (last.by || chat.replicaId) !== chat.speaker)
    ? speakerLine(chat.speaker, 'speaker-writing') : null
  const draftTask = async () => {
    if (!chat) return
    setDrafting(true)
    const draft = await attempt(() => chatTaskDraft(useStore.getState().world, chat.id))
    setDrafting(false)
    // the one who may act this round owns it, as with a task the employees create themselves
    const actor = roundActor(chat)
    if (draft) onTask({ ...draft, ownerId: w.replicas[actor] ? actor : replica?.id ?? null, chatId: chat.id })
  }
  // the tasks, blueprints, flows and providers made at a message, under it; one deleted since is gone from here too
  const madeAt = (i: number) => {
    const m = chat?.messages[i]
    const tasks = (m?.tasks ?? []).flatMap((x) => (w.tasks[x] ? [w.tasks[x]] : []))
    const made = (m?.made ?? []).filter((x) => (x.kind === 'blueprint' ? w.blueprints : x.kind === 'workflow' ? w.workflows : w.providers)[x.id])
    return tasks.length || made.length ? [(
      <li key={`tasks-${i}`} className={`fx-chat-tasks${m?.from === 'user' ? ' fx-chat-tasks-user' : ''}`}>
        {tasks.map((t) => <TaskCard key={t.id} task={t} aria-expanded={taskOpen === t.id} onClick={() => onOpenTask(t.id)} />)}
        {made.map((x) => (
          <MadeCard key={`${x.kind}-${x.id}`} made={x} aria-expanded={madeOpen?.kind === x.kind && madeOpen.id === x.id} onClick={() => onOpenMade(x)} />
        ))}
      </li>
    )] : []
  }

  // what a mention in the chat opens: in the airport's, files and folders are at home, as there is no company
  const opens: SaidActions = {
    person: onCrew,
    canPerson: (x) => !!w.replicas[x],
    ...(chat && {
      file: onFile,
      folder: (path: string) => openFolder(teamId, path),
      skill: (name: string) => onSkill(chat.id, name),
    }),
  }

  return (
    <SaidContext.Provider value={opens}>
    <div className="fx-room">
      {chat && (
        <div className="fx-tools">
          {meeting && guests.length > 0 && (
            <HandOffMenu crew={guests} label={tr('更換主持人')} text end disabled={writing || !!chat.change}
              onPick={(to) => act((y) => setChatChair(y, chat.id, to))} />
          )}
          {!airport && (
            <button type="button" className="fx-tool fx-tool-text fx-hit" disabled={drafting || writing || left} aria-expanded={creating} onClick={() => void draftTask()}>
              {drafting ? tr('整理中…') : tr('建立任務')}
            </button>
          )}
          <PinTool chat={chat} />
          <DeleteTool what={tr('對話')} onConfirm={() => { act((x) => deleteChat(x, chat.id)); onGoneChat() }} />
        </div>
      )}
      <header className="fx-room-head">
        {/* once under way, the face and name open the employee's sheet; the face is a second way in, for the pointer only */}
        {chat && meeting ? <span className="fx-room-faces"><ChatFaces people={people} size={44} card /></span> : chat && !airport && replica && look ? (
          <button type="button" className="fx-room-face fx-hit" tabIndex={-1} aria-hidden="true" onClick={() => onCrew(replica.id)}>
            <PixelFace look={look} name={name} size={44} />
          </button>
        ) : look ? <PixelFace look={look} name={name} size={44} /> : <span className="fx-d-noface" />}
        {airport ? (
          <div className="fx-room-picks">
            <div className="fx-row-main">
              <Heading {...h}>{name}</Heading>
              {!!chat?.tokens && <span>{fmtTokens(chat.tokens)} Token</span>}
            </div>
            <Select label={tr('模型')} value={mindModel} disabled={writing} options={modelsOf(w).includes(mindModel) || !mindModel ? modelsOf(w) : [...modelsOf(w), mindModel]} onOpen={refreshStaleModels}
              groups={modelGroups(w).map((g) => ({ label: g.label, count: g.models.length }))}
              groupOf={(m) => modelGroups(w).findIndex((g) => g.models.includes(m))}
              onChange={(m) => changeMind(m, mindEffort)} />
            <Select label={tr('思考等級')} value={mindEffort} disabled={writing} options={levels} onChange={(e) => changeMind(mindModel, e)} />
          </div>
        ) : chat && meeting ? (
          <div className="fx-row-main">
            <Heading {...h}>
              <span className="fx-room-names">
                {people.map((x, k) => (
                  <span key={x.id} className="fx-room-person">
                    {w.replicas[x.id] ? <button type="button" className="fx-room-name fx-hit" onClick={() => onCrew(x.id)}>{x.name}</button> : x.name}
                    {/* 、 or ", ", as the language lists names */}
                    {k < people.length - 1 && listOf(['', ''])}
                  </span>
                ))}
              </span>
            </Heading>
            {chat.tokens > 0 && <span>{fmtTokens(chat.tokens)} Token</span>}
          </div>
        ) : chat ? (
          <div className="fx-row-main">
            <Heading {...h}>
              {replica ? <button type="button" className="fx-room-name fx-hit" aria-expanded={crewOpen} onClick={() => onCrew(replica.id)}>{name}</button> : name}
            </Heading>
            <span>{chatMindOf(w, chat)}{chat.tokens > 0 && ` · ${fmtTokens(chat.tokens)} Token`}</span>
          </div>
        ) : (
          <div className="fx-room-picks">
            <span className="fx-sr"><Heading {...h}>{tr('新對話')}</Heading></span>
            <div className="fx-room-pick-row">
              {several
                ? <CrewPicks label={tr('員工')} value={picks} crew={crew} max={MAX_CHAT_PEOPLE} onChange={setPicks} />
                : <CrewSelect label={tr('員工')} value={replicaId} crew={crew} onChange={(id) => setPicks([id])} />}
              <label className="fx-room-several">
                <input type="checkbox" className="fx-tick" checked={several} onChange={(e) => { setSeveral(e.target.checked); if (!e.target.checked) setPicks(picks.slice(0, 1)) }} />
                {tr('多人對話')}
              </label>
            </div>
            <p className="fx-field"><span>{tr('模型')}</span><span className="fx-room-model">{replica && mindOf(replica)}</span></p>
          </div>
        )}
      </header>
      {chat && <ChatTitle chat={chat} />}
      <Prereqs list={needs} />
      <div className="fx-room-scroll">
      <ol ref={log} className="fx-room-log" aria-live="polite" aria-label={tr('和 {name} 的對話', { name: meeting ? listOf(people.map((x) => x.name)) : name })}>
        {pages.busy && <li role="status">{tr('載入中…')}</li>}
        {pages.error && <li role="alert">{tr('讀取歷史失敗，請重試')} <button type="button" onClick={pages.retry}>{tr('重試')}</button></li>}
        {(first > 0 || (chat?.history && pages.ready && pages.start > 0)) && <li className="fx-room-earlier"><button type="button" className="fx-hit" disabled={pages.busy} onClick={() => void earlier()}>{tr('顯示更早訊息')}</button></li>}
        {chat?.messages.slice(first).flatMap((m, offset) => {
          const i = first + offset
          return [...handoffLines(i), ...joinLines(i), ...turnAt(i), m.from === 'tool' && m.text === COMPACT_MARK
          ? <CompactLine key={i + (chat.history ? pages.start : 0)} index={i + (chat.history ? pages.start : 0)} />
          : m.from === 'tool'
          ? <ToolLine key={i + (chat.history ? pages.start : 0)} index={i + (chat.history ? pages.start : 0)} text={m.text} images={m.images?.map((im, j) => imageButton(i, j, im))} />
          : (
            <li key={i + (chat.history ? pages.start : 0)} data-message-index={i + (chat.history ? pages.start : 0)} className={`fx-chat-msg fx-chat-${m.from}`} style={m.from === 'agent' ? noteOf(m.by) : undefined}>
              {m.from === 'agent'
                ? (
                  <div className="fx-chat-said fx-chat-said-agent">
                    <div className="fx-chat-bubble"><NoteName name={nameOf(m.by)} shown={shownNames.has(m.by || chat?.replicaId || '')} /><Markdown text={m.text} people={named} /></div>
                    <div className="fx-chat-foot">
                      <time>{fmtClock(m.at)}</time>
                      {m.text && <CopyButton text={m.text} />}
                      {handOffButton(i)}
                      {failedActions(i)}
                    </div>
                  </div>
                )
                : (
                  <div className="fx-chat-said">
                    {m.images && m.images.length > 0 && <div className="fx-chat-images">{m.images.map((im, j) => imageButton(i, j, im))}</div>}
                    {!!m.files?.length && <div className="fx-chat-images">{m.files.map((file, j) => <FileAttachment key={j} file={file} />)}</div>}
                    {m.text && <div className="fx-chat-bubble"><span className="fx-sr">{tr('你：')}</span><Markdown text={m.text} people={named} signs="@#$" /></div>}
                    {meeting && sentTo(i).length > 0 && <SentTo people={sentTo(i)} className="fx-chat-to" />}
                    <div className="fx-chat-foot">
                    <time>{fmtClock(m.at)}</time>
                    {m.text && <CopyButton text={m.text} />}
                    {!left && (
                      <button type="button" className="fx-chat-edit fx-hit" aria-label={tr('編輯這則訊息')} title={tr('編輯')} disabled={sending || reading || !pages.ready} onClick={() => edit(i)}>
                        <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                          <path d="M2.5 13.5l.6-3L10.6 3l2.4 2.4-7.5 7.5z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
                          <path d="M9 4.6l2.4 2.4" stroke="currentColor" strokeWidth="1.5" />
                        </svg>
                      </button>
                    )}
                    {handOffButton(i, true)}
                    </div>
                  </div>
                )}
            </li>
          ), ...madeAt(i)]
        })}
        {chat && handoffLines(chat.messages.length)}
        {chat && joinLines(chat.messages.length)}
        {/* the running command's last lines; the tool line above has already been read out */}
        {writerLine}
        {writing && output && <li className="fx-room-output" aria-hidden="true"><pre>{output}</pre></li>}
        {writing && (
          <li className="fx-chat-msg fx-chat-agent fx-chat-writing" style={noteOf(chat?.speaker)}>
            <span className="fx-sr">{tr('{name} 正在回覆', { name: speaking })}</span>
            {live
              // read out when it is done, not piece by piece
              ? <div className="fx-chat-bubble" aria-hidden="true"><Markdown text={live} people={named} /></div>
              : <p className="fx-chat-bubble"><span className="fx-chat-dots" aria-hidden="true"><span /><span /><span /></span></p>}
          </li>
        )}
      </ol>
      {!atBottom && (
        <button type="button" className="fx-room-latest" aria-label={tr('捲到最新的訊息')} title={tr('捲到最新的訊息')} onClick={() => pin(true)}>
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <path d="M8 3v9M3.5 7.5L8 12l4.5-4.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}
      </div>
      {!left && !writing && !!chat?.question?.options.length && (
        <AskBox to={askerFace} options={chat.question.options} folded={foldedAsk === askKey}
          onFold={() => setFoldedAsk(foldedAsk === askKey ? '' : askKey)}
          onPick={(o) => act((x) => sayInChat(x, chat.id, o, [], [], answerMentions([], asker)))}
          onSkip={() => act((x) => skipChatQuestion(x, chat.id))} />
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
      {!left && !!chat?.queue?.length && (
        <ol className="fx-room-queue" aria-label={tr('排隊的訊息')}>
          {chat.queue.map((q) => (
            <li key={q.id}>
              <span className="fx-room-queue-kind">{tr(q.steer ? '插話' : '排隊')}</span>
              <span className="fx-room-queue-text">{q.text || [...(q.images ?? []), ...(q.files ?? [])].map((f) => f.name).join(', ')}</span>
              {!q.steer && (
                <button type="button" className="fx-tool fx-tool-text fx-hit" onClick={() => act((x) => steerChat(x, chat.id, q.id))}>{tr('插話')}</button>
              )}
              <button type="button" className="fx-chat-edit fx-hit" aria-label={tr('編輯排隊的訊息')} title={tr('編輯')} disabled={reading} onClick={() => unqueue(q)}>
                <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                  <path d="M2.5 13.5l.6-3L10.6 3l2.4 2.4-7.5 7.5z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
                  <path d="M9 4.6l2.4 2.4" stroke="currentColor" strokeWidth="1.5" />
                </svg>
              </button>
              <button type="button" className="fx-chat-edit fx-hit" aria-label={tr('刪除排隊的訊息')} title={tr('刪除')} onClick={() => act((x) => unqueueChat(x, chat.id, q.id))}>
                <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                  <path d="M2.5 4.5h11M6 4.5V3h4v1.5M4 4.5l.8 9h6.4l.8-9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
                </svg>
              </button>
            </li>
          ))}
        </ol>
      )}
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
            {refused && <p className="fx-room-warn fx-room-say-wide" role="status">{tr('附件每個最大 25MB，最多 6 個')}</p>}
            {readFailed && <p className="fx-room-warn fx-room-say-wide" role="alert">{tr('讀取附件失敗，請重試')}</p>}
            {images.length > 0 && (
              <div className="fx-thumbs fx-room-say-wide">
                {images.map((im, i) => (
                  <figure key={i} className={isImage(im) ? "fx-thumb" : "fx-file-wrap"}>
                    {isImage(im)
                      ? (
                        <button type="button" className="fx-thumb-open" aria-expanded={image === `chatDraft:${i}`} onClick={() => onImage(`chatDraft:${i}`, im, chat?.id)}>
                          <img src={shownUrl(im.url)} alt={im.name} />
                        </button>
                      )
                      : <FileAttachment file={im} />}
                    <button type="button" className="fx-thumb-x" aria-label={tr('移除 {name}', { name: im.name })}
                      onClick={() => setImages((now) => now.filter((_, j) => j !== i))}>×</button>
                  </figure>
                ))}
              </div>
            )}
            {drafted && sendTo.length > 0 && <SentTo people={sendTo} className="fx-room-say-wide" live />}
            <label className="fx-room-attach fx-hit" title={tr('加入附件')}>
              <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
                <path d="M13 7.5 8 12.5a3 3 0 0 1-4.3-4.2l5.4-5.4a2 2 0 0 1 2.9 2.8l-5.4 5.4a1 1 0 0 1-1.4-1.4L10 5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <input type="file" disabled={reading} multiple className="fx-sr" aria-label={tr('加入附件')}
                onChange={(e) => { void attach([...(e.target.files ?? [])]); e.target.value = '' }} />
            </label>
            <MentionBox box={box} grow value={text} teamId={teamId} airport={airport} replicaIds={people.filter((x) => w.replicas[x.id]).map((x) => x.id)} people={mentionable} personRow={mentionRow} label={tr('訊息')} placeholder={airport ? tr('輸入訊息，$ 選技能，# 選檔案，可直接貼上截圖') : meeting ? tr('輸入訊息，@ 找員工，@All 所有人，$ 選技能，# 選檔案') : tr('輸入訊息，@ 找員工，$ 選技能，# 選檔案，可直接貼上截圖')} onChange={setText} onSend={() => void send()} />
            {writing && !drafted
              ? (
                <button type="button" className="fx-room-send" aria-label={tr('暫停')} title={tr('暫停')} onClick={() => act((x) => stopChat(x, chat!.id))}>
                  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M5 3v10M11 3v10" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" /></svg>
                </button>
              ) : (
                <button type="submit" className="fx-room-send" disabled={!ready} aria-label={tr('發送')} title={tr('發送')}>
                  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </button>
              )}
            {chat && <ChatFoot chat={chat} />}
          </form>
        )}
    </div>
    </SaidContext.Provider>
  )
}
