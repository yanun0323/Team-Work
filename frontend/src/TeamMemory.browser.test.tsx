// A company's memory tab and detail sheet: plain previews in the list; on the left, one line of author, source and time above the full text, with add, edit and remove.
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import './fusion.css'
import { useStore } from './core/store'
import { chatPreview } from './crew'
import { Detail, itemKey, memoryPreview, type Item } from './DrawerDetail'
import { TeamMemories } from './DrawerTabs'

let root: Root | null = null
let box: HTMLDivElement | null = null

afterEach(() => {
  act(() => root?.unmount())
  box?.remove()
  root = null
  box = null
})

const teams = () => Object.values(useStore.getState().world.teams).sort((a, b) => a.createdAt - b.createdAt)

function Harness({ teamId }: { teamId: string }) {
  const [stack, setStack] = useState<Item[]>([])
  const noop = () => {}
  const open = (next: Item) => setStack((cur) => (cur[0] && itemKey(cur[0]) === itemKey(next) ? [] : [next]))
  const push = (next: Item) => setStack((cur) => [...cur, next])
  return (
    <>
      <TeamMemories teamId={teamId} open={stack[0] ? itemKey(stack[0]) : null} onOpen={open} />
      {stack.map((item, i) => (
        <Detail key={`${i}:${itemKey(item)}`} item={item} teamId={teamId} depth={i} covered={i < stack.length - 1} above={stack[i + 1]} leaving={false}
          onGone={noop} onBack={() => setStack((cur) => cur.slice(0, i + 1))} onDone={() => setStack((cur) => cur.slice(0, i))}
          onClear={noop} onPush={push} onOpen={open} />
      ))}
    </>
  )
}

async function draw(teamId: string) {
  box = document.createElement('div')
  document.body.append(box)
  root = createRoot(box)
  await act(async () => root!.render(<Harness teamId={teamId} />))
}

const rows = () => [...box!.querySelectorAll('.fx-list .fx-row')]
const rowTexts = () => rows().map((r) => r.textContent)
const button = (name: string) => [...box!.querySelectorAll('button')].find((b) => b.textContent === name || b.getAttribute('aria-label') === name)!
// the line under the heading: author, source, then when
const meta = () => [...box!.querySelector('#fx-detail .fx-memory-meta')!.children].map((x) => (x as HTMLElement).innerText.replace(/\s+/g, '').trim())
const metaButton = (i: number) => box!.querySelector('#fx-detail .fx-memory-meta')!.children[i].querySelector('button')!

it('shows an empty company as such, and adds a note through the detail sheet as the user', async () => {
  const team = teams()[1]
  useStore.getState().act((w) => { w.teams[team.id].memory = [] })
  await draw(team.id)
  expect(box!.textContent).toContain('還沒有記憶')
  await userEvent.click(button('＋ 新記憶'))
  expect(button('儲存').disabled).toBe(true)
  await userEvent.type(box!.querySelector('textarea[aria-label="新增公司記憶"]')!, '文件用繁體中文')
  await userEvent.click(button('儲存'))
  expect(box!.querySelector('#fx-detail')).toBeNull()
  expect(rowTexts()).toEqual(['文件用繁體中文'])
  expect(useStore.getState().world.teams[team.id].memory[0]).toMatchObject({ text: '文件用繁體中文', source: 'user' })
})

it('shows only clean previews in the list, and shows author, origin chat/task and timestamps on the detail sheet', async () => {
  const w = useStore.getState().world
  const team = teams()[0]
  const kai = Object.values(w.replicas).find((r) => r.name === 'Kai')!
  const chat = Object.values(w.chats).find((c) => c.teamId === team.id)!
  const longText = '第一行是很長很長的公司規範說明，用來確認列表只顯示前幾個固定字數，點進去才看完整內容\n第二行補充細節'
  useStore.getState().act((x) => {
    x.now = 125
    x.teams[team.id].memory = [{ id: 'mem-long', text: longText, source: 'chat', createdAt: 65, at: 65, chatId: chat.id, by: kai.id }]
  })
  await draw(team.id)
  // list shows preview only, without author or bold title
  expect(rowTexts()).toEqual([memoryPreview(longText)])
  expect(rows()[0].querySelector('b')).toBeNull()
  expect(rowTexts()[0]!.endsWith('…')).toBe(true)

  await userEvent.click(rows()[0])
  expect(rows()[0].getAttribute('aria-expanded')).toBe('true')
  expect(box!.querySelector('#fx-detail .fx-d-text')!.textContent).toBe(longText)
  expect(meta()).toEqual(['Kai', chat.title || chatPreview(chat), '1:05'])
  expect(metaButton(0).querySelector('svg')).not.toBeNull()
  // the line sits above the note itself
  const line = box!.querySelector('#fx-detail .fx-memory-meta')!
  expect(line.compareDocumentPosition(box!.querySelector('#fx-detail .fx-d-text')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(line.getBoundingClientRect().height).toBeLessThan(40)

  await userEvent.click(box!.querySelector<HTMLButtonElement>('#fx-detail button[aria-label="編輯"]')!)
  const firstEdit = box!.querySelector<HTMLTextAreaElement>('textarea[aria-label="記憶"]')!
  await userEvent.type(firstEdit, '暫時改動')
  await userEvent.keyboard('{Escape}')
  expect(box!.querySelector('#fx-detail .fx-d-text')!.textContent).toBe(longText)

  await userEvent.click(box!.querySelector<HTMLButtonElement>('#fx-detail button[aria-label="編輯"]')!)
  const edit = box!.querySelector<HTMLTextAreaElement>('textarea[aria-label="記憶"]')!
  await userEvent.clear(edit)
  await userEvent.type(edit, '改過的')
  await userEvent.click(button('儲存'))
  expect(box!.querySelector('#fx-detail .fx-d-text')!.textContent).toBe('改過的')
  expect(meta()).toEqual(['使用者建立', chat.title || chatPreview(chat), '1:05', '修改於2:05'])
  expect(rowTexts()).toEqual(['改過的'])
  const saved = useStore.getState().world.teams[team.id].memory.find((m) => m.id === 'mem-long')!
  expect(saved.source).toBe('user')
  expect(saved.by).toBeUndefined()
  expect(saved.createdAt).toBe(65)
})

it('opens the source chat from the memory detail sheet, and removes a note after asking', async () => {
  const w = useStore.getState().world
  const team = teams()[0]
  const chat = Object.values(w.chats).find((c) => c.teamId === team.id)!
  useStore.getState().act((x) => {
    x.teams[team.id].memory = [
      { id: 'mem-x', text: '舊規矩', source: 'chat', createdAt: 10, at: 10, chatId: chat.id, by: 'rep-gone' },
      { id: 'mem-y', text: '要刪', source: 'user', createdAt: 20, at: 20 },
    ]
  })
  await draw(team.id)
  expect(rowTexts()).toEqual(['舊規矩', '要刪'])
  await userEvent.click(rows()[1])
  await userEvent.click(box!.querySelector<HTMLButtonElement>('#fx-detail button[aria-label="刪除"]')!)
  await userEvent.click(box!.querySelector<HTMLButtonElement>('#fx-detail button[aria-label="確定刪除這個記憶"]')!)
  expect(box!.querySelector('#fx-detail')).toBeNull()
  expect(rowTexts()).toEqual(['舊規矩'])

  await userEvent.click(rows()[0])
  expect(meta()[0]).toBe('已離職員工')
  await userEvent.click(metaButton(1))
  expect(box!.querySelectorAll('.fx-detail')).toHaveLength(2)
  expect(metaButton(1).getAttribute('aria-expanded')).toBe('true')
})

it('opens the author and the source task, and shows no source for a note without one', async () => {
  const w = useStore.getState().world
  const team = teams()[0]
  const kai = Object.values(w.replicas).find((r) => r.name === 'Kai')!
  const task = Object.values(w.tasks).find((t) => t.teamId === team.id)!
  useStore.getState().act((x) => {
    x.teams[team.id].memory = [
      { id: 'mem-t', text: '任務學到的', source: 'work', createdAt: 10, at: 10, taskId: task.id, by: kai.id },
      { id: 'mem-u', text: '手寫的', source: 'user', createdAt: 20, at: 20 },
    ]
  })
  await draw(team.id)
  await userEvent.click(rows()[0])
  expect(meta()).toEqual(['Kai', `#${task.number}${task.title}`, '0:10'])
  await userEvent.click(metaButton(0))
  expect(box!.querySelectorAll('.fx-detail')).toHaveLength(2)
  expect(metaButton(0).getAttribute('aria-expanded')).toBe('true')
  // the sheet pushed on top covers the list here, so click it as the DOM does
  await act(async () => (rows()[1] as HTMLElement).click())
  await act(async () => (rows()[0] as HTMLElement).click())
  await userEvent.click(metaButton(1))
  expect(box!.querySelectorAll('.fx-detail')).toHaveLength(2)
  expect(metaButton(1).getAttribute('aria-expanded')).toBe('true')
  await act(async () => (rows()[1] as HTMLElement).click())
  expect(meta()).toEqual(['使用者建立', '0:20'])
})
