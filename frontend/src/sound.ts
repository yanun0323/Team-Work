// Original synthesized music and effects; no downloads or third-party recordings.
import { useEffect } from 'react'
import { usePrefs, type Prefs, type MusicStyle } from './prefs'
import { useStore, type Toast } from './core/store'

export const SOUND_EFFECTS = [
  { key: 'soundTakeoff', label: '飛機起飛' },
  { key: 'soundLanding', label: '飛機降落' },
  { key: 'soundFlyover', label: '飛機飛越' },
  { key: 'soundUI', label: '介面操作' },
  { key: 'soundNotice', label: '告示牌通知' },
] as const
export type SoundEffect = (typeof SOUND_EFFECTS)[number]['key']

// An original ascending four-note announcement cue, not an airport recording.
export const NOTICE_NOTES = [523.25, 659.25, 783.99, 1046.5] as const
const RATE = 22050
const CHORDS = [[48, 55, 60, 64], [45, 52, 60, 64], [41, 48, 57, 60], [43, 50, 57, 62]]
const MELODY = [72, 76, 79, 76, 69, 72, 76, 72, 69, 72, 77, 72, 71, 74, 79, 74]
const hz = (note: number) => 440 * 2 ** ((note - 69) / 12)

/** Original arrangements with different timing, voicings and instruments. Wrap tails into the loop. */
export function musicSamples(rate = RATE, style: MusicStyle = 'chiptune') {
  const beat = { piano: 1, ambient: 1.5, bossa: 0.625, chiptune: 0.5 }[style]
  const samples = new Float32Array(Math.round(rate * beat * 32))
  const note = (midi: number, start: number, seconds: number, level: number) => {
    const frequency = hz(midi)
    for (let i = 0; i < Math.floor(seconds * rate); i++) {
      const t = i / rate, phase = 2 * Math.PI * frequency * t
      const attack = style === 'ambient' ? 0.8 : 0.015
      const decay = style === 'ambient' ? 0.35 : style === 'bossa' ? 4 : 2.4
      const envelope = Math.min(1, t / attack) * Math.exp(-decay * t) * Math.min(1, (seconds - t) / 0.2)
      // Band-limited odd harmonics evoke a game console without harsh square-wave aliasing.
      const wave = style === 'chiptune'
        ? Math.sin(phase) + Math.sin(phase * 3) / 3 + Math.sin(phase * 5) / 5
        : Math.sin(phase) + (style === 'ambient' ? 0.08 : 0.18) * Math.sin(phase * 2)
      samples[(Math.round(start * rate) + i) % samples.length] += wave * envelope * level
    }
  }
  for (let bar = 0; bar < 8; bar++) {
    const chord = CHORDS[bar % 4], start = bar * beat * 4
    if (style === 'ambient') {
      chord.forEach((pitch) => note(pitch, start, beat * 7, 0.035))
      note(MELODY[bar * 2], start + beat, beat * 4, 0.045)
    } else if (style === 'bossa') {
      // Alternating bass and syncopated plucked seventh chords.
      for (const pulse of [0, 2]) note(chord[pulse ? 1 : 0] - 12, start + pulse * beat, beat * 1.5, 0.09)
      for (const pulse of [0.5, 1.5, 3]) [...chord.slice(1), chord[0] + 10].forEach((pitch, i) => note(pitch, start + pulse * beat + i * 0.018, beat * 1.5, 0.045))
      note(MELODY[bar * 2], start, beat * 2, 0.055)
      note(MELODY[bar * 2 + 1], start + 2.5 * beat, beat * 1.5, 0.055)
    } else if (style === 'chiptune') {
      for (let pulse = 0; pulse < 8; pulse++) note(chord[pulse % 4] + 12, start + pulse * beat / 2, beat * 0.8, 0.055)
      for (const pulse of [0, 2]) note(chord[0] - 12, start + pulse * beat, beat, 0.08)
      note(MELODY[bar * 2] + 12, start, beat * 2, 0.035)
    } else {
      chord.forEach((pitch, i) => note(pitch, start + i * 0.08, 4, 0.045))
      for (let pulse = 0; pulse < 4; pulse++) note(MELODY[(bar * 2 + pulse) % MELODY.length], start + pulse, 2, pulse % 2 ? 0.035 : 0.065)
    }
  }
  return samples
}

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

export class SoundPlayer {
  private music: GainNode
  private effects = new Map<SoundEffect, GainNode>()
  private active = new Map<SoundEffect, () => void>()
  private style?: MusicStyle
  private song?: { source: AudioBufferSourceNode; gain: GainNode }
  private songs = new Set<{ source: AudioBufferSourceNode; gain: GainNode }>()
  private noise: AudioBuffer

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
    this.noise = context.createBuffer(1, RATE * 2, RATE)
    const noise = this.noise.getChannelData(0)
    for (let i = 0; i < noise.length; i++) noise[i] = Math.random() * 2 - 1
    this.update(usePrefs.getState())
  }

  private changeMusic(style: MusicStyle) {
    if (style === this.style) return
    const context = this.context, now = context.currentTime
    if (this.song) {
      this.song.gain.gain.cancelScheduledValues(now)
      this.song.gain.gain.setTargetAtTime(0, now, 0.06)
      this.song.source.stop(now + 0.3)
    }
    const data = musicSamples(RATE, style)
    const buffer = context.createBuffer(1, data.length, RATE)
    buffer.copyToChannel(data, 0)
    const source = context.createBufferSource(), gain = context.createGain()
    gain.gain.setValueAtTime(0, now)
    gain.gain.linearRampToValueAtTime(1, now + 0.3)
    source.buffer = buffer
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
    const duck = this.active.has('soundNotice') ? 0.12 : 1
    const level = (gain: GainNode, value: number) => {
      gain.gain.cancelScheduledValues(now)
      gain.gain.setTargetAtTime(value, now, duck < 1 ? 0.015 : 0.03)
    }
    // Notification priority lasts through the echo tail; never change saved volumes.
    level(this.music, prefs.musicVolume / 100 * duck)
    for (const { key } of SOUND_EFFECTS) {
      level(this.effects.get(key)!, prefs[key] ? prefs.effectsVolume / 100 * (aircraft(key) ? 0.6 : 1) * (key === 'soundNotice' ? 1 : duck) : 0)
    }
  }

  update(prefs: Prefs) {
    this.changeMusic(prefs.musicStyle)
    for (const { key } of SOUND_EFFECTS) {
      if (!prefs[key] || prefs.effectsVolume === 0 || (aircraft(key) && !prefs.planes)) this.stop(key)
    }
    this.mixLevels(prefs)
  }

  play(key: SoundEffect, preview = false) {
    const prefs = usePrefs.getState()
    if (this.context.state !== 'running' || !prefs[key] || !prefs.effectsVolume || (!preview && aircraft(key) && !prefs.planes)) return
    this.stop(key)
    const context = this.context, now = context.currentTime
    const notice = key === 'soundNotice'
    const onset = now + (notice ? 0.08 : 0)
    const click = key === 'soundUI' || notice
    const duration = notice ? 2.75 : click ? 0.09 : key === 'soundFlyover' ? 6 : 10
    const envelope = context.createGain()
    envelope.connect(this.effects.get(key)!)
    // One soft repeat, no feedback loop; muting disconnects both dry sound and echo.
    const echo = notice ? context.createDelay(0.2) : undefined
    const wet = notice ? context.createGain() : undefined
    if (echo && wet) {
      echo.delayTime.value = 0.18
      wet.gain.value = 0.32
      envelope.connect(echo).connect(wet).connect(this.effects.get(key)!)
    }
    envelope.gain.setValueAtTime(0, now)
    if (notice) {
      for (let i = 0; i < NOTICE_NOTES.length; i++) {
        const start = onset + i * 0.55
        envelope.gain.setValueAtTime(0, start)
        envelope.gain.linearRampToValueAtTime(0.28, start + 0.012)
        envelope.gain.setValueAtTime(0.28, start + 0.12)
        envelope.gain.exponentialRampToValueAtTime(0.001, start + (i === 3 ? 1.08 : 0.52))
        envelope.gain.linearRampToValueAtTime(0, start + (i === 3 ? 1.1 : 0.54))
      }
    } else {
      envelope.gain.linearRampToValueAtTime(click ? 0.12 : 0.32, now + (click ? 0.008 : duration * 0.3))
      envelope.gain.linearRampToValueAtTime(0, now + duration)
    }
    const source = click ? context.createOscillator() : context.createBufferSource()
    const filter = context.createBiquadFilter()
    if (source instanceof OscillatorNode) {
      source.type = 'sine'
      if (notice) {
        // A restrained second/third harmonic makes the bell clearer on small speakers.
        source.setPeriodicWave(context.createPeriodicWave(new Float32Array(4), new Float32Array([0, 1, 0.25, 0.12])))
        NOTICE_NOTES.forEach((frequency, i) => source.frequency.setValueAtTime(frequency, onset + i * 0.55))
      }
      else {
        source.frequency.setValueAtTime(660, now)
        source.frequency.exponentialRampToValueAtTime(440, now + duration)
      }
    } else {
      source.buffer = this.noise
      source.loop = true
      source.playbackRate.setValueAtTime(key === 'soundTakeoff' ? 0.65 : 1, now)
      source.playbackRate.linearRampToValueAtTime(key === 'soundTakeoff' ? 1.3 : 0.6, now + duration)
    }
    filter.type = 'lowpass'
    filter.frequency.setValueAtTime(notice ? 4000 : click ? 2000 : 350, now)
    if (!click) {
      filter.frequency.linearRampToValueAtTime(key === 'soundTakeoff' ? 1400 : 700, now + duration * 0.4)
      filter.frequency.linearRampToValueAtTime(180, now + duration)
    }
    source.connect(filter).connect(envelope)
    const clean = () => {
      source.disconnect(); filter.disconnect(); envelope.disconnect()
      echo?.disconnect(); wet?.disconnect()
      if (this.active.get(key) === stop) {
        this.active.delete(key)
        if (notice) this.mixLevels(usePrefs.getState())
      }
    }
    const stop = () => { source.stop(); clean() }
    source.onended = clean
    this.active.set(key, stop)
    if (notice) this.mixLevels(prefs)
    source.start(onset)
    source.stop(onset + duration + (notice ? 0.2 : 0))
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

let player: SoundPlayer | undefined
export function playSound(key: SoundEffect, preview = false) {
  if (typeof document !== 'undefined' && !document.hidden) player?.play(key, preview)
}
export function stopSound(key: SoundEffect) { player?.stop(key) }

/** One audio owner, created only by a user gesture. Hidden pages never keep playing. */
export function useSound() {
  useEffect(() => {
    let disposed = false
    const unlock = () => {
      if (document.hidden || typeof AudioContext === 'undefined') return
      try {
        player ??= new SoundPlayer(new AudioContext())
        const current = player
        void current.resume().then(() => { if (disposed || document.hidden) current.pause() }).catch(() => {})
      } catch { /* Audio is optional on browsers without an available output device. */ }
    }
    const key = (event: KeyboardEvent) => { if (!event.repeat) unlock() }
    const click = (event: MouseEvent) => {
      if (event.target instanceof Element && event.target.closest('button:not(:disabled)') && !event.target.closest('[data-sound-controls]')) playSound('soundUI')
    }
    const visibility = () => { if (document.hidden) player?.pause(); else if (player) unlock() }
    const unsubscribeNotices = subscribeNoticeSound(() => playSound('soundNotice'))
    const unsubscribe = usePrefs.subscribe((prefs) => player?.update(prefs))
    document.addEventListener('pointerdown', unlock)
    document.addEventListener('keydown', key)
    document.addEventListener('click', click)
    document.addEventListener('visibilitychange', visibility)
    return () => {
      disposed = true
      unsubscribe()
      unsubscribeNotices()
      document.removeEventListener('pointerdown', unlock)
      document.removeEventListener('keydown', key)
      document.removeEventListener('click', click)
      document.removeEventListener('visibilitychange', visibility)
      player?.dispose(); player = undefined
    }
  }, [])
}
