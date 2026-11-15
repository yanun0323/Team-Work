// A company's memory on its Settings tab: the user adds, corrects and removes notes, and sees who wrote each.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import './fusion.css'
import { useStore } from './core/store'
import { TeamMemory } from './DrawerDetail'

let root: Root | null = null
let box: HTMLDivElement | null = null

afterEach(() => {
  act(() => root?.unmount())
  box?.remove()
  root = null
  box = null
})

const teams = () => Object.values(useStore.getState().world.teams).sort((a, b) => a.createdAt - b.createdAt)

async function draw(teamId: string) {
  box = document.createElement('div')
  document.body.append(box)
  root = createRoot(box)
  await act(async () => root!.render(<TeamMemory teamId={teamId} />))
}

const notes = () => [...box!.querySelectorAll('.fx-d-note')].map((li) => li.textContent)
const button = (name: string) => [...box!.querySelectorAll('button')].find((b) => b.textContent === name || b.getAttribute('aria-label') === name)!

it('shows an empty company as such, and adds a note as the user', async () => {
  const team = teams()[1]
  useStore.getState().act((w) => { w.teams[team.id].memory = [] })
  await draw(team.id)
  expect(box!.textContent).toContain('還沒有記憶')
  expect(button('新增').disabled).toBe(true)
  await userEvent.type(box!.querySelector('textarea')!, '文件用繁體中文')
  await userEvent.click(button('新增'))
  expect(notes()).toEqual(['文件用繁體中文 · 使用者'])
  expect(box!.querySelector('textarea')!.value).toBe('')
  expect(useStore.getState().world.teams[team.id].memory[0]).toMatchObject({ text: '文件用繁體中文', source: 'user' })
})

it("names who wrote a note, and makes a corrected one the user's", async () => {
  const team = teams()[0]
  const kai = Object.values(useStore.getState().world.replicas).find((r) => r.name === 'Kai')!
  const note = team.memory.find((m) => m.by === kai.id)!
  await draw(team.id)
  expect(notes()).toContain(`${note.text} · Kai`)
  const row = [...box!.querySelectorAll('.fx-d-note')].find((li) => li.textContent === `${note.text} · Kai`)!
  await userEvent.click(row.querySelector<HTMLButtonElement>('button[aria-label="編輯"]')!)
  const edit = box!.querySelector<HTMLTextAreaElement>('textarea[aria-label="記憶"]')!
  await userEvent.clear(edit)
  await userEvent.type(edit, '改過的')
  await userEvent.click(button('儲存'))
  expect(notes()).toContain('改過的 · 使用者')
  const saved = useStore.getState().world.teams[team.id].memory.find((m) => m.id === note.id)!
  expect(saved.source).toBe('user')
  expect(saved.by).toBeUndefined()
})

it('removes a note after asking, and keeps a former employee\'s note under that name', async () => {
  const team = teams()[0]
  useStore.getState().act((w) => {
    w.teams[team.id].memory = [{ id: 'mem-x', text: '舊規矩', source: 'work', at: 0, by: 'rep-gone' }, { id: 'mem-y', text: '要刪', source: 'user', at: 0 }]
  })
  await draw(team.id)
  expect(notes()).toEqual(['舊規矩 · 已離職員工', '要刪 · 使用者'])
  const row = [...box!.querySelectorAll('.fx-d-note')][1]
  await userEvent.click(row.querySelector<HTMLButtonElement>('button[aria-label="刪除"]')!)
  await userEvent.click(row.querySelector<HTMLButtonElement>('button[aria-label="確定刪除這個記憶"]')!)
  expect(notes()).toEqual(['舊規矩 · 已離職員工'])
})
