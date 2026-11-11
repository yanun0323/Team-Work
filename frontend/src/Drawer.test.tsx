import { act, createRoot } from '@react-three/fiber'
import type { WebGLRenderer } from 'three'
import { afterEach, expect, it, vi } from 'vitest'
import { useSheets, type Sheets } from './Drawer'

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
  const escape = async () => {
    const e = Object.assign(new Event('keydown'), { key: 'Escape' })
    await act(async () => { for (const f of [...heard]) f(e) })
  }
  return { get: () => sheets, live, escape }
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
