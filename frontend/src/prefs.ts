// Shared preferences; real clients read and write them through the backend.

import { create } from 'zustand'
import { MOCK } from './core/mode'
import { request } from './core/backend'
import { attempt } from './core/ops'
import type { Tab } from './DrawerTabs'

/** The airport's tabs. */
export const AIRPORT_TABS = [
  { id: 'providers', label: '模型供應商' },
  { id: 'blueprints', label: '員工藍圖' },
  { id: 'flows', label: '任務流程#tab' },
  { id: 'prefs', label: '設定' },
  { id: 'about', label: '關於' },
] as const
export type AirportTab = (typeof AIRPORT_TABS)[number]['id']

/** The tab asked for, or the first one if the app no longer has it. */
export const airportTabOr = (wanted: AirportTab): AirportTab =>
  (wanted as string) === 'sound' ? 'prefs' : AIRPORT_TABS.some((x) => x.id === wanted) ? wanted : 'providers'

export const MUSIC_STYLES = [
  { id: 'chiptune', label: '復古遊戲' },
  { id: 'piano', label: '輕柔鋼琴' },
  { id: 'ambient', label: '空靈氛圍' },
  { id: 'bossa', label: '輕快波莎' },
] as const
export type MusicStyle = (typeof MUSIC_STYLES)[number]['id']

export type LogOrder = 'newestFirst' | 'newestLast'

export interface Prefs {
  musicStyle: MusicStyle
  /** Independent channel levels, 0–100; zero mutes the channel. */
  musicVolume: number
  effectsVolume: number
  soundTakeoff: boolean
  soundLanding: boolean
  soundFlyover: boolean
  soundUI: boolean
  soundNotice: boolean
  /** Which way task and sub-task logs run. */
  logOrder: LogOrder
  /** Small decorations: desk items, plants, street lamps and planters, airport fittings, foam on the sea. */
  detail: boolean
  /** The sun casts shadows. */
  shadows: boolean
  /** People out on the island, outside the companies. */
  crowd: boolean
  /** The plane that lands and takes off, and planes passing over; off, the plane stays at its stand. */
  planes: boolean
  /** Low clouds and the shadows of the high ones. */
  clouds: boolean
  /** A company's terminal runs on when the company closes, until the app does. */
  keepTerminals: boolean
  /** The tab a company's file opens on. */
  defaultTab: Tab
  /** The tab the airport opens on. */
  defaultAirportTab: AirportTab
}

export const DEFAULT_PREFS: Prefs = { musicStyle: 'chiptune', soundNotice: true, musicVolume: 100, effectsVolume: 100, soundTakeoff: true, soundLanding: true, soundFlyover: true, soundUI: true, logOrder: 'newestFirst', detail: true, shadows: true, crowd: true, planes: true, clouds: true, keepTerminals: false, defaultTab: 'tasks', defaultAirportTab: 'providers' }

export const usePrefs = create<Prefs & { set: (p: Partial<Prefs>) => void }>()((set) => ({
  ...DEFAULT_PREFS,
  set: (patch) => {
    if (MOCK) set(patch)
    else void attempt(() => request('PATCH', '/settings/preferences', patch))
  },
}))

/** Log lines in the order the preference asks for; they come oldest first. */
export const ordered = <T,>(lines: T[], order: LogOrder) => (order === 'newestFirst' ? [...lines].reverse() : lines)
