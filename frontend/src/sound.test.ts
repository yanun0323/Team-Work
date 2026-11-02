import { afterEach, expect, it, vi } from 'vitest'
import { DEFAULT_PREFS, MUSIC_STYLES, usePrefs } from './prefs'
import { useStore } from './core/store'
import { silenced, SoundPlayer, subscribeNoticeSound } from './sound'
import { effectSamples, musicSamples, NOTICE_DUCK, NOTICE_ECHO, NOTICE_GAP, NOTICE_LEAD_IN, NOTICE_NOTES, NOTICE_SECONDS, TAP_SECOND_SNAP, TUTORIAL_SECONDS, type Stereo } from './soundSynth'

const param = () => ({ value: 0, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn(), cancelScheduledValues: vi.fn(), setTargetAtTime: vi.fn() })
class Node {
  onended?: () => void
  gain = param()
  frequency = param()
  playbackRate = param()
  delayTime = { value: 0 }
  connect = vi.fn((next) => next)
  disconnect = vi.fn()
  start = vi.fn()
  stop = vi.fn()
}
function context() {
  const gains: Node[] = [], sources: Node[] = []
  const audio = {
    state: 'running', currentTime: 10, destination: {},
    createGain: () => { const n = new Node(); gains.push(n); return n },
    createBuffer: (channels: number, length: number) => ({ channels, length, copyToChannel: vi.fn() }),
    createBufferSource: () => { const n = new Node(); sources.push(n); return n },
    suspend: vi.fn(async () => { audio.state = 'suspended' }),
    resume: vi.fn(async () => { audio.state = 'running' }),
    close: vi.fn(async () => { audio.state = 'closed' }),
  }
  return { audio, gains, sources, player: new SoundPlayer(audio as unknown as AudioContext) }
}
afterEach(() => { usePrefs.setState(DEFAULT_PREFS); vi.unstubAllGlobals() })

/** Loudness of a slice of the mix, by second. */
const loudness = ([left, right]: Stereo, from: number, to: number, rate: number) => {
  let energy = 0
  const first = Math.floor(from * rate), last = Math.min(left.length, Math.floor(to * rate))
  for (let i = first; i < last; i++) energy += left[i] * left[i] + right[i] * right[i]
  return Math.sqrt(energy / (2 * (last - first)))
}
const sideLoudness = (channel: Float32Array, from: number, to: number, rate: number) => loudness([channel as Float32Array<ArrayBuffer>, channel as Float32Array<ArrayBuffer>], from, to, rate)

it('offers bossa first, as the default', () => {
  expect(MUSIC_STYLES[0].id).toBe('bossa')
  expect(DEFAULT_PREFS.musicStyle).toBe('bossa')
})

it('synthesizes four distinct stereo pieces: finite, unclipped, evenly loud and seamless', () => {
  const lengths = new Set<number>()
  for (const { id } of MUSIC_STYLES) {
    const data = musicSamples(id, 8000)
    const [left, right] = data
    lengths.add(left.length)
    // Long enough not to wear thin while someone works.
    expect(left.length / 8000, id).toBeGreaterThan(40)
    let peak = 0, difference = 0
    for (let i = 0; i < left.length; i++) {
      peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]))
      difference += Math.abs(left[i] - right[i])
    }
    expect(peak, id).toBeLessThanOrEqual(0.8)
    expect(difference, `${id} is stereo`).toBeGreaterThan(1)
    const rms = loudness(data, 0, left.length / 8000, 8000)
    expect(rms, id).toBeGreaterThan(0.05)
    expect(rms, id).toBeLessThan(0.13)
    for (const channel of data) expect(Math.abs(channel[0] - channel[channel.length - 1]), id).toBeLessThan(0.05)
  }
  expect(lengths.size).toBe(4)
})

it('renders the same samples every time', () => {
  expect(musicSamples('bossa', 8000)).toEqual(musicSamples('bossa', 8000))
  expect(effectSamples('soundTakeoff', 8000)).toEqual(effectSamples('soundTakeoff', 8000))
})

it('shapes aircraft sounds around what the plane does on screen', () => {
  const rate = 16000
  const takeoff = effectSamples('soundTakeoff', rate)
  // Loudest around rotation (5.6s in), then gone.
  expect(loudness(takeoff, 5, 6.2, rate)).toBeGreaterThan(loudness(takeoff, 0.5, 1.7, rate) * 1.5)
  expect(loudness(takeoff, 5, 6.2, rate)).toBeGreaterThan(loudness(takeoff, 11.5, 12.7, rate) * 3)
  const landing = effectSamples('soundLanding', rate)
  // A tyre chirp at the touchdown (7.5s in), then the swell of reverse thrust.
  expect(loudness(landing, 7.5, 7.6, rate)).toBeGreaterThan(loudness(landing, 7.3, 7.45, rate) * 1.2)
  expect(loudness(landing, 8.8, 9.4, rate)).toBeGreaterThan(loudness(landing, 6.8, 7.4, rate) * 1.2)
  const flyover = effectSamples('soundFlyover', rate)
  expect(loudness(flyover, 2.5, 3.5, rate)).toBeGreaterThan(loudness(flyover, 0.2, 1.2, rate) * 2)
  // It crosses the stereo image.
  expect(sideLoudness(flyover[0], 0.5, 1.5, rate)).toBeGreaterThan(sideLoudness(flyover[1], 0.5, 1.5, rate) * 2)
  expect(sideLoudness(flyover[1], 4.5, 5.5, rate)).toBeGreaterThan(sideLoudness(flyover[0], 4.5, 5.5, rate) * 2)
})

it('keeps the chime quick, with three separate rising notes and one soft echo', () => {
  const rate = 16000
  const samples = effectSamples('soundNotice', rate)
  expect(NOTICE_SECONDS).toBeLessThan(1)
  expect(samples[0].length).toBe(Math.floor(NOTICE_SECONDS * rate))
  expect(NOTICE_NOTES).toHaveLength(3)
  expect([...NOTICE_NOTES]).toEqual([...NOTICE_NOTES].sort((a, b) => a - b))
  NOTICE_NOTES.forEach((_, i) => {
    const start = i * NOTICE_GAP
    expect(loudness(samples, start + 0.005, start + 0.05, rate)).toBeGreaterThan(0.15)
  })
  expect(Math.max(...samples[0].map(Math.abs))).toBeLessThanOrEqual(0.5)
  // Fades out by the end instead of being cut off.
  expect(loudness(samples, NOTICE_SECONDS - 0.03, NOTICE_SECONDS, rate)).toBeLessThan(0.01)
  // The notes are centred; only the echo, which starts after its delay, spreads the channels apart.
  const spread = (from: number, to: number) => Math.max(...samples[0].slice(from * rate, to * rate).map((x, i) => Math.abs(x - samples[1][Math.floor(from * rate) + i])))
  expect(spread(0, NOTICE_ECHO.delay - 0.005)).toBe(0)
  expect(spread(NOTICE_ECHO.delay, NOTICE_ECHO.delay + 0.05)).toBeGreaterThan(0.01)
})

it('keeps the tutorial cue short and softer than the noticeboard chime, fading out', () => {
  const rate = 16000
  const samples = effectSamples('soundTutorial', rate)
  expect(samples[0].length).toBe(Math.floor(TUTORIAL_SECONDS * rate))
  expect(samples.every((ch) => ch.every(Number.isFinite))).toBe(true)
  expect(Math.max(...samples[0].map(Math.abs), ...samples[1].map(Math.abs))).toBeLessThanOrEqual(0.35)
  expect(loudness(samples, 0, TUTORIAL_SECONDS, rate)).toBeLessThan(loudness(effectSamples('soundNotice', rate), 0, TUTORIAL_SECONDS, rate))
  expect(loudness(samples, TUTORIAL_SECONDS - 0.02, TUTORIAL_SECONDS, rate)).toBeLessThan(0.01)
})

it('keeps interface taps short, quieter than everything else, and a double snap', () => {
  const rate = 32000
  const samples = effectSamples('soundUI', rate)
  const [left, right] = samples
  expect(left.length / rate).toBeLessThan(0.08)
  expect(Math.max(...left.map(Math.abs))).toBeLessThanOrEqual(0.22)
  expect(right).toEqual(left)
  // The second snap rises out of the first one's decay.
  const before = loudness(samples, TAP_SECOND_SNAP - 0.003, TAP_SECOND_SNAP, rate)
  expect(loudness(samples, TAP_SECOND_SNAP, TAP_SECOND_SNAP + 0.003, rate)).toBeGreaterThan(before * 1.5)
})

it('routes music and effects independently and stops muted effects immediately', () => {
  const { player, sources, gains } = context()
  player.play('soundTakeoff')
  expect(sources).toHaveLength(2)
  const prefs = { ...DEFAULT_PREFS, musicVolume: 0, effectsVolume: 80, soundTakeoff: false }
  usePrefs.setState(prefs)
  player.update(prefs)
  expect(gains[0].gain.setTargetAtTime).toHaveBeenLastCalledWith(0, 10, 0.03)
  expect(gains[1].gain.setTargetAtTime).toHaveBeenLastCalledWith(0, 10, 0.03)
  expect(gains[2].gain.setTargetAtTime).toHaveBeenLastCalledWith(0.48, 10, 0.03)
  expect(sources[1].stop).toHaveBeenLastCalledWith()
  player.play('soundTakeoff')
  expect(sources).toHaveLength(2)
  player.play('soundLanding')
  expect(sources).toHaveLength(3)
  usePrefs.setState({ effectsVolume: 0 })
  player.update(usePrefs.getState())
  player.play('soundUI')
  expect(sources).toHaveLength(3)
  expect(sources[2].stop).toHaveBeenLastCalledWith()
  player.dispose()
})

it('mute silences a channel at once and restores its saved level', () => {
  const { player, sources, gains } = context()
  player.play('soundTakeoff')
  const muted = { ...DEFAULT_PREFS, musicVolume: 40, effectsVolume: 50, musicMuted: true, effectsMuted: true }
  usePrefs.setState(muted)
  player.update(muted)
  expect(gains[0].gain.setTargetAtTime).toHaveBeenLastCalledWith(0, 10, 0.03)
  expect(gains[2].gain.setTargetAtTime).toHaveBeenLastCalledWith(0, 10, 0.03)
  expect(sources[1].stop).toHaveBeenLastCalledWith()
  player.play('soundUI')
  expect(sources).toHaveLength(2)
  const unmuted = { ...muted, musicMuted: false, effectsMuted: false }
  usePrefs.setState(unmuted)
  player.update(unmuted)
  expect(gains[0].gain.setTargetAtTime).toHaveBeenLastCalledWith(0.4, 10, 0.03)
  expect(gains[2].gain.setTargetAtTime).toHaveBeenLastCalledWith(0.3, 10, 0.03)
  player.dispose()
})

it('does not queue suspended effects; stops aircraft when animation is disabled and cleans up', async () => {
  const { player, audio, sources } = context()
  player.play('soundFlyover')
  player.pause()
  expect(audio.suspend).toHaveBeenCalledOnce()
  player.play('soundLanding')
  expect(sources).toHaveLength(2)
  await player.resume()
  usePrefs.setState({ planes: false })
  player.update(usePrefs.getState())
  player.play('soundLanding')
  expect(sources).toHaveLength(2)
  player.play('soundLanding', true)
  player.play('soundUI')
  expect(sources).toHaveLength(4)
  player.dispose()
  for (const source of sources) expect(source.disconnect).toHaveBeenCalled()
  expect(audio.close).toHaveBeenCalledOnce()
})


it('cross-fades music only when the style changes and cleans up outgoing tracks', () => {
  const { player, sources, gains } = context()
  player.update({ ...DEFAULT_PREFS, musicVolume: 50 })
  expect(sources).toHaveLength(1)
  player.update({ ...DEFAULT_PREFS, musicStyle: 'ambient' })
  expect(sources).toHaveLength(2)
  expect(sources[0].stop).toHaveBeenCalledWith(11.2)
  expect(gains[gains.length - 1].gain.linearRampToValueAtTime).toHaveBeenCalledWith(1, 11.2)
  player.update({ ...DEFAULT_PREFS, musicStyle: 'ambient', effectsVolume: 0 })
  expect(sources).toHaveLength(2)
  player.update({ ...DEFAULT_PREFS, musicStyle: 'bossa' })
  player.dispose()
  for (const source of sources) expect(source.disconnect).toHaveBeenCalled()
})

it('plays notification chimes independently of aircraft and honors their own mute', () => {
  const { player, sources } = context()
  usePrefs.setState({ planes: false })
  player.play('soundNotice')
  expect(sources).toHaveLength(2)
  expect(sources[1].start).toHaveBeenCalledWith(10 + NOTICE_LEAD_IN)
  usePrefs.setState({ soundNotice: false })
  player.update(usePrefs.getState())
  expect(sources[1].stop).toHaveBeenLastCalledWith()
  player.play('soundNotice')
  expect(sources).toHaveLength(2)
  player.dispose()
})

it('varies the pitch of interface taps and renders each effect once', () => {
  const { player, audio, sources } = context()
  const createBuffer = vi.spyOn(audio, 'createBuffer')
  player.play('soundUI')
  player.play('soundUI')
  expect(createBuffer).toHaveBeenCalledOnce()
  const rates = sources.slice(1).map((source) => source.playbackRate.value)
  for (const rate of rates) { expect(rate).toBeGreaterThanOrEqual(0.95); expect(rate).toBeLessThanOrEqual(1.05) }
  player.dispose()
})

it('sounds once per fresh notice batch, never for existing notices, rerenders or snapshots', () => {
  const initial = useStore.getState()
  const tasks = Object.values(initial.world.tasks)
  const task = tasks.find((t) => t.stage === 'running')!
  const review = { kind: 'review' as const, taskId: task.id, subId: 'sub' }
  const notify = vi.fn()
  useStore.setState({ loaded: true, offline: false, toasts: [{ id: 1, event: review }] })
  const unsubscribe = subscribeNoticeSound(notify)
  try {
    expect(notify).not.toHaveBeenCalled()
    useStore.setState({ failure: 'irrelevant' })
    expect(notify).not.toHaveBeenCalled()
    useStore.setState({ toasts: [{ id: 2, event: review }] })
    expect(notify).toHaveBeenCalledTimes(1)
    // Replacing one notification with another leaves the count unchanged.
    useStore.setState({ toasts: [{ id: 3, event: { kind: 'awaitMerge', taskId: task.id } }] })
    expect(notify).toHaveBeenCalledTimes(2)
    useStore.setState({ toasts: [{ id: 4, event: review }, { id: 5, event: review }] })
    expect(notify).toHaveBeenCalledTimes(3)
    useStore.getState().receive({ type: 'snapshot', world: initial.world })
    expect(notify).toHaveBeenCalledTimes(3)
    useStore.setState({ toasts: [{ id: 6, event: { ...review, taskId: 'deleted' } }] })
    useStore.setState({ offline: true, toasts: [{ id: 7, event: review }] })
    useStore.setState({ offline: false })
    expect(notify).toHaveBeenCalledTimes(3)
  } finally { unsubscribe(); useStore.setState(initial) }
})


it('ducks music and all other effects through the chime, respecting changed preferences', () => {
  const { player, sources, gains } = context()
  for (const gain of gains.slice(1, 4)) expect(gain.gain.setTargetAtTime).toHaveBeenLastCalledWith(0.6, 10, 0.03)
  player.play('soundLanding')
  player.play('soundNotice')
  for (const gain of gains.slice(1, 4)) expect(gain.gain.setTargetAtTime).toHaveBeenLastCalledWith(0.6 * NOTICE_DUCK, 10, 0.015)
  expect(gains[0].gain.setTargetAtTime).toHaveBeenLastCalledWith(NOTICE_DUCK, 10, 0.015)
  expect(gains[4].gain.setTargetAtTime).toHaveBeenLastCalledWith(NOTICE_DUCK, 10, 0.015)
  expect(gains[5].gain.setTargetAtTime).toHaveBeenLastCalledWith(1, 10, 0.015)
  const chime = sources[sources.length - 1]
  usePrefs.setState({ musicVolume: 40, effectsVolume: 50, soundTakeoff: false, soundUI: false })
  player.update(usePrefs.getState())
  player.stop('soundNotice')
  expect(chime.disconnect).toHaveBeenCalled()
  expect(gains[1].gain.setTargetAtTime).toHaveBeenLastCalledWith(0, 10, 0.03)
  for (const gain of gains.slice(2, 4)) expect(gain.gain.setTargetAtTime).toHaveBeenLastCalledWith(0.3, 10, 0.03)
  expect(gains[0].gain.setTargetAtTime).toHaveBeenLastCalledWith(0.4, 10, 0.03)
  expect(gains[4].gain.setTargetAtTime).toHaveBeenLastCalledWith(0, 10, 0.03)
  player.dispose()
})

it('restores the mix after natural completion, without an older chime restoring over a new one', () => {
  const { player, sources, gains } = context()
  player.play('soundNotice')
  const old = sources[sources.length - 1]
  player.play('soundNotice')
  const current = sources[sources.length - 1]
  old.onended?.()
  expect(gains[0].gain.setTargetAtTime).toHaveBeenLastCalledWith(NOTICE_DUCK, 10, 0.015)
  current.onended?.()
  expect(gains[0].gain.setTargetAtTime).toHaveBeenLastCalledWith(1, 10, 0.03)
  expect(gains[4].gain.setTargetAtTime).toHaveBeenLastCalledWith(1, 10, 0.03)
  for (const gain of gains.slice(1, 4)) expect(gain.gain.setTargetAtTime).toHaveBeenLastCalledWith(0.6, 10, 0.03)
  player.dispose()
})

it('cancels a chime muted during its lead-in and restores the mix', () => {
  const { player, sources, gains } = context()
  player.play('soundNotice')
  const source = sources[sources.length - 1]
  expect(gains[0].gain.setTargetAtTime).toHaveBeenLastCalledWith(NOTICE_DUCK, 10, 0.015)
  usePrefs.setState({ soundNotice: false })
  player.update(usePrefs.getState())
  expect(source.stop).toHaveBeenLastCalledWith()
  expect(source.disconnect).toHaveBeenCalled()
  expect(gains[0].gain.setTargetAtTime).toHaveBeenLastCalledWith(1, 10, 0.03)
  player.dispose()
})

it('goes quiet in the background only if asked to', () => {
  const page = (hidden: boolean, focused: boolean) => ({ hidden, hasFocus: () => focused })
  expect(silenced(true, page(false, true))).toBe(false)
  expect(silenced(true, page(true, true))).toBe(true)
  expect(silenced(true, page(false, false))).toBe(true)
  expect(silenced(false, page(true, false))).toBe(false)
})
