// Shared preferences; real clients read and write them through the backend.

import { create } from 'zustand'
import { MOCK } from './core/mode'
import { request } from './core/backend'
import { attempt } from './core/ops'
import type { Tab } from './DrawerTabs'
import type { Daylight } from './daylight'

/** The airport's tabs. */
export const AIRPORT_TABS = [
  { id: 'chats', label: '對話#tab' },
  { id: 'providers', label: '模型供應商' },
  { id: 'blueprints', label: '員工藍圖' },
  { id: 'flows', label: '任務藍圖#tab' },
  { id: 'sources', label: '來源#tab' },
  { id: 'stats', label: '統計' },
  { id: 'terminal', label: '終端機' },
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

/** How long, in seconds, the map may be left alone before the camera follows someone on the island; 0 is off. The backend checks the same. */
export const IDLE_FOLLOWS = [0, 5, 15, 30, 60, 300, 900, 1800, 3600, 10800] as const

export const IDLE_FOLLOW_TARGETS = { map: '僅地圖人物', all: '所有人物' } as const
export type IdleFollowTarget = keyof typeof IDLE_FOLLOW_TARGETS

export const MAP_CLICKS = { home: '直接回到主畫面', sheets: '先關閉頁面' } as const
/** What a click on the map does while a company or the airport is open: close it at once, or first put away its open detail sheets. */
export type MapClick = keyof typeof MAP_CLICKS

export const AUTO_TABS = { off: '關#switch', chats: '開：未讀對話優先', tasks: '開：待處理任務優先' } as const
/** Opens a company or the airport on a tab with something waiting, the one named first when both are; off always opens the default tab. */
export type AutoTab = keyof typeof AUTO_TABS

export const BUSY_ANIMATIONS = { off: '關閉#view', money: '撒錢', shout: '粗線條' } as const
/** money tosses bills off one side of a busy building, then the other; shout flickers cartoon strokes off both sides; off shows neither (the progress ring on the label stays). */
export type BusyAnimation = keyof typeof BUSY_ANIMATIONS

export const DAYLIGHTS = { real: '跟隨真實時間', minecraft: 'Minecraft', day: '永遠白天', night: '永遠夜晚' } as const satisfies Record<Daylight, string>

export type LogOrder = 'newestFirst' | 'newestLast'

export interface Prefs {
  /** Music and effects stop while the app or page is not the one in use. */
  muteInBackground: boolean
  /** The Mac app posts macOS notifications for what waits on the user, and counts it on its Dock icon. */
  systemNotices: boolean
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
  /** The time of day the town shows: the computer's clock, a 20-minute Minecraft day, or always day or night. */
  daylight: Daylight
  /** A company's terminal runs on when the company closes, until the app does. */
  keepTerminals: boolean
  mapClick: MapClick
  /** What the camera does on opening a company or the airport, or picking a plot. */
  autoView: AutoView
  /** What a company's building shows while it is at work. */
  busyAnimation: BusyAnimation
  /** How fast the wheel zooms the map, in percent of the normal speed. */
  zoomSensitivity: number
  /** Seconds the map is left alone before the camera picks someone on the island to follow; 0 turns it off. */
  idleFollow: number
  /** Map people only, or also employees inside offices. */
  idleFollowTarget: IdleFollowTarget
  /** Typed into each terminal as it starts; empty runs nothing. */
  terminalCommand: string
  /** The tab a company's file opens on. */
  defaultTab: Tab
  /** The tab the airport opens on. */
  defaultAirportTab: AirportTab
  /** On opening, a tab with something waiting comes before the default tab. */
  autoTab: AutoTab
  /** Names each new chat from its first message with this model; empty turns it off. */
  chatTitleModel: string
  chatTitleEffort: string
  /** The ChatGPT subscription every employee draws pictures with; empty gives nobody image_gen. */
  imageProvider: string
  /** The built-in blueprints read skills from ~/.codex/ and ~/.claude/. */
  codexSkills: boolean
  claudeSkills: boolean
  /** Left out of every list to pick from and out of employees' tools; whatever is already on them keeps them. */
  hiddenBlueprints: string[]
  hiddenWorkflows: string[]
  /** How full, in percent, a chat on a model of 1M tokens or more, 256K or more, 128K or more, or less may get before it is summed up. */
  compact1M: number
  compact256K: number
  compact128K: number
  compactSmall: number
}

/** The compaction percentages as they come, and their range; the backend checks the same. */
export const COMPACT_DEFAULTS = { compact1M: 40, compact256K: 90, compact128K: 95, compactSmall: 95 } satisfies Partial<Prefs>
export const COMPACT_SHARE = { min: 10, max: 100 }

export const DEFAULT_PREFS: Prefs = { muteInBackground: true, systemNotices: true, musicStyle: 'bossa', soundNotice: true, soundTutorial: true, soundOpenTeam: true, soundOpenAirport: true, soundWaves: true, musicVolume: 50, effectsVolume: 100, musicMuted: false, effectsMuted: false, soundTakeoff: true, soundLanding: true, soundFlyover: true, soundUI: true, logOrder: 'newestFirst', detail: true, shadows: true, crowd: true, planes: true, clouds: true, daylight: 'minecraft', keepTerminals: false, mapClick: 'sheets', autoView: 'panZoom', busyAnimation: 'money', zoomSensitivity: 100, idleFollow: 15, idleFollowTarget: 'map', terminalCommand: '', defaultTab: 'tasks', defaultAirportTab: 'providers', autoTab: 'chats', chatTitleModel: '', chatTitleEffort: '', imageProvider: '', codexSkills: true, claudeSkills: true, hiddenBlueprints: [], hiddenWorkflows: [], ...COMPACT_DEFAULTS }

/** The range of `zoomSensitivity`; the backend checks the same. */
export const ZOOM_SENSITIVITY = { min: 20, max: 300 }

export const usePrefs = create<Prefs & { set: (p: Partial<Prefs>) => void }>()((set) => ({
  ...DEFAULT_PREFS,
  // `make dev-mock` starts silent; unmute from the settings.
  ...(import.meta.env.MODE === 'mock' && { musicMuted: true, effectsMuted: true }),
  set: (patch) => {
    if (MOCK) set(patch)
    else void attempt(() => request('PATCH', '/settings/preferences', patch))
  },
}))

/** Log lines in the order the preference asks for; they come oldest first. */
export const ordered = <T,>(lines: T[], order: LogOrder) => (order === 'newestFirst' ? [...lines].reverse() : lines)
