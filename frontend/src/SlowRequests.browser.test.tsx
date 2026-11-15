// What the user sees while a waited-on request is slow, and after it fails: company notes being added, corrected or
// deleted, and a company being disbanded. The requests here are held until the test lets them answer.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import './fusion.css'
import { seedWorld } from './core/data/seed'
import { teamReplicas } from './core/model'
import { setFailureHandler } from './core/ops'
import { useStore } from './core/store'
import { Detail, NewTeamMemory, TeamMemoryDetail } from './DrawerDetail'

/** Each request made to the backend, held until `answer`. */
interface Held { method: string; path: string; body: unknown; answer: (status: number, body?: unknown) => void }
const held: Held[] = []

vi.mock('./core/mode', () => ({ MOCK: false }))

let root: Root | null = null
let box: HTMLDivElement | null = null
let done = 0
let failures: string[] = []

beforeEach(() => {
  vi.stubGlobal('fetch', (path: string, init: RequestInit) => new Promise<Response>((done) => {
    held.push({
      method: init.method ?? 'GET', path, body: init.body ? JSON.parse(String(init.body)) : undefined,
      answer: (status, body) => done(new Response(body === undefined ? null : JSON.stringify(body), { status })),
    })
  }))
  useStore.getState().act((w) => { Object.assign(w, structuredClone(seedWorld('zh'))) })
  failures = []
  setFailureHandler((m) => { failures.push(m) })
})

afterEach(() => {
  act(() => root?.unmount())
  box?.remove()
  root = null
  box = null
  held.length = 0
  done = 0
  vi.unstubAllGlobals()
})

const team = () => Object.values(useStore.getState().world.teams).sort((a, b) => a.createdAt - b.createdAt)[0]

async function draw(node: React.ReactNode) {
  box = document.createElement('div')
  document.body.append(box)
  root = createRoot(box)
  await act(async () => root!.render(node))
}

const button = (name: string) => [...box!.querySelectorAll('button')].find((b) => b.textContent === name || b.getAttribute('aria-label') === name)
const settle = async (fn: () => void) => { await act(async () => { fn(); await new Promise((r) => setTimeout(r, 10)) }) }
const refusal = (code: string, message: string) => ({ error: { code, message } })

it('keeps a new note being added as sent: what is typed while it saves is not lost', async () => {
  const t = team()
  const title = { current: null }
  await draw(<NewTeamMemory teamId={t.id} title={title} tid="t" onDone={() => { done++ }} />)
  const add = box!.querySelector<HTMLTextAreaElement>('textarea[aria-label="新增公司記憶"]')!
  await userEvent.type(add, 'A')
  await userEvent.keyboard('{Control>}{Enter}{/Control}')
  expect(held.map((h) => [h.method, h.body])).toEqual([['POST', { text: 'A' }]])
  expect(button('儲存中…')!.disabled).toBe(true)
  // nothing can be typed while it saves, so nothing typed is thrown away when it answers
  expect(add.readOnly).toBe(true)
  await userEvent.keyboard('{Control>}{Enter}{/Control}')
  expect(held).toHaveLength(1)
  await settle(() => held[0].answer(500, refusal('internal', '伺服器發生錯誤')))
  expect(failures).toEqual(['伺服器發生錯誤'])
  expect(done).toBe(0)
  expect(add.value).toBe('A')
  expect(add.readOnly).toBe(false)
  await userEvent.type(add, 'B')
  await userEvent.keyboard('{Control>}{Enter}{/Control}')
  await settle(() => held[1].answer(201, { id: 'mem-new', text: 'AB', source: 'user', at: 0 }))
  expect(done).toBe(1)
})

it('keeps a note being corrected as sent, and open to try again when it fails', async () => {
  const t = team()
  const note = t.memory[0]
  const noop = () => {}
  const title = { current: null }
  await draw(<TeamMemoryDetail teamId={t.id} id={note.id} title={title} tid="t" onDone={noop} />)
  await userEvent.click(box!.querySelector<HTMLButtonElement>('button[aria-label="編輯"]')!)
  const edit = box!.querySelector<HTMLTextAreaElement>('textarea[aria-label="記憶"]')!
  await userEvent.clear(edit)
  await userEvent.type(edit, 'A')
  await userEvent.click(button('儲存')!)
  expect(held.map((h) => [h.method, h.body])).toEqual([['PATCH', { text: 'A' }]])
  expect(edit.readOnly).toBe(true)
  expect(button('取消')!.disabled).toBe(true)
  await settle(() => held[0].answer(500, refusal('internal', '伺服器發生錯誤')))
  expect(failures).toEqual(['伺服器發生錯誤'])
  expect(edit.value).toBe('A')
  expect(edit.readOnly).toBe(false)
  await userEvent.type(edit, 'B')
  expect(edit.value).toBe('AB')
  await userEvent.click(button('儲存')!)
  expect(held.map((h) => h.body)).toEqual([{ text: 'A' }, { text: 'AB' }])
})

it('sends a note\'s delete once while it waits, and closes only once deleted', async () => {
  const t = team()
  const note = t.memory[0]
  const title = { current: null }
  await draw(<TeamMemoryDetail teamId={t.id} id={note.id} title={title} tid="t" onDone={() => { done++ }} />)
  await userEvent.click(box!.querySelector<HTMLButtonElement>('button[aria-label="刪除"]')!)
  const sure = box!.querySelector<HTMLButtonElement>('button[aria-label="確定刪除這個記憶"]')!
  await userEvent.click(sure)
  expect(sure.textContent).toBe('刪除中…')
  expect(sure.getAttribute('aria-disabled')).toBe('true')
  // pressed again while it waits, as a double click or the keyboard would
  await act(async () => { sure.click(); sure.click() })
  expect(held.map((h) => h.method)).toEqual(['DELETE'])
  await settle(() => held[0].answer(500, refusal('internal', '伺服器發生錯誤')))
  expect(failures).toEqual(['伺服器發生錯誤'])
  expect(done).toBe(0)
  await userEvent.click(box!.querySelector<HTMLButtonElement>('button[aria-label="刪除"]')!)
  await userEvent.click(box!.querySelector<HTMLButtonElement>('button[aria-label="確定刪除這個記憶"]')!)
  expect(held.map((h) => h.method)).toEqual(['DELETE', 'DELETE'])
  await settle(() => held[1].answer(204))
  expect(done).toBe(1)
})

it('disbands once while it waits, says what went wrong, and lets it be tried again with the same picks', async () => {
  const t = team()
  const own = teamReplicas(useStore.getState().world, t.id)
  const noop = () => {}
  await draw(<Detail item={{ kind: 'disband' }} teamId={t.id} depth={0} covered={false} leaving={false}
    onGone={noop} onBack={noop} onDone={() => { done++ }} onClear={noop} onPush={noop} onOpen={noop} />)
  const rows = [...box!.querySelectorAll<HTMLButtonElement>('button[role="checkbox"]')].filter((b) => b.querySelector('.fx-crew-name'))
  const picked = rows.find((b) => b.querySelector('.fx-crew-name')!.textContent === own[1].name)!
  await userEvent.click(picked)
  const submit = box!.querySelector<HTMLButtonElement>('button[type="submit"]')!
  await userEvent.click(submit)
  expect(submit.textContent).toBe('解散中…')
  expect(submit.disabled).toBe(true)
  expect(rows.every((b) => b.disabled)).toBe(true)
  submit.form!.requestSubmit()
  expect(held.map((h) => [h.method, h.path])).toEqual([['DELETE', `/api/v1/teams/${t.id}?keep=${own[1].id}`]])
  await settle(() => held[0].answer(400, refusal('invalid_request', `${own[1].name} 不是這間公司的員工，不能隨公司移到移民署`)))
  expect(box!.querySelector('[role="alert"]')!.textContent).toContain('不能隨公司移到移民署')
  expect(done).toBe(0)
  expect(picked.getAttribute('aria-checked')).toBe('true')
  expect(submit.disabled).toBe(false)
  await userEvent.click(submit)
  expect(box!.querySelector('[role="alert"]')).toBeNull()
  expect(held.map((h) => h.path)).toEqual([held[0].path, held[0].path])
  await settle(() => held[1].answer(204))
  expect(done).toBe(1)
})
