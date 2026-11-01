import { useEffect } from 'react'
import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { applyPatches, connect, emptyWorld, type ServerEvent } from './backend'
import { seedWorld } from './data/seed'
import { addLive, clearAllLive, clearLive } from './live'
import { tick } from './domain/sim'
import type { Locale, World, WorldEvent } from './domain/types'
import { MOCK } from './mode'
import { editing, setFailureHandler } from './ops'

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
  /** The world has arrived; before that, an empty one says nothing about what exists. */
  loaded: boolean
  /** The backend can't be reached right now. */
  offline: boolean
  /** The last request the backend turned down, for the user to read. */
  failure: string
  /** Change the world. Domain functions from sim.ts mutate in place and run inside this. */
  act: (fn: (w: World) => void) => void
  step: (dt: number) => void
  set: (patch: Partial<Pick<State, 'locale' | 'view' | 'teamId' | 'workflowId' | 'nodeId' | 'panel' | 'speed'>>) => void
  dismiss: (id: number) => void
  /** Take in what the backend sends. */
  receive: (ev: ServerEvent) => void
  setOffline: () => void
  setFailure: (failure: string) => void
}

let toastSeq = 0

const world = MOCK ? seedWorld() : emptyWorld()
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
    loaded: MOCK,
    offline: false,
    failure: '',
    receive: (ev) =>
      set((s) => {
        switch (ev.type) {
          case 'snapshot': {
            clearAllLive()
            s.world = { ...emptyWorld(), ...ev.world }
            s.loaded = true
            s.offline = false
            if (!s.teamId || !s.world.teams[s.teamId]) {
              const first = Object.values(s.world.teams).sort((a, b) => a.createdAt - b.createdAt)[0]
              s.teamId = first?.id ?? null
              s.view = first ? 'home' : 'teams'
            }
            break
          }
          case 'delta':
            addLive(ev.subId, ev.text)
            break
          case 'deltaReset':
            clearLive(ev.subId)
            break
          case 'language':
            s.world.language = ev.language
            break
          case 'patch': {
            // what was being written has become a message
            const said = (id: string) => (s.world.chats[id]?.messages ?? s.world.subTasks[id]?.talk?.messages ?? []).length
            const before = (ev.upserts ?? []).map((p) => [p.id, said(p.id)] as const)
            applyPatches(s.world, ev, (kind, id) => kind === 'team' && editing(id))
            for (const [id, n] of before) if (said(id) > n) clearLive(id)
            if (!s.teamId) {
              const first = Object.values(s.world.teams).sort((a, b) => a.createdAt - b.createdAt)[0]
              if (first) {
                s.teamId = first.id
                s.view = 'home'
              }
            }
            break
          }
          case 'notice':
            s.toasts.push({ id: ++toastSeq, event: ev.kind === 'review' ? { kind: 'review', taskId: ev.taskId, subId: ev.subId ?? '' } : { kind: 'awaitMerge', taskId: ev.taskId } })
            s.toasts = s.toasts.slice(-4)
            break
        }
      }),
    setOffline: () => set((s) => void (s.offline = true)),
    setFailure: (failure) => set((s) => void (s.failure = failure)),
    act: (fn) =>
      set((s) => {
        fn(s.world)
        drain(s)
      }),
    step: (dt) =>
      set((s) => {
        // the backend runs the world; here its clock only keeps going between changes
        if (!MOCK) return void (s.world.now = Date.now() / 1000)
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

/** Keep the world in step with the backend, unless this page runs on the simulator. */
export function useBackend() {
  useEffect(() => {
    if (MOCK) return
    const { receive, setOffline, setFailure } = useStore.getState()
    setFailureHandler(setFailure)
    return connect(receive, setOffline)
  }, [])
}

/** Keep <html lang> in sync with the chosen language. */
export function useDocumentLang() {
  const locale = useStore((s) => s.locale)
  useEffect(() => {
    document.documentElement.lang = locale === 'zh' ? 'zh-Hant' : 'en'
  }, [locale])
}
