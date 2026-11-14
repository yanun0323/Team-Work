import { act, createRoot } from '@react-three/fiber'
import type { WebGLRenderer } from 'three'
import { afterEach, expect, it, vi } from 'vitest'
import { useCoversLeft, useLeftSheets, useSheets, type Sheets } from './Drawer'

const roots: ReturnType<typeof createRoot>[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => { root.unmount() })
  vi.unstubAllGlobals()
})

/**
 * The sheet stack, run as the drawer runs it, with a window that only hears keys. Node's own EventTarget is no stand-in:
 * it does not remove a listener added with `true` for capture when asked with `true` again.
 */
async function stack() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const heard = new Set<(e: Event) => void>()
  vi.stubGlobal('window', { addEventListener: (_: string, f: (e: Event) => void) => heard.add(f), removeEventListener: (_: string, f: (e: Event) => void) => heard.delete(f) })
  vi.stubGlobal('document', { activeElement: null, getElementById: () => null })
  const canvas = {} as HTMLCanvasElement
  const gl = { render: vi.fn(), setSize: vi.fn(), setPixelRatio: vi.fn(), domElement: canvas } as unknown as WebGLRenderer
  const root = createRoot(canvas)
  roots.push(root)
  await root.configure({ gl, frameloop: 'never', size: { width: 1, height: 1, top: 0, left: 0 } })
  let sheets!: Sheets
  function View() { sheets = useSheets(); return null }
  await act(async () => { root.render(<View />) })
  const live = () => sheets.layers.filter((l) => !l.leaving).map((l) => l.item)
  const escapeWith = async (e: Event) => { await act(async () => { for (const f of [...heard]) f(e) }) }
  const escape = () => escapeWith(Object.assign(new Event('keydown'), { key: 'Escape' }))
  return { get: () => sheets, live, escape, escapeWith }
}

it('puts away only a decision\'s sheet on Esc, keeping the task under it', async () => {
  const s = await stack()
  await act(async () => { s.get().open({ kind: 'task', id: 't1' }) })
  await act(async () => { s.get().push({ kind: 'fact', id: 'fact-692' }) })
  expect(s.live()).toEqual([{ kind: 'task', id: 't1' }, { kind: 'fact', id: 'fact-692' }])
  await s.escape()
  expect(s.live()).toEqual([{ kind: 'task', id: 't1' }])
  await s.escape()
  expect(s.live()).toEqual([])
})

it('leaves Esc to an open floating menu, keeping the sheet under it', async () => {
  const s = await stack()
  await act(async () => { s.get().open({ kind: 'task', id: 't1' }) })
  // focus sits on an item of the hand-off menu, a popover that is there only while open
  const inMenu = { closest: (q: string) => (q.split(',').some((p) => p.trim() === '[popover]') ? {} : null) }
  const e = Object.assign(new Event('keydown'), { key: 'Escape' })
  Object.defineProperty(e, 'target', { value: inMenu })
  const stop = vi.spyOn(e, 'stopPropagation')
  await s.escapeWith(e)
  expect(stop).not.toHaveBeenCalled()
  expect(s.live()).toEqual([{ kind: 'task', id: 't1' }])
  await s.escape()
  expect(s.live()).toEqual([])
})

it('still puts away the sheet on Esc from outside any menu', async () => {
  const s = await stack()
  await act(async () => { s.get().open({ kind: 'task', id: 't1' }) })
  const e = Object.assign(new Event('keydown'), { key: 'Escape' })
  Object.defineProperty(e, 'target', { value: { closest: () => null } })
  const stop = vi.spyOn(e, 'stopPropagation')
  await s.escapeWith(e)
  expect(stop).toHaveBeenCalled()
  expect(s.live()).toEqual([])
})

it('counts the stacks with a sheet out over the left, until their sheets are gone', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const canvas = {} as HTMLCanvasElement
  const gl = { render: vi.fn(), setSize: vi.fn(), setPixelRatio: vi.fn(), domElement: canvas } as unknown as WebGLRenderer
  const root = createRoot(canvas)
  roots.push(root)
  await root.configure({ gl, frameloop: 'never', size: { width: 1, height: 1, top: 0, left: 0 } })
  function Stack({ shown }: { shown: boolean }) { useCoversLeft(shown); return null }
  const show = async (a: boolean, b: boolean) => { await act(async () => { root.render(<><Stack shown={a} /><Stack shown={b} /></>) }) }
  await show(false, false)
  expect(useLeftSheets.getState().count).toBe(0)
  await show(true, false)
  expect(useLeftSheets.getState().count).toBe(1)
  // the company closes as the airport opens with a sheet of its own
  await show(true, true)
  expect(useLeftSheets.getState().count).toBe(2)
  await show(false, true)
  expect(useLeftSheets.getState().count).toBe(1)
  await act(async () => { root.render(null) })
  expect(useLeftSheets.getState().count).toBe(0)
})
