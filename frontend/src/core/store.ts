import { useEffect } from 'react'
import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { seedWorld } from './data/seed'
import { tick } from './domain/sim'
import type { Locale, World, WorldEvent } from './domain/types'

/** Screens every design has. Each design lays them out its own way. */
export type View = 'teams' | 'home' | 'board' | 'workflow' | 'roster' | 'blueprints' | 'settings'

export type Panel =
  | { kind: 'task'; id: string; subId?: string }
  | { kind: 'replica'; id: string }
  | { kind: 'newTask' }
  | { kind: 'hire'; blueprintId?: string }
  | { kind: 'newTeam' }
  | { kind: 'newBlueprint' }
  | null

export interface Toast {
  id: number
  event: WorldEvent
}

interface State {
  world: World
  locale: Locale
  view: View
  teamId: string | null
  workflowId: string | null
  /** Node to select when the workflow screen opens. */
  nodeId: string | null
  panel: Panel
  speed: number
  toasts: Toast[]
  /** Change the world. Domain functions from sim.ts mutate in place and run inside this. */
  act: (fn: (w: World) => void) => void
  step: (dt: number) => void
  set: (patch: Partial<Pick<State, 'locale' | 'view' | 'teamId' | 'workflowId' | 'nodeId' | 'panel' | 'speed'>>) => void
  dismiss: (id: number) => void
}

let toastSeq = 0

const world = seedWorld()
const firstTeam = Object.values(world.teams).sort((a, b) => a.createdAt - b.createdAt)[0]

export const useStore = create<State>()(
  immer((set) => ({
    world,
    locale: 'zh',
    // Open straight into the first team; the team list is one click away.
    view: firstTeam ? 'home' : 'teams',
    teamId: firstTeam?.id ?? null,
    workflowId: null,
    nodeId: null,
    panel: null,
    speed: 1,
    toasts: [],
    act: (fn) =>
      set((s) => {
        fn(s.world)
        drain(s)
      }),
    step: (dt) =>
      set((s) => {
        if (s.speed === 0) return
        tick(s.world, dt * s.speed)
        drain(s)
      }),
    set: (patch) => set((s) => void Object.assign(s, patch)),
    dismiss: (id) =>
      set((s) => {
        s.toasts = s.toasts.filter((t) => t.id !== id)
      }),
  })),
)

/** Move world events into toasts. Keep the newest few. */
function drain(s: { world: World; toasts: Toast[] }) {
  if (!s.world.events.length) return
  for (const event of s.world.events) s.toasts.push({ id: ++toastSeq, event })
  s.world.events = []
  s.toasts = s.toasts.slice(-4)
}

/** Advance the fake runtime ten times a second. */
export function useSimLoop() {
  const step = useStore((s) => s.step)
  useEffect(() => {
    let last = performance.now()
    const id = window.setInterval(() => {
      const now = performance.now()
      step(Math.min(0.5, (now - last) / 1000))
      last = now
    }, 100)
    return () => window.clearInterval(id)
  }, [step])
}

/** Keep <html lang> in sync with the chosen language. */
export function useDocumentLang() {
  const locale = useStore((s) => s.locale)
  useEffect(() => {
    document.documentElement.lang = locale === 'zh' ? 'zh-Hant' : 'en'
  }, [locale])
}
