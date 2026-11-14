// The chat sheet as the macOS app draws it, in WebKit: where the reader is in a chat stays put as replies come in.
import { createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import './fusion.css'
import { ChatSheet } from './ChatSheet'
import { emptyWorld } from './core/backend'
import { AIRPORT_STAFF_LOOK } from './core/domain/sim'
import type { Chat, ChatMessage } from './core/domain/types'
import { useLive } from './core/live'
import { useStore } from './core/store'

const long = (name: string, lines: number) => Array.from({ length: lines }, (_, i) => `${name} 的第 ${i + 1} 段，說明一些事情，好讓這則回覆夠長。`).join('\n\n')
const said = (i: number): ChatMessage => i % 2 ? { from: 'agent', at: i, text: `回覆 ${i}` } : { from: 'user', at: i, text: `問題 ${i}` }

let root: Root | null = null
let box: HTMLDivElement | null = null
// the messages the backend holds, by version; a page is read late, as over a network
let versions: Record<string, ChatMessage[]> = {}
let delay = 60

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('fetch', async (url: string) => {
    const u = new URL(url, location.href)
    const page = u.pathname.match(/\/chats\/[^/]+\/messages$/)
    if (!page) return Response.json({})
    await new Promise((r) => setTimeout(r, delay))
    const version = u.searchParams.get('version') ?? ''
    const all = versions[version]
    if (!all) return Response.json({ error: { code: 'conflict', message: 'changed' } }, { status: 409 })
    const before = Number(u.searchParams.get('before'))
    const start = Math.max(0, before - Number(u.searchParams.get('limit')))
    return Response.json({ version, total: all.length, start, messages: all.slice(start, before), handoffs: [], joins: [] })
  })
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  box?.remove()
  box = null
  useLive.setState({ texts: {}, outputs: {} })
  vi.unstubAllGlobals()
})

function summary(version: string, previous: string | undefined, messages: ChatMessage[], replyAt?: number): Chat {
  const last = messages[messages.length - 1]
  return {
    id: 'c', teamId: '', replicaId: '', name: '', look: AIRPORT_STAFF_LOOK, model: 'gpt-5', tokens: 0, createdAt: 0, messages: [], replyAt,
    history: { version, previous, changedFrom: previous ? messages.length - 1 : 0, count: messages.length, preview: last.text, sortAt: last.at, hasFileMention: false, hasAttachment: false },
  }
}

async function open(messages: ChatMessage[], replyAt?: number) {
  versions = { v1: messages }
  const w = emptyWorld()
  w.providers.p = { id: 'p', name: 'Test', kind: 'openai', auth: { kind: 'apiKey', keyHint: '' }, baseUrl: '', models: ['gpt-5'] }
  w.chats.c = summary('v1', undefined, messages, replyAt)
  useStore.getState().receive({ type: 'snapshot', world: w })
  box = document.createElement('div')
  box.style.cssText = 'display:flex;flex-direction:column;width:620px;height:600px'
  document.body.append(box)
  root = createRoot(box)
  const noop = () => {}
  await act(async () => root!.render(
    <ChatSheet id="c" teamId="" title={createRef()} tid="chat" creating={false} crewOpen={false} image={null} chat={null} task={null} made={null}
      onCrew={noop} onFile={noop} onSkill={noop} onImage={noop} onTask={noop} onHandOff={noop} onOpenChat={noop} onOpenTask={noop}
      onOpenMade={noop} onProvider={noop} onGoneChat={noop} />,
  ))
  await settle(() => document.querySelectorAll('[data-message-index]').length === messages.length)
}

// waits for the page reads and the frames after them
async function settle(done: () => boolean = () => true) {
  for (let i = 0; i < 100; i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 20)) })
    if (done() && !document.querySelector('.fx-room-log [role="status"]')) break
  }
  await act(async () => { await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))) })
}

const log = () => document.querySelector<HTMLElement>('.fx-room-log')!
const row = (i: number) => document.querySelector<HTMLElement>(`[data-message-index="${i}"]`)!
const gap = () => log().scrollHeight - log().scrollTop - log().clientHeight
// where a row is on screen, from the top of the list's window
const at = (el: HTMLElement) => el.getBoundingClientRect().top - log().getBoundingClientRect().top

// the reader scrolls up by the wheel, as on a trackpad, to the row's middle
async function readFrom(el: HTMLElement) {
  log().dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }))
  log().scrollTop += at(el) + el.offsetHeight / 2 - log().clientHeight
  await settle()
}

const stream = (text: string) => act(async () => useLive.setState({ texts: { c: text } }))

// the reply is in: its words become a message, in the same patch that ends the turn, as the store is told it
async function finish(messages: ChatMessage[]) {
  versions.v2 = messages
  await act(async () => {
    useStore.getState().receive({ type: 'patch', upserts: [{ kind: 'chat', id: 'c', data: summary('v2', 'v1', messages) }] })
  })
}

it('keeps the reader in the middle of the reply before when the one being written is done', async () => {
  const before = [...Array.from({ length: 10 }, (_, i) => said(i)), { from: 'agent', at: 10, text: long('A', 12) }, { from: 'agent', at: 11, text: long('B', 30) }] as ChatMessage[]
  await open(before, 12)
  const c = long('C', 30)
  await stream(c)
  await settle()
  const b = row(11)
  await readFrom(b)
  const top = at(b)
  expect(top).toBeLessThan(0)
  await finish([...before, { from: 'agent', at: 12, text: c }])
  // the moment the turn ends, before the reply is read back, and after
  expect(Math.abs(at(row(11)) - top)).toBeLessThan(1)
  await settle(() => !!row(12))
  expect(row(12)).toBeTruthy()
  expect(Math.abs(at(row(11)) - top)).toBeLessThan(1)
})

it('keeps the reader in place as a short reply ends, when the list can no longer reach where they were', async () => {
  const before = [...Array.from({ length: 10 }, (_, i) => said(i)), { from: 'agent', at: 10, text: long('A', 12) }, { from: 'agent', at: 11, text: long('B', 30) }] as ChatMessage[]
  await open(before, 12)
  const c = long('C', 30)
  await stream(c)
  await settle()
  // near the end of B, with C filling the window below it
  const b = row(11)
  log().dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }))
  log().scrollTop += at(b) + b.offsetHeight - 40
  await settle()
  const top = at(b)
  await finish([...before, { from: 'agent', at: 12, text: c }])
  await settle(() => !!row(12))
  expect(Math.abs(at(row(11)) - top)).toBeLessThan(1)
})

it('keeps the words just written on screen until they come back as a message', async () => {
  const before = Array.from({ length: 30 }, (_, i) => said(i))
  await open(before, 30)
  const c = long('C', 3)
  await stream(c)
  await finish([...before, { from: 'agent', at: 30, text: c }])
  const words = () => [...document.querySelectorAll('.fx-room-log .fx-chat-agent')].filter((x) => x.textContent?.includes('C 的第 3 段')).length
  expect(document.querySelector('.fx-chat-writing')).toBeNull()
  expect(words()).toBe(1)
  await settle(() => !!row(30))
  expect(words()).toBe(1)
})

it('keeps the first message in place as earlier ones come in above it', async () => {
  await open(Array.from({ length: 150 }, (_, i) => said(i)))
  log().dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }))
  log().scrollTop = 0
  await settle()
  const first = row(50)
  const top = at(first)
  await act(async () => document.querySelector<HTMLButtonElement>('.fx-room-earlier button')!.click())
  await settle(() => !!row(0))
  expect(row(0)).toBeTruthy()
  expect(Math.abs(at(first) - top)).toBeLessThan(1)
})

it('follows a reply as it streams in and when it is done, while the reader is at the bottom', async () => {
  const before = Array.from({ length: 30 }, (_, i) => said(i))
  await open(before, 30)
  expect(gap()).toBeLessThan(1)
  for (let n = 1; n <= 20; n++) {
    await stream(long('C', n))
    expect(gap()).toBeLessThan(1)
  }
  await finish([...before, { from: 'agent', at: 30, text: long('C', 20) }])
  expect(gap()).toBeLessThan(1)
  await settle(() => !!row(30))
  expect(gap()).toBeLessThan(1)
})

it('lets go of the bottom at a nudge up while a reply streams, and stays there', async () => {
  const before = Array.from({ length: 30 }, (_, i) => said(i))
  await open(before, 30)
  await stream(long('C', 4))
  await settle()
  log().dispatchEvent(new WheelEvent('wheel', { deltaY: -5 }))
  log().scrollTop -= 5
  await settle()
  const top = at(row(29))
  for (let n = 5; n <= 20; n++) await stream(long('C', n))
  await settle()
  expect(Math.abs(at(row(29)) - top)).toBeLessThan(1)
})

it('keeps the reader in place when rows above them change height, as a picture loading', async () => {
  const before = Array.from({ length: 30 }, (_, i) => said(i))
  await open(before)
  const r = row(20)
  await readFrom(r)
  const top = at(r)
  // something above grows after it is drawn
  row(5).style.paddingBlockStart = '300px'
  await settle()
  expect(Math.abs(at(r) - top)).toBeLessThan(1)
  row(5).style.paddingBlockStart = ''
  await settle()
  expect(Math.abs(at(r) - top)).toBeLessThan(1)
})

it('comes back to the bottom and follows again after the reader scrolls down to it', async () => {
  const before = Array.from({ length: 30 }, (_, i) => said(i))
  await open(before, 30)
  await readFrom(row(15))
  log().dispatchEvent(new WheelEvent('wheel', { deltaY: 100 }))
  log().scrollTop = log().scrollHeight
  await settle()
  for (let n = 1; n <= 10; n++) await stream(long('C', n))
  await settle()
  expect(gap()).toBeLessThan(1)
})
