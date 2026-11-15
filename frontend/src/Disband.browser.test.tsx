// Disbanding a company in the sample world: its own employees ticked here move to the immigration office with their
// own memory; the rest go with it. Picked with the mouse or the keyboard, or none at all.
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import './fusion.css'
import { seedWorld } from './core/data/seed'
import { STAFFING_ID } from './core/domain/types'
import { teamReplicas } from './core/model'
import { useStore } from './core/store'
import { Detail } from './DrawerDetail'

let root: Root | null = null
let box: HTMLDivElement | null = null
let done = 0

afterEach(() => {
  act(() => root?.unmount())
  box?.remove()
  root = null
  box = null
  done = 0
})

const fresh = () => useStore.getState().act((w) => { Object.assign(w, structuredClone(seedWorld('zh'))) })
const world = () => useStore.getState().world
const firstTeam = () => Object.values(world().teams).sort((a, b) => a.createdAt - b.createdAt)[0]

async function draw(teamId: string) {
  box = document.createElement('div')
  document.body.append(box)
  root = createRoot(box)
  const noop = () => {}
  await act(async () => root!.render(<Detail item={{ kind: 'disband' }} teamId={teamId} depth={0} covered={false} leaving={false}
    onGone={noop} onBack={noop} onDone={() => { done++ }} onClear={noop} onPush={noop} onOpen={noop} />))
}

const rows = () => [...box!.querySelectorAll<HTMLButtonElement>('button[role="checkbox"]')].filter((b) => b.querySelector('.fx-crew-name'))
const rowOf = (name: string) => rows().find((b) => b.querySelector('.fx-crew-name')!.textContent === name)!
const submit = () => box!.querySelector<HTMLButtonElement>('button[type="submit"]')!

it('lists its own employees one by one, none ticked, and keeps everyone else out', async () => {
  fresh()
  const team = firstTeam()
  await draw(team.id)
  const own = teamReplicas(world(), team.id)
  expect(rows().map((b) => b.querySelector('.fx-crew-name')!.textContent).sort()).toEqual(own.map((r) => r.name).sort())
  expect(rows().every((b) => b.getAttribute('aria-checked') === 'false')).toBe(true)
  // one plain list, not headed by blueprint
  expect(box!.querySelectorAll('.fx-list')).toHaveLength(1)
  expect(box!.textContent).toContain('勾選的員工帶著個人記憶移到移民署，其餘員工隨公司刪除')
})

it('moves those ticked to the immigration office with their own memory, and lets the rest go', async () => {
  fresh()
  const team = firstTeam()
  const [bo, ...rest] = teamReplicas(world(), team.id)
  useStore.getState().act((w) => { w.replicas[bo.id].memory = [{ id: 'mem-1', text: '先寫結論', source: 'user', at: 0 }] })
  const agency = teamReplicas(world(), STAFFING_ID).map((r) => r.id)
  await draw(team.id)
  await userEvent.click(rowOf(bo.name))
  expect(rowOf(bo.name).getAttribute('aria-checked')).toBe('true')
  await userEvent.click(submit())
  expect(box!.querySelector('[role="alert"]')?.textContent ?? '').toBe('')
  expect(world().teams[team.id]).toBeUndefined()
  const moved = teamReplicas(world(), STAFFING_ID).filter((r) => !agency.includes(r.id))
  expect(moved.map((r) => r.name)).toEqual([bo.name])
  expect(moved[0].memory.map((m) => m.text)).toEqual(['先寫結論'])
  expect(rest.some((r) => world().replicas[r.id])).toBe(false)
  expect(done).toBe(1)
})

it('takes the keyboard: Space ticks and unticks, and with none ticked all go', async () => {
  fresh()
  const team = firstTeam()
  const agency = teamReplicas(world(), STAFFING_ID).map((r) => r.id)
  await draw(team.id)
  const first = rows()[0]
  first.focus()
  await userEvent.keyboard(' ')
  expect(first.getAttribute('aria-checked')).toBe('true')
  await userEvent.keyboard(' ')
  expect(first.getAttribute('aria-checked')).toBe('false')
  submit().focus()
  await userEvent.keyboard('{Enter}')
  expect(world().teams[team.id]).toBeUndefined()
  expect(teamReplicas(world(), STAFFING_ID).map((r) => r.id)).toEqual(agency)
})
