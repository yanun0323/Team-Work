import { afterEach, expect, it, vi } from 'vitest'
import { DEFAULT_PREFS, MUSIC_STYLES, usePrefs } from './prefs'
import { useStore } from './core/store'
import { musicSamples, NOTICE_NOTES, SoundPlayer, subscribeNoticeSound } from './sound'

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
class Oscillator extends Node { setPeriodicWave = vi.fn() }
function context() {
  const gains: Node[] = [], sources: Node[] = [], delays: Node[] = []
  const audio = {
    state: 'running', currentTime: 10, destination: {},
    createPeriodicWave: vi.fn(() => ({})),
    createDelay: () => { const n = new Node(); delays.push(n); return n },
    createGain: () => { const n = new Node(); gains.push(n); return n },
    createBuffer: (_: number, length: number) => ({ copyToChannel: vi.fn(), getChannelData: () => new Float32Array(length) }),
    createBufferSource: () => { const n = new Node(); sources.push(n); return n },
    createOscillator: () => { const n = new Oscillator(); sources.push(n); return n },
    createBiquadFilter: () => new Node(),
    suspend: vi.fn(async () => { audio.state = 'suspended' }),
    resume: vi.fn(async () => { audio.state = 'running' }),
    close: vi.fn(async () => { audio.state = 'closed' }),
  }
  vi.stubGlobal('OscillatorNode', Oscillator)
  return { audio, gains, sources, delays, player: new SoundPlayer(audio as unknown as AudioContext) }
}
afterEach(() => { usePrefs.setState(DEFAULT_PREFS); vi.unstubAllGlobals() })

it('synthesizes four distinct finite, non-clipping loops with smooth seams', () => {
  const lengths = new Set<number>()
  for (const { id } of MUSIC_STYLES) {
    const data = musicSamples(8000, id)
    lengths.add(data.length)
    let peak = 0, energy = 0
    for (const sample of data) { peak = Math.max(peak, Math.abs(sample)); energy += sample * sample }
    expect(Number.isFinite(energy)).toBe(true)
    expect(peak).toBeLessThan(1)
    expect(energy).toBeGreaterThan(1)
    expect(Math.abs(data[0] - data[data.length - 1]), id).toBeLessThan(0.015)
  }
  expect(lengths.size).toBe(4)
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
  expect(sources[0].stop).toHaveBeenCalledWith(10.3)
  expect(gains[gains.length - 1].gain.linearRampToValueAtTime).toHaveBeenCalledWith(1, 10.3)
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
  expect(sources[1].frequency.setValueAtTime.mock.calls).toEqual(NOTICE_NOTES.map((frequency, i) => [frequency, 10.08 + i * 0.55]))
  expect(sources[1].stop).toHaveBeenCalledWith(13.03)
  usePrefs.setState({ soundNotice: false })
  player.update(usePrefs.getState())
  expect(sources[1].stop).toHaveBeenLastCalledWith()
  player.play('soundNotice')
  expect(sources).toHaveLength(2)
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


it('ducks music and all other effects through the shorter chime and stronger echo, respecting changed preferences', () => {
  const { player, sources, gains, delays } = context()
  for (const gain of gains.slice(1, 4)) expect(gain.gain.setTargetAtTime).toHaveBeenLastCalledWith(0.6, 10, 0.03)
  player.play('soundLanding')
  player.play('soundNotice')
  for (const gain of gains.slice(1, 4)) expect(gain.gain.setTargetAtTime).toHaveBeenLastCalledWith(0.072, 10, 0.015)
  expect(gains[0].gain.setTargetAtTime).toHaveBeenLastCalledWith(0.12, 10, 0.015)
  expect(gains[4].gain.setTargetAtTime).toHaveBeenLastCalledWith(0.12, 10, 0.015)
  expect(gains[5].gain.setTargetAtTime).toHaveBeenLastCalledWith(1, 10, 0.015)
  expect(delays[0].delayTime.value).toBe(0.18)
  expect(gains[gains.length - 1].gain.value).toBe(0.32)
  const envelope = gains[gains.length - 2]
  expect(envelope.gain.linearRampToValueAtTime.mock.calls.filter(([value]) => value === 0.28)).toHaveLength(4)
  expect(sources[sources.length - 1].stop).toHaveBeenCalledWith(13.03)
  usePrefs.setState({ musicVolume: 40, effectsVolume: 50, soundTakeoff: false, soundUI: false })
  player.update(usePrefs.getState())
  player.stop('soundNotice')
  expect(gains[1].gain.setTargetAtTime).toHaveBeenLastCalledWith(0, 10, 0.03)
  for (const gain of gains.slice(2, 4)) expect(gain.gain.setTargetAtTime).toHaveBeenLastCalledWith(0.3, 10, 0.03)
  expect(gains[0].gain.setTargetAtTime).toHaveBeenLastCalledWith(0.4, 10, 0.03)
  expect(gains[4].gain.setTargetAtTime).toHaveBeenLastCalledWith(0, 10, 0.03)
  expect(delays[0].disconnect).toHaveBeenCalled()
  expect(gains[gains.length - 1].disconnect).toHaveBeenCalled()
  player.dispose()
})


it('restores the mix after natural completion, without an older chime restoring over a new one', () => {
  const { player, sources, gains } = context()
  player.play('soundNotice')
  const old = sources[sources.length - 1]
  player.play('soundNotice')
  const current = sources[sources.length - 1]
  old.onended?.()
  expect(gains[0].gain.setTargetAtTime).toHaveBeenLastCalledWith(0.12, 10, 0.015)
  current.onended?.()
  expect(gains[0].gain.setTargetAtTime).toHaveBeenLastCalledWith(1, 10, 0.03)
  expect(gains[4].gain.setTargetAtTime).toHaveBeenLastCalledWith(1, 10, 0.03)
  for (const gain of gains.slice(1, 4)) expect(gain.gain.setTargetAtTime).toHaveBeenLastCalledWith(0.6, 10, 0.03)
  player.dispose()
})


it('starts a brighter, louder four-note bell after ducking and holds each attack for 120ms', () => {
  const { player, audio, sources, gains } = context()
  player.play('soundNotice')
  const source = sources[sources.length - 1] as Oscillator
  expect(source.start).toHaveBeenCalledWith(10.08)
  expect(audio.createPeriodicWave).toHaveBeenCalledWith(new Float32Array(4), new Float32Array([0, 1, 0.25, 0.12]))
  expect(source.setPeriodicWave).toHaveBeenCalledOnce()
  const envelope = gains[gains.length - 2]
  for (let i = 0; i < 4; i++) {
    const start = 10.08 + i * 0.55
    expect(envelope.gain.linearRampToValueAtTime).toHaveBeenCalledWith(0.28, start + 0.012)
    expect(envelope.gain.setValueAtTime).toHaveBeenCalledWith(0.28, start + 0.12)
  }
  expect(gains[0].gain.setTargetAtTime).toHaveBeenLastCalledWith(0.12, 10, 0.015)
  // Muting during the lead-in cancels the scheduled sound and restores the mix.
  usePrefs.setState({ soundNotice: false })
  player.update(usePrefs.getState())
  expect(source.stop).toHaveBeenLastCalledWith()
  expect(source.disconnect).toHaveBeenCalled()
  expect(gains[0].gain.setTargetAtTime).toHaveBeenLastCalledWith(1, 10, 0.03)
  player.dispose()
})
