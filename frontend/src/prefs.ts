// Shared preferences; real clients read and write them through the backend.

import { create } from 'zustand'
import { MOCK } from './core/mode'
import { request } from './core/backend'
import { attempt } from './core/ops'
import type { Tab } from './DrawerTabs'

/** The airport's tabs. */
export const AIRPORT_TABS = [
  { id: 'chats', label: '對話#tab' },
  { id: 'providers', label: '模型供應商' },
  { id: 'blueprints', label: '員工藍圖' },
  { id: 'flows', label: '任務流程#tab' },
  { id: 'stats', label: '統計' },
  { id: 'prefs', label: '設定' },
  { id: 'about', label: '關於' },
] as const
export type AirportTab = (typeof AIRPORT_TABS)[number]['id']

/** The tab asked for, or the first one if the app no longer has it. */
export const airportTabOr = (wanted: AirportTab): AirportTab =>
  (wanted as string) === 'sound' ? 'prefs' : AIRPORT_TABS.some((x) => x.id === wanted) ? wanted : 'providers'

export const MUSIC_STYLES = [
  { id: 'bossa', label: '輕快波莎' },
  { id: 'chiptune', label: '復古遊戲' },
  { id: 'piano', label: '輕柔鋼琴' },
  { id: 'ambient', label: '空靈氛圍' },
] as const
export type MusicStyle = (typeof MUSIC_STYLES)[number]['id']

export const AUTO_VIEWS = { panZoom: '位移和縮放', pan: '位移', off: '關閉#view' } as const
/** panZoom flies there, zooms in and locks the view; pan goes there at the same zoom and locks only panning; off leaves the camera alone. */
export type AutoView = keyof typeof AUTO_VIEWS

export const BUSY_ANIMATIONS = { money: '撒錢', shout: '粗線條' } as const
/** money tosses bills off one side of a busy building, then the other; shout flickers cartoon strokes off both sides. */
export type BusyAnimation = keyof typeof BUSY_ANIMATIONS

export type LogOrder = 'newestFirst' | 'newestLast'

export interface Prefs {
  /** Music and effects stop while the app or page is not the one in use. */
  muteInBackground: boolean
  musicStyle: MusicStyle
  /** Independent channel levels, 0–100; zero mutes the channel. */
  musicVolume: number
  effectsVolume: number
  /** Silence a channel without losing its level. */
  musicMuted: boolean
  effectsMuted: boolean
  soundTakeoff: boolean
  soundLanding: boolean
  soundFlyover: boolean
  soundUI: boolean
  soundNotice: boolean
  soundTutorial: boolean
  /** Opening a company, and the airport. */
  soundOpenTeam: boolean
  soundOpenAirport: boolean
  /** The sea round the island, looping in the background. */
  soundWaves: boolean
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
  /** What the camera does on opening a company or the airport, or picking a plot. */
  autoView: AutoView
  /** What a company's building shows while it is at work. */
  busyAnimation: BusyAnimation
  /** How fast the wheel zooms the map, in percent of the normal speed. */
  zoomSensitivity: number
  /** Typed into each terminal as it starts; empty runs nothing. */
  terminalCommand: string
  /** The tab a company's file opens on. */
  defaultTab: Tab
  /** The tab the airport opens on. */
  defaultAirportTab: AirportTab
  /** On opening, a tab with something waiting comes before the default tab. */
  openWaitingTab: boolean
  /** Names each new chat from its first message with this model; empty turns it off. */
  chatTitleModel: string
  chatTitleEffort: string
  /** The ChatGPT subscription every employee draws pictures with; empty gives nobody image_gen. */
  imageProvider: string
  /** The built-in blueprints read skills from ~/.codex/ and ~/.claude/. */
  codexSkills: boolean
  claudeSkills: boolean
}

export const DEFAULT_PREFS: Prefs = { muteInBackground: true, musicStyle: 'bossa', soundNotice: true, soundTutorial: true, soundOpenTeam: true, soundOpenAirport: true, soundWaves: true, musicVolume: 50, effectsVolume: 100, musicMuted: false, effectsMuted: false, soundTakeoff: true, soundLanding: true, soundFlyover: true, soundUI: true, logOrder: 'newestFirst', detail: true, shadows: true, crowd: true, planes: true, clouds: true, keepTerminals: false, autoView: 'panZoom', busyAnimation: 'money', zoomSensitivity: 100, terminalCommand: '', defaultTab: 'tasks', defaultAirportTab: 'providers', openWaitingTab: true, chatTitleModel: '', chatTitleEffort: '', imageProvider: '', codexSkills: true, claudeSkills: true }

/** The range of `zoomSensitivity`; the backend checks the same. */
export const ZOOM_SENSITIVITY = { min: 20, max: 300 }

export const usePrefs = create<Prefs & { set: (p: Partial<Prefs>) => void }>()((set) => ({
  ...DEFAULT_PREFS,
  set: (patch) => {
    if (MOCK) set(patch)
    else void attempt(() => request('PATCH', '/settings/preferences', patch))
  },
}))

/** Log lines in the order the preference asks for; they come oldest first. */
export const ordered = <T,>(lines: T[], order: LogOrder) => (order === 'newestFirst' ? [...lines].reverse() : lines)
