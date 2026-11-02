// Plays the synthesized music and effects (soundSynth.ts) through Web Audio.
import { useEffect } from 'react'
import { usePrefs, type Prefs, type MusicStyle } from './prefs'
import { useStore, type Toast } from './core/store'
import type { World } from './core/domain/types'
import { effectSamples, musicSamples, NOTICE_DUCK, NOTICE_LEAD_IN, RATE, type Stereo } from './soundSynth'

export const SOUND_EFFECTS = [
  { key: 'soundTakeoff', label: '飛機起飛' },
  { key: 'soundLanding', label: '飛機降落' },
  { key: 'soundFlyover', label: '飛機飛越' },
  { key: 'soundUI', label: '介面操作' },
  { key: 'soundNotice', label: '通知' },
  { key: 'soundTutorial', label: '教學提示' },
  { key: 'soundOpenTeam', label: '打開公司' },
  { key: 'soundOpenAirport', label: '打開機場' },
] as const
export type SoundEffect = (typeof SOUND_EFFECTS)[number]['key']

/** How long music styles take to cross over, seconds. */
const CROSSFADE = 1.2

const aircraft = (key: SoundEffect) => key === 'soundTakeoff' || key === 'soundLanding' || key === 'soundFlyover'

/** Use actual notice events, not badge counts: two tasks can exchange places without changing the count. */
export function subscribeNoticeSound(notify: () => void) {
  let latest = Math.max(0, ...useStore.getState().toasts.map((toast) => toast.id))
  return useStore.subscribe((state) => {
    const fresh: Toast[] = state.toasts.filter((toast) => toast.id > latest)
    if (!fresh.length) return
    latest = Math.max(latest, ...fresh.map((toast) => toast.id))
    if (!state.loaded || state.offline) return
    if (fresh.some(({ event }) => {
      if (event.kind !== 'review' && event.kind !== 'awaitMerge') return false
      const task = state.world.tasks[event.taskId]
      return task && task.stage !== 'cancelled' && task.stage !== 'done' && !!state.world.teams[task.teamId]
    })) notify()
  })
}

/** Chats on screen right now; they are read at once, so they stay quiet. */
const watched = new Map<string, number>()
export function watchChat(id: string) {
  watched.set(id, (watched.get(id) ?? 0) + 1)
  return () => {
    const n = (watched.get(id) ?? 1) - 1
    if (n) watched.set(id, n); else watched.delete(id)
  }
}

/**
 * Sound when a chat turns unread, which the badge counts only once its reply has ended, and nobody has it open.
 * The first world and the snapshot after a lost connection only set what counts as already unread.
 */
export function subscribeChatSound(notify: () => void) {
  const unread = (chats: World['chats']) => new Set(Object.values(chats).filter((chat) => chat.unread && chat.replyAt === undefined).map((chat) => chat.id))
  let seen = unread(useStore.getState().world.chats)
  return useStore.subscribe((state, previous) => {
    if (state.world.chats === previous.world.chats) return
    const now = unread(state.world.chats)
    const fresh = previous.loaded && !previous.offline && [...now].some((id) => !seen.has(id) && !watched.has(id))
    seen = now
    if (fresh) notify()
  })
}

export class SoundPlayer {
  private music: GainNode
  private effects = new Map<SoundEffect, GainNode>()
  private active = new Map<SoundEffect, () => void>()
  private style?: MusicStyle
  private song?: { source: AudioBufferSourceNode; gain: GainNode }
  private songs = new Set<{ source: AudioBufferSourceNode; gain: GainNode }>()
  private sounds = new Map<SoundEffect, AudioBuffer>()

  constructor(private context: AudioContext) {
    this.music = context.createGain()
    this.music.gain.value = 0
    this.music.connect(context.destination)
    for (const { key } of SOUND_EFFECTS) {
      const gain = context.createGain()
      gain.gain.value = 0
      gain.connect(context.destination)
      this.effects.set(key, gain)
    }
    this.update(usePrefs.getState())
  }

  private buffer(samples: Stereo) {
    const buffer = this.context.createBuffer(2, samples[0].length, RATE)
    samples.forEach((channel, i) => buffer.copyToChannel(channel, i))
    return buffer
  }

  private changeMusic(style: MusicStyle) {
    if (style === this.style) return
    const context = this.context, now = context.currentTime
    if (this.song) {
      this.song.gain.gain.cancelScheduledValues(now)
      this.song.gain.gain.setTargetAtTime(0, now, CROSSFADE / 4)
      this.song.source.stop(now + CROSSFADE)
    }
    const source = context.createBufferSource(), gain = context.createGain()
    gain.gain.setValueAtTime(0, now)
    gain.gain.linearRampToValueAtTime(1, now + CROSSFADE)
    source.buffer = this.buffer(musicSamples(style))
    source.loop = true
    source.connect(gain).connect(this.music)
    const song = { source, gain }
    source.onended = () => { source.disconnect(); gain.disconnect(); this.songs.delete(song) }
    this.songs.add(song)
    source.start()
    this.song = song
    this.style = style
  }

  private mixLevels(prefs: Prefs) {
    const now = this.context.currentTime
    const duck = this.active.has('soundNotice') ? NOTICE_DUCK : 1
    const level = (gain: GainNode, value: number) => {
      gain.gain.cancelScheduledValues(now)
      gain.gain.setTargetAtTime(value, now, duck < 1 ? 0.015 : 0.03)
    }
    // Notification priority lasts through the echo tail; never change saved volumes.
    level(this.music, prefs.musicMuted ? 0 : prefs.musicVolume / 100 * duck)
    for (const { key } of SOUND_EFFECTS) {
      level(this.effects.get(key)!, prefs[key] && !prefs.effectsMuted ? prefs.effectsVolume / 100 * (aircraft(key) ? 0.6 : 1) * (key === 'soundNotice' ? 1 : duck) : 0)
    }
  }

  update(prefs: Prefs) {
    this.changeMusic(prefs.musicStyle)
    for (const { key } of SOUND_EFFECTS) {
      if (!prefs[key] || prefs.effectsMuted || prefs.effectsVolume === 0 || (aircraft(key) && !prefs.planes)) this.stop(key)
    }
    this.mixLevels(prefs)
  }

  play(key: SoundEffect, preview = false) {
    const prefs = usePrefs.getState()
    if (this.context.state !== 'running' || !prefs[key] || prefs.effectsMuted || !prefs.effectsVolume || (!preview && aircraft(key) && !prefs.planes)) return
    this.stop(key)
    const notice = key === 'soundNotice'
    let buffer = this.sounds.get(key)
    if (!buffer) this.sounds.set(key, buffer = this.buffer(effectSamples(key)))
    const source = this.context.createBufferSource()
    source.buffer = buffer
    // The same tap every time would sound like a machine.
    if (key === 'soundUI') source.playbackRate.value = 0.95 + Math.random() * 0.1
    source.connect(this.effects.get(key)!)
    const clean = () => {
      source.disconnect()
      if (this.active.get(key) === stop) {
        this.active.delete(key)
        if (notice) this.mixLevels(usePrefs.getState())
      }
    }
    const stop = () => { source.stop(); clean() }
    source.onended = clean
    this.active.set(key, stop)
    if (notice) this.mixLevels(prefs)
    // Other sounds duck first, so the chime begins in the clear.
    source.start(this.context.currentTime + (notice ? NOTICE_LEAD_IN : 0))
  }

  stop(key: SoundEffect) { this.active.get(key)?.() }
  pause() {
    for (const key of this.active.keys()) this.stop(key)
    void this.context.suspend().catch(() => {})
  }
  resume() { return this.context.resume() }
  dispose() {
    for (const key of this.active.keys()) this.stop(key)
    for (const { source, gain } of this.songs) { source.stop(); source.disconnect(); gain.disconnect() }
    this.songs.clear()
    this.music.disconnect()
    for (const gain of this.effects.values()) gain.disconnect()
    void this.context.close().catch(() => {})
  }
}

/** Whether sound should stop now: the page is hidden or another window has the focus, and the user wants it quiet then. */
export function silenced(mute: boolean, page: Pick<Document, 'hidden' | 'hasFocus'>) {
  return mute && (page.hidden || !page.hasFocus())
}
const silencedNow = () => silenced(usePrefs.getState().muteInBackground, document)

let player: SoundPlayer | undefined
export function playSound(key: SoundEffect, preview = false) {
  if (typeof document !== 'undefined' && !silencedNow()) player?.play(key, preview)
}
export function stopSound(key: SoundEffect) { player?.stop(key) }

/** One audio owner, created only by a user gesture. In the background it follows the muteInBackground preference. */
export function useSound() {
  useEffect(() => {
    let disposed = false
    const unlock = () => {
      if (silencedNow() || typeof AudioContext === 'undefined') return
      try {
        player ??= new SoundPlayer(new AudioContext())
        const current = player
        void current.resume().then(() => { if (disposed || silencedNow()) current.pause() }).catch(() => {})
      } catch { /* Audio is optional on browsers without an available output device. */ }
    }
    const key = (event: KeyboardEvent) => { if (!event.repeat) unlock() }
    const click = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest('button:not(:disabled)') && !event.target.closest('[data-sound-controls]')) playSound('soundUI')
    }
    const follow = () => { if (silencedNow()) player?.pause(); else if (player) unlock() }
    const unsubscribeNotices = subscribeNoticeSound(() => playSound('soundNotice'))
    const unsubscribeChats = subscribeChatSound(() => playSound('soundNotice'))
    const unsubscribe = usePrefs.subscribe((prefs, before) => {
      player?.update(prefs)
      if (prefs.muteInBackground !== before.muteInBackground) follow()
    })
    document.addEventListener('pointerdown', unlock)
    document.addEventListener('keydown', key)
    document.addEventListener('click', click)
    document.addEventListener('visibilitychange', follow)
    window.addEventListener('blur', follow)
    window.addEventListener('focus', follow)
    return () => {
      disposed = true
      unsubscribe()
      unsubscribeNotices()
      unsubscribeChats()
      document.removeEventListener('pointerdown', unlock)
      document.removeEventListener('keydown', key)
      document.removeEventListener('click', click)
      document.removeEventListener('visibilitychange', follow)
      window.removeEventListener('blur', follow)
      window.removeEventListener('focus', follow)
      player?.dispose(); player = undefined
    }
  }, [])
}
