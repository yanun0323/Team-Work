// Original music and effects, rendered from code to stereo samples. No Web Audio, downloads or recordings.
// Everything is seeded, so a style or effect always renders to the same samples.
import type { MusicStyle } from './prefs'

export const RATE = 32000
export type Stereo = [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>]
export type EffectKey = 'soundTakeoff' | 'soundLanding' | 'soundFlyover' | 'soundUI' | 'soundNotice' | 'soundTutorial'

const TAU = Math.PI * 2
const SINE_SIZE = 1 << 14
const SINE = Float32Array.from({ length: SINE_SIZE }, (_, i) => Math.sin(TAU * i / SINE_SIZE))
/** Sine of a phase in cycles; a table keeps long loops quick enough to render during a click. */
const sin = (cycles: number) => SINE[(cycles * SINE_SIZE) & (SINE_SIZE - 1)]

function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}
const NOISE_SIZE = 1 << 16
const noiseRandom = random(7)
const NOISE = Float32Array.from({ length: NOISE_SIZE }, () => noiseRandom() * 2 - 1)

const NAMES: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }
/** 'c#4' to a MIDI note. */
function midi(name: string) {
  const octave = Number(name[name.length - 1])
  const accidental = name[1] === '#' ? 1 : name[1] === 'b' ? -1 : 0
  return 12 * (octave + 1) + NAMES[name[0]] + accidental
}
const hz = (note: number) => 440 * 2 ** ((note - 69) / 12)
const chord = (names: string) => names.split(' ').map(midi)

/**
 * A line of equal steps: a note name starts a note, `-` holds it, `.` is a rest. Bars may be split with `|`.
 * Plays each note as (note, start in steps, length in steps).
 */
function line(text: string, play: (note: number, step: number, steps: number) => void) {
  const tokens = text.split(/[\s|]+/).filter(Boolean)
  tokens.forEach((token, step) => {
    if (token === '-' || token === '.') return
    let steps = 1
    while (tokens[step + steps] === '-') steps++
    play(midi(token), step, steps)
  })
}

/** A loop: everything written past the end wraps to the start, so the seam has no gap or click. */
class Mix {
  readonly rate: number
  readonly size: number
  readonly dry: Stereo
  readonly wet: Stereo
  constructor(rate: number, seconds: number) {
    this.rate = rate
    this.size = Math.round(seconds * rate)
    this.dry = [new Float32Array(this.size), new Float32Array(this.size)]
    this.wet = [new Float32Array(this.size), new Float32Array(this.size)]
  }
  /** `wave` takes seconds since the note began. `release` fades the end so nothing clicks. */
  voice(start: number, seconds: number, level: number, pan: number, send: number, wave: (t: number) => number, release = 0.02) {
    const { rate, size, dry, wet } = this
    const left = level * Math.cos((pan + 1) * Math.PI / 4), right = level * Math.sin((pan + 1) * Math.PI / 4)
    const first = Math.round(start * rate), count = Math.floor(seconds * rate)
    for (let i = 0; i < count; i++) {
      const t = i / rate
      // A short rise too: a wave starting anywhere but zero would click.
      const fade = Math.min(1, (seconds - t) / release, (i + 1) / (rate * 0.002))
      const sample = wave(t) * fade
      const at = (first + i) % size
      dry[0][at] += sample * left
      dry[1][at] += sample * right
      if (send) {
        wet[0][at] += sample * left * send
        wet[1][at] += sample * right * send
      }
    }
  }
  /** A small room from parallel echoes. Its tail wraps round the loop like everything else. */
  reverb(seconds: number, amount: number) {
    const { rate, size } = this
    const tail = Math.round(seconds * rate)
    for (const channel of [0, 1]) {
      const input = this.wet[channel], output = this.dry[channel]
      const spread = channel ? 1.03 : 1
      for (const delay of [0.0297, 0.0371, 0.0411, 0.0437]) {
        const length = Math.max(1, Math.round(delay * spread * rate))
        const memory = new Float32Array(length)
        const feedback = 10 ** (-3 * delay / seconds)
        let p = 0
        for (let i = 0; i < size + tail; i++) {
          const held = memory[p]
          memory[p] = (i < size ? input[i] : 0) + held * feedback
          output[i % size] += held * amount / 4
          p = p + 1 === length ? 0 : p + 1
        }
      }
    }
  }
  /** Even loudness between styles, never past `ceiling`. */
  finish(targetRms: number, ceiling = 0.8): Stereo {
    return levelled(this.dry, targetRms, ceiling)
  }
}

function levelled(samples: Stereo, targetRms: number, ceiling: number): Stereo {
  let peak = 0, energy = 0
  for (const channel of samples) for (const sample of channel) {
    peak = Math.max(peak, Math.abs(sample))
    energy += sample * sample
  }
  const rms = Math.sqrt(energy / (samples[0].length * 2))
  const gain = Math.min(targetRms / (rms || 1), ceiling / (peak || 1))
  for (const channel of samples) for (let i = 0; i < channel.length; i++) channel[i] *= gain
  return samples
}

// --- Instruments

/** A band-limited pulse (polyBLEP), like a game console's square channels without the harsh aliasing. */
function pulse(cycles: number, frequency: number, duty: number, rate: number) {
  const inc = frequency / rate
  const blep = (x: number) => x < inc ? (x / inc) * (2 - x / inc) - 1 : x > 1 - inc ? ((x - 1) / inc + 2) * ((x - 1) / inc) + 1 : 0
  const phase = cycles % 1
  const shifted = (phase + 1 - duty) % 1
  return (phase < duty ? 1 : -1) + blep(phase) - blep(shifted)
}

/** A pre-rendered note, read back as a voice's wave. */
const playback = (sound: Float32Array, rate: number) => (t: number) => sound[Math.min(sound.length - 1, Math.floor(t * rate))]

/** Renders each note once: pieces repeat notes, and this is what keeps them quick. */
function noteCache(render: (note: number) => Float32Array) {
  const notes = new Map<number, Float32Array>()
  return (note: number) => {
    let found = notes.get(note)
    if (!found) notes.set(note, found = render(note))
    return found
  }
}

/** Felt piano: slightly stretched partials, the higher ones dying first. */
function piano(note: number, rate: number) {
  const f = hz(note)
  const out = new Float32Array(Math.floor(3.2 * rate))
  for (let n = 1; n <= 5; n++) {
    const partial = f * n * Math.sqrt(1 + 0.00035 * n * n)
    if (partial >= rate / 2) break
    const fall = Math.exp(-(0.55 + 0.75 * n) * (0.65 + f / 900) / rate)
    let amp = 1 / n ** 1.9
    for (let i = 0; i < out.length; i++) {
      out[i] += sin(partial * i / rate) * amp * Math.min(1, i / (0.008 * rate))
      amp *= fall
    }
  }
  return out
}

/** FM bell for sparse, glassy notes. */
function bell(note: number, brightness: number, decay: number) {
  const f = hz(note)
  return (t: number) => {
    const env = Math.exp(-decay * t)
    return sin(f * t + brightness * Math.exp(-5 * t) * sin(f * 3.51 * t)) * env * Math.min(1, t / 0.004)
  }
}

/** A plucked nylon string (Karplus-Strong). Same note, same pluck, so a chord can reuse it. */
function pluck(note: number, seconds: number, rate: number) {
  const size = Math.max(2, Math.round(rate / hz(note)))
  const string = new Float32Array(size)
  const rng = random(note * 131 + rate)
  // Soften the initial noise, like a thumb rather than a pick.
  for (let i = 0; i < size; i++) string[i] = rng() * 2 - 1
  for (let pass = 0; pass < 4; pass++) {
    let last = string[size - 1]
    for (let i = 0; i < size; i++) string[i] = last = last * 0.6 + string[i] * 0.4
  }
  const out = new Float32Array(Math.floor(seconds * rate))
  let p = 0
  for (let i = 0; i < out.length; i++) {
    const next = p + 1 === size ? 0 : p + 1
    out[i] = string[p]
    string[p] = (string[p] + string[next]) * 0.4975
    p = next
  }
  return out
}

function kick(high: number, low: number, tau: number, decay: number) {
  return (t: number) => sin(low * t + (high - low) * tau * (1 - Math.exp(-t / tau))) * Math.exp(-decay * t)
}

/** A noise hit: `bright` is 0 for dark, 1 for only the highs. */
function hit(seed: number, bright: number, attack: number, decay: number, rate: number) {
  const offset = Math.floor(seed * 9973) % NOISE_SIZE
  return (t: number) => {
    const i = offset + Math.floor(t * rate)
    const a = NOISE[i & (NOISE_SIZE - 1)], b = NOISE[(i + 1) & (NOISE_SIZE - 1)]
    const shade = (a + b) / 2 * (1 - bright) + (a - b) / 2 * bright
    return shade * Math.min(1, t / attack) * Math.exp(-decay * t)
  }
}

// --- Music: four separate pieces, each with its own key, metre, harmony and form.

/** E minor, 132 BPM: a two-section adventure tune for pulse channels, triangle bass and noise. */
function chiptune(rate: number): Stereo {
  const beat = 60 / 132, eighth = beat / 2
  const A = ['e3 b3 e4 g4', 'c3 g3 c4 e4', 'g2 d3 g3 b3', 'd3 a3 d4 f#4', 'e3 b3 e4 g4', 'c3 g3 c4 e4', 'a2 e3 a3 c4', 'b2 f#3 b3 d#4']
  const B = ['c3 g3 c4 e4', 'd3 a3 d4 f#4', 'g2 d3 g3 b3', 'e3 b3 e4 g4', 'c3 g3 c4 e4', 'd3 a3 d4 f#4', 'b2 f#3 b3 d#4', 'b2 f#3 b3 d#4']
  const bars = [...A, ...B, ...A].map(chord)
  const leadA = `
    e5 - g5 b5 - a5 g5 - | e5 - g5 c6 - b5 g5 - | d5 - g5 b5 - d6 b5 g5 | a5 - f#5 d5 - e5 f#5 - |
    e5 - g5 b5 - a5 g5 - | c6 - b5 a5 - g5 e5 - | a5 g5 e5 c5 - e5 a5 - | b5 - f#5 d#5 - . . . |`
  const leadB = `
    g5 - e5 c5 - e5 g5 a5 | f#5 - a5 d6 - c6 a5 - | b5 - d6 g6 - d6 b5 - | e6 - b5 g5 - e5 g5 - |
    c6 - e6 c6 - g5 e5 g5 | a5 - d6 a5 - f#5 d5 f#5 | b5 - a5 f#5 - d#5 f#5 - | b5 - - - . . f#5 a5 |`
  const mix = new Mix(rate, bars.length * 4 * beat)
  line(leadA + leadB + leadA, (note, step, steps) => {
    const f = hz(note), seconds = steps * eighth
    mix.voice(step * eighth, seconds, 0.17, 0.08, 0.1, (t) => {
      // Vibrato comes in only on held notes.
      const depth = Math.min(1, Math.max(0, t - 0.18) * 4) * 0.004
      return pulse(f * t + f * depth * sin(5.5 * t) / (TAU * 5.5), f, 0.25, rate) * (0.62 + 0.38 * Math.exp(-7 * t))
    })
  })
  bars.forEach((tones, bar) => {
    const start = bar * 4 * beat
    // Broken chord on a thin pulse, a sixteenth at a time.
    for (let s = 0; s < 16; s++) {
      const f = hz(tones[[1, 2, 3, 2][s % 4]] + 12)
      mix.voice(start + s * eighth / 2, eighth / 2, 0.055, -0.35, 0, (t) => pulse(f * t, f, 0.125, rate) * Math.exp(-14 * t), 0.006)
    }
    // Triangle bass, octave-hopping.
    for (let s = 0; s < 8; s++) {
      const f = hz(tones[0] - (s % 2 ? 0 : 12) + 12)
      mix.voice(start + s * eighth, eighth * 0.9, 0.3, 0, 0, (t) => (2 * Math.abs(2 * ((f * t) % 1) - 1) - 1) * Math.exp(-2.5 * t))
    }
    for (const s of [0, 3, 4]) mix.voice(start + s * eighth, 0.16, 0.3, 0, 0, kick(170, 52, 0.022, 20))
    for (const s of [2, 6]) mix.voice(start + s * eighth, 0.16, 0.14, 0, 0.1, hit(bar + s, 0.45, 0.001, 24, rate))
    for (let s = 1; s < 8; s += 2) mix.voice(start + s * eighth, 0.05, 0.05, 0.2, 0, hit(bar * 3 + s, 1, 0.001, 70, rate))
  })
  mix.reverb(0.5, 0.35)
  return mix.finish(0.11)
}

/** F major in slow 3/4: a left hand that rocks under a sparse, singing right hand. */
function softPiano(rate: number): Stereo {
  const beat = 60 / 66, eighth = beat / 2
  const verse = ['f2 c3 a3 e4', 'a2 e3 c4 g4', 'a#2 f3 d4 a4', 'c3 g3 c4 f4', 'd3 a3 f4 c5', 'a2 e3 c4 g4', 'a#2 f3 d4 a4', 'c3 g3 e4 a#4']
  const turn = ['g2 d3 a#3 f4', 'c3 g3 e4 a#4', 'a2 e3 c4 g4', 'd3 a3 f4 c5', 'g2 d3 a#3 f4', 'a2 e3 c4 g4', 'a#2 f3 d4 a4', 'c3 g3 c4 f4']
  const bars = [...verse, ...turn, ...verse].map(chord)
  const melodyVerse = `
    a4 - - - c5 - | g4 - - - e4 - | f4 - a4 - d5 - | c5 - - - - . |
    a4 - c5 - f5 - | e5 - - - c5 - | d5 - c5 - a4 - | g4 - - - - . |`
  const melodyTurn = `
    a#4 - - - d5 - | e5 - - - g5 - | e5 - - - c5 - | f5 - e5 - c5 - |
    d5 - - - a#4 - | c5 - - - e5 - | f5 - d5 - a4 - | c5 - - - - . |`
  const mix = new Mix(rate, bars.length * 3 * beat)
  const note = noteCache((n) => piano(n, rate))
  line(melodyVerse + melodyTurn + melodyVerse, (tone, step, steps) => {
    mix.voice(step * eighth + 0.012, Math.min(3.2, Math.max(steps * eighth * 1.5, 2.4)), 0.2, 0.12, 0.5, playback(note(tone), rate), 0.4)
  })
  bars.forEach((tones, bar) => {
    const start = bar * 3 * beat
    for (const [i, at] of [0, 1, 2, 3, 4, 5].entries()) {
      const tone = tones[[0, 1, 2, 3, 2, 1][i]]
      mix.voice(start + at * eighth, 2.6, i === 0 ? 0.17 : 0.085, -0.15 + 0.06 * (tone - 48) / 12, 0.45, playback(note(tone), rate), 0.4)
    }
  })
  mix.reverb(2.4, 0.22)
  return mix.finish(0.09)
}

/** D-flat, unmetred: slow overlapping chords with a few far-off bells at seeded moments. */
function ambient(rate: number): Stereo {
  const every = 8
  const chords = ['c#3 g#3 c4 d#4 f4', 'g#2 d#3 g#3 a#3 d#4', 'f#2 c#3 f4 g#4 a#4', 'd#3 a#3 c#4 f4 f#4',
    'c#3 g#3 c4 f4 g#4', 'a#2 f3 g#3 c#4 d#4', 'f#2 c#3 a#3 c4 f4', 'g#2 d#3 g#3 c4 d#4'].map(chord)
  const mix = new Mix(rate, chords.length * every)
  const hold = every * 1.7
  chords.forEach((tones, i) => {
    tones.forEach((tone, n) => {
      const f = hz(tone), drift = 0.05 + n * 0.017
      mix.voice(i * every + n * 0.35, hold, 0.11, -0.5 + n * 0.25, 0.6, (t) => {
        const rise = sin(t / hold / 2)
        const swell = rise * rise
        const breathe = 0.8 + 0.2 * sin(drift * t)
        return (sin(f * t) + sin(f * 1.0035 * t) * 0.8 + sin(f * 2.001 * t) * 0.14) * swell * breathe
      })
    })
  })
  const rng = random(41)
  const scale = chord('c#5 d#5 f5 g#5 a#5 c#6 d#6 f6')
  for (let i = 0; i < chords.length * 2; i++) {
    const tone = scale[Math.floor(rng() * scale.length)]
    mix.voice(i * every / 2 + 1 + rng() * 2.5, 4.5, 0.05, rng() * 1.4 - 0.7, 1, bell(tone, 0.5, 1.1), 0.5)
  }
  mix.reverb(4.5, 0.32)
  return mix.finish(0.07)
}

/** C major, 126 BPM: nylon guitar on the off-beats, a soft thumb bass, shaker and a vibraphone tune. */
function bossa(rate: number): Stereo {
  const beat = 60 / 126, eighth = beat / 2
  const A = ['e3 b3 d4 g4', 'g3 c4 e4 g4', 'f3 c4 e4 a4', 'f3 b3 e4 a4', 'g3 d4 f#4 b4', 'g3 c#4 f4 c5', 'f3 c4 e4 a4', 'f3 b3 c#4 g4']
  const B = ['e3 a3 c4 g4', 'g#3 d4 e4 c5', 'g3 d4 f#4 b4', 'g3 c#4 f4 a4', 'f3 c4 e4 a4', 'f3 b3 e4 a4', 'e3 b3 d4 g4', 'f3 a#3 c4 g4']
  const roots = {
    A: ['c3', 'a2', 'd3', 'g2', 'e3', 'a2', 'd3', 'c#3'],
    B: ['f2', 'a#2', 'e3', 'a2', 'd3', 'g2', 'c3', 'g2'],
  }
  const bars = [...A, ...B, ...A].map(chord)
  const bass = [...roots.A, ...roots.B, ...roots.A].map(midi)
  const tuneA = `
    g5 - e5 - . g5 - a5 | - - e5 - . . . . | f5 - a5 - . c6 - a5 | - g5 - e5 - . . . |
    b5 - g5 - . b5 - a5 | - - g5 - . e5 - c#5 | d5 - f5 - . a5 - g5 | - - f5 - . . . . |`
  const tuneB = `
    a5 - c6 - . a5 - f5 | - - d5 - . f5 - a5 | g5 - b5 - . g5 - e5 | - - c#5 - . e5 - g5 |
    f5 - a5 - . f5 - d5 | - - b4 - . d5 - f5 | e5 - g5 - . e5 - c5 | - - d5 - . . . . |`
  const mix = new Mix(rate, bars.length * 4 * beat)
  line(tuneA + tuneB + tuneA, (note, step, steps) => {
    const ring = bell(note, 0.22, 2.2)
    mix.voice(step * eighth, Math.max(steps * eighth, 1.1), 0.1, 0.25, 0.5, (t) => ring(t) * (0.86 + 0.14 * sin(4.6 * t)), 0.25)
  })
  const string = noteCache((note) => pluck(note, 1.6, rate))
  const play = (sound: Float32Array) => playback(sound, rate)
  // The two-bar guitar figure, in eighths.
  const comp = [0, 3, 6, 10, 13]
  bars.forEach((tones, bar) => {
    const start = bar * 4 * beat
    for (const step of comp) {
      if (step >= 8 !== (bar % 2 === 1)) continue
      tones.forEach((tone, n) => {
        mix.voice(start + (step % 8) * eighth + n * 0.009, 1.3, 0.12, -0.3 + n * 0.08, 0.28, play(string(tone)), 0.1)
      })
    }
    const low = bass[bar]
    mix.voice(start, beat * 1.6, 0.34, -0.05, 0.08, play(string(low)), 0.08)
    mix.voice(start + 2 * beat, beat * 1.6, 0.26, -0.05, 0.08, play(string(low + 7 - (low > 43 ? 12 : 0))), 0.08)
    for (let s = 0; s < 8; s++) {
      mix.voice(start + s * eighth, 0.1, s % 2 ? 0.05 : 0.03, 0.35, 0, hit(bar * 7 + s, 0.9, 0.012, 42, rate))
    }
    for (const s of bar % 2 ? [2, 5] : [0, 3, 6]) mix.voice(start + s * eighth, 0.05, 0.1, -0.25, 0.3, (t) => sin(1600 * t) * Math.exp(-90 * t))
  })
  mix.reverb(1.2, 0.2)
  return mix.finish(0.09)
}

const STYLES: Record<MusicStyle, (rate: number) => Stereo> = { chiptune, piano: softPiano, ambient, bossa }

export const musicSamples = (style: MusicStyle, rate = RATE) => STYLES[style](rate)

// --- Effects

/** Value at `t` along [time, value] points, eased between them. */
function curve(points: readonly (readonly [number, number])[], t: number) {
  if (t <= points[0][0]) return points[0][1]
  for (let i = 1; i < points.length; i++) {
    const [t1, v1] = points[i]
    if (t <= t1) {
      const [t0, v0] = points[i - 1]
      const u = (t - t0) / (t1 - t0)
      return v0 + (v1 - v0) * u * u * (3 - 2 * u)
    }
  }
  return points[points.length - 1][1]
}

type Jet = {
  seconds: number
  /** Overall loudness. */
  level: readonly (readonly [number, number])[]
  /** Brightness of the roar, Hz. */
  roar: readonly (readonly [number, number])[]
  /** Pitch of the turbine, Hz, and how much of it there is. */
  whine: readonly (readonly [number, number])[]
  whineLevel: readonly (readonly [number, number])[]
  /** Tyres on the runway. */
  rumble: readonly (readonly [number, number])[]
  /** Left to right, -1 to 1. */
  pan: readonly (readonly [number, number])[]
  seed: number
}

/** Engine roar from filtered noise (separate per side for width), two beating turbine tones and tyre rumble. */
function jet(spec: Jet, rate: number): Stereo {
  const size = Math.floor(spec.seconds * rate)
  const out: Stereo = [new Float32Array(size), new Float32Array(size)]
  const rng = random(spec.seed)
  const low = [[0, 0], [0, 0]], rumble = [0, 0]
  let phase = 0, level = 0, pan = 0, tyres = 0, coefficient = 0, pitch = 0, tone = 0
  for (let i = 0; i < size; i++) {
    const t = i / rate
    // The curves move slowly; reading them every sample would make the first flight stutter the 3D scene.
    if (i % 16 === 0) {
      level = curve(spec.level, t); pan = curve(spec.pan, t); tyres = curve(spec.rumble, t)
      coefficient = 1 - Math.exp(-TAU * curve(spec.roar, t) / rate)
      pitch = curve(spec.whine, t); tone = curve(spec.whineLevel, t)
    }
    phase += pitch / rate
    const turbine = (sin(phase) + sin(phase * 1.007) * 0.8 + sin(phase * 2.02) * 0.35) * tone
    for (const c of [0, 1]) {
      const [a, b] = low[c]
      const noise = rng() * 2 - 1
      const x = a + (noise - a) * coefficient, y = b + (x - b) * coefficient
      low[c][0] = x
      low[c][1] = y
      rumble[c] += (noise - rumble[c]) * 0.016
      const side = Math.cos((c ? 1 - pan : 1 + pan) * Math.PI / 4)
      out[c][i] = (y * 2.4 + turbine * 0.22 + rumble[c] * 3.4 * tyres * (0.8 + 0.2 * sin(13 * t))) * level * side
    }
  }
  return out
}

function addChirp(out: Stereo, at: number, level: number, pan: number, seed: number, rate: number) {
  const rng = random(seed)
  const first = Math.floor(at * rate), count = Math.floor(0.13 * rate)
  for (let i = 0; i < count && first + i < out[0].length; i++) {
    const t = i / rate
    const sample = (sin((1050 - 900 * t) * t) * 0.6 + (rng() * 2 - 1) * 0.5) * Math.min(1, t / 0.004) * Math.exp(-26 * t) * level
    out[0][first + i] += sample * (1 - pan) / 2
    out[1][first + i] += sample * (1 + pan) / 2
  }
}

/** 13s from the line-up: rotation at 5.6s (Airport.tsx FLIGHT), then away over the sea. */
function takeoff(rate: number) {
  return levelled(jet({
    seconds: 13,
    seed: 11,
    level: [[0, 0], [0.7, 0.3], [3.5, 0.72], [5.6, 1], [8.5, 0.5], [12.6, 0.03], [13, 0]],
    roar: [[0, 320], [3, 950], [5.6, 2100], [8.5, 1200], [13, 500]],
    whine: [[0, 300], [2.5, 720], [5.6, 1180], [13, 960]],
    whineLevel: [[0, 0.25], [4, 0.9], [13, 0.3]],
    rumble: [[0, 0.1], [4, 0.6], [5.5, 0.6], [6.1, 0]],
    pan: [[0, -0.65], [5.6, 0.1], [13, 0.8]],
  }, rate), 0.15, 0.55)
}

/** 12.5s of approach: wheels down at 7.5s (Airport.tsx FLIGHT), reverse thrust, then taxiing speed. */
function landing(rate: number) {
  const out = jet({
    seconds: 12.5,
    seed: 23,
    level: [[0, 0], [2, 0.24], [7.2, 0.55], [8, 0.48], [9.1, 1], [10.7, 0.46], [12.3, 0.03], [12.5, 0]],
    roar: [[0, 600], [7.5, 820], [8.2, 950], [9.1, 2500], [10.7, 800], [12.5, 340]],
    whine: [[0, 990], [7.5, 690], [9.1, 980], [12.5, 410]],
    whineLevel: [[0, 0.55], [7.5, 0.75], [9.1, 0.5], [12.5, 0.2]],
    rumble: [[0, 0], [7.45, 0], [7.7, 0.75], [10.5, 0.42], [12.5, 0.05]],
    pan: [[0, -0.8], [7.5, -0.1], [12.5, 0.5]],
  }, rate)
  addChirp(out, 7.5, 1.5, -0.1, 3, rate)
  addChirp(out, 7.68, 1.05, -0.1, 4, rate)
  return levelled(out, 0.15, 0.55)
}

/** 6s, closest at 3s (the moment Ambient.tsx cues from): high, airy, its pitch falling as it passes. */
function flyover(rate: number) {
  return levelled(jet({
    seconds: 6,
    seed: 37,
    level: [[0, 0], [1.2, 0.34], [3, 1], [4.8, 0.32], [6, 0]],
    roar: [[0, 420], [3, 1300], [6, 360]],
    whine: [[0, 1180], [2.5, 1100], [3.5, 880], [6, 830]],
    whineLevel: [[0, 0.3], [3, 0.5], [6, 0.16]],
    rumble: [[0, 0]],
    pan: [[0, -0.85], [6, 0.85]],
  }, rate), 0.11, 0.34)
}

export const TAP_SECOND_SNAP = 0.016

/** Paper being pressed flat: a crisp double snap of filtered noise over a soft, falling thud. */
function tap(rate: number): Stereo {
  const seconds = 0.07, size = Math.floor(seconds * rate)
  const out: Stereo = [new Float32Array(size), new Float32Array(size)]
  const low = 1 - Math.exp(-2 * Math.PI * 1800 / rate), high = 1 - Math.exp(-2 * Math.PI * 6500 / rate)
  let below = 0, above = 0
  for (let i = 0; i < size; i++) {
    const t = i / rate, late = t - TAP_SECOND_SNAP
    const snap = Math.exp(-420 * t) + (late > 0 ? Math.min(1, late / 0.0006) * Math.exp(-520 * late) * 0.65 : 0)
    const noise = NOISE[i & (NOISE_SIZE - 1)]
    below += (noise - below) * low
    above += (noise - above) * high
    const thud = sin(130 * t + 90 * (1 - Math.exp(-70 * t)) / 70) * Math.exp(-85 * t)
    const sample = (above - below) * snap * 1.6 + thud * 0.3
    out[0][i] = out[1][i] = sample * Math.min(1, t / 0.0005) * Math.min(1, (seconds - t) / 0.008)
  }
  return levelled(out, 1, 0.22)
}

// An original three-note rising cue, not an airport recording.
export const NOTICE_NOTES = [783.99, 1046.5, 1318.51] as const
export const NOTICE_LEAD_IN = 0.04
export const NOTICE_GAP = 0.11
export const NOTICE_ECHO = { delay: 0.09, level: 0.22 } as const
/** Three quick notes with the last ringing longest, plus the echo. */
export const NOTICE_SECONDS = 0.9
/** What everything else drops to during the chime: quieter, but still clearly playing. */
export const NOTICE_DUCK = 0.4

/** A struck wooden bar: a bright knock over a pure tone that dies fast, so notes never smear together. */
function notice(rate: number): Stereo {
  const size = Math.floor(NOTICE_SECONDS * rate)
  const bars = new Float32Array(size)
  NOTICE_NOTES.forEach((f, n) => {
    const first = Math.round(n * NOTICE_GAP * rate), ring = n === 2 ? 0.59 : 0.3
    for (let i = 0; i < Math.floor(ring * rate); i++) {
      const t = i / rate
      const shape = Math.min(1, t / 0.003) * Math.exp(-(n === 2 ? 7 : 14) * t) * Math.min(1, (ring - t) / 0.02)
      // The tuned fourth partial gives the bar its wooden ring; the inharmonic one is the mallet.
      bars[first + i] += (sin(f * t) + sin(f * 4 * t) * 0.3 * Math.exp(-30 * t) + sin(f * 9.2 * t) * 0.12 * Math.exp(-90 * t)) * shape
    }
  })
  const out: Stereo = [new Float32Array(size), new Float32Array(size)]
  const delay = Math.round(NOTICE_ECHO.delay * rate)
  for (let i = 0; i < size; i++) {
    const echo = i >= delay ? bars[i - delay] * NOTICE_ECHO.level : 0
    out[0][i] = bars[i] + echo * 0.75
    out[1][i] = bars[i] + echo * 1.25
  }
  return levelled(out, 1, 0.5)
}

/** A tutorial step crossed off or newly shown: two soft rising bell notes, gentler than the notice board's chime. */
export const TUTORIAL_NOTES = [1046.5, 1567.98] as const
export const TUTORIAL_SECONDS = 0.7
function tutorial(rate: number): Stereo {
  const size = Math.floor(TUTORIAL_SECONDS * rate)
  const out: Stereo = [new Float32Array(size), new Float32Array(size)]
  TUTORIAL_NOTES.forEach((f, n) => {
    const first = Math.round(n * 0.09 * rate), ring = size - first
    for (let i = 0; i < ring; i++) {
      const t = i / rate
      const shape = Math.min(1, t / 0.004) * Math.exp(-6 * t) * Math.min(1, (ring / rate - t) / 0.03)
      const v = (sin(f * t) + sin(f * 2.76 * t) * 0.18 * Math.exp(-20 * t)) * shape
      // the first note leans left and the second right, so the pair seems to step up and across
      out[0][first + i] += v * (n === 0 ? 1 : 0.7)
      out[1][first + i] += v * (n === 0 ? 0.7 : 1)
    }
  })
  return levelled(out, 0.6, 0.35)
}

const EFFECTS: Record<EffectKey, (rate: number) => Stereo> = {
  soundTakeoff: takeoff, soundLanding: landing, soundFlyover: flyover, soundUI: tap, soundNotice: notice, soundTutorial: tutorial,
}

export const effectSamples = (key: EffectKey, rate = RATE) => EFFECTS[key](rate)
