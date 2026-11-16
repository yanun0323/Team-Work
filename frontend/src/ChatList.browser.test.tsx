// A long list of chats, in WebKit: it draws FIRST_CHATS as it opens and the next ones as the reader scrolls near its end.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import './fusion.css'
import { Chats, FIRST_CHATS } from './DrawerTabs'
import { emptyWorld } from './core/backend'
import { AIRPORT_STAFF_LOOK } from './core/domain/sim'
import { useStore } from './core/store'

let root: Root | null = null
let box: HTMLDivElement | null = null

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('fetch', async () => Response.json({}))
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  box?.remove()
  box = null
  vi.unstubAllGlobals()
})

async function frames() {
  for (let i = 0; i < 5; i++) {
    await act(async () => { await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))) })
  }
}

const drawn = () => document.querySelectorAll('.fx-chat-item').length

it('draws the first chats as it opens and the next ones as the reader scrolls near the end', async () => {
  const total = FIRST_CHATS * 2 + 10
  const w = emptyWorld()
  for (let i = 0; i < total; i++) {
    w.chats[`c${i}`] = { id: `c${i}`, teamId: '', replicaId: '', name: '', look: AIRPORT_STAFF_LOOK, model: 'gpt-5', tokens: 0, createdAt: i,
      messages: [{ from: 'user', at: i, text: `第 ${i} 個` }] }
  }
  useStore.getState().receive({ type: 'snapshot', world: w })
  box = document.createElement('div')
  box.style.cssText = 'width:420px;height:600px;overflow:auto'
  document.body.append(box)
  root = createRoot(box)
  await act(async () => root!.render(<Chats teamId="" open={null} onOpen={() => {}} />))
  await frames()
  // far from the end, no more than the first are drawn
  expect(drawn()).toBe(FIRST_CHATS)

  box.scrollTop = box.scrollHeight
  await frames()
  expect(drawn()).toBe(FIRST_CHATS * 2)

  box.scrollTop = box.scrollHeight
  await frames()
  expect(drawn()).toBe(total)
  // the latest first, the oldest last
  expect(document.querySelector('.fx-chat-item')!.textContent).toContain(`第 ${total - 1} 個`)
  expect(document.querySelector('.fx-chat-item:last-of-type')!.textContent).toContain('第 0 個')
})
