// Original music and effects, rendered from code to stereo samples. No Web Audio, downloads or recordings.
// Everything is seeded, so a style or effect always renders to the same samples.
import type { MusicStyle } from './prefs'

export const RATE = 32000
export type Stereo = [Float32Array<ArrayBuffer>, Float32Array<ArrayBuffer>]
export type EffectKey = 'soundTakeoff' | 'soundLanding' | 'soundFlyover' | 'soundUI' | 'soundNotice' | 'soundTutorial' | 'soundOpenTeam' | 'soundOpenAirport' | 'soundOpenTower' | 'soundOpenStaffing' | 'soundWaves'

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
  return levelled(jet({
    seconds: 12.5,
    seed: 23,
    level: [[0, 0], [2, 0.24], [7.2, 0.55], [8, 0.48], [9.1, 1], [10.7, 0.46], [12.3, 0.03], [12.5, 0]],
    roar: [[0, 600], [7.5, 820], [8.2, 950], [9.1, 2500], [10.7, 800], [12.5, 340]],
    whine: [[0, 990], [7.5, 690], [9.1, 980], [12.5, 410]],
    whineLevel: [[0, 0.55], [7.5, 0.75], [9.1, 0.5], [12.5, 0.2]],
    rumble: [[0, 0], [7.45, 0], [7.7, 0.75], [10.5, 0.42], [12.5, 0.05]],
    pan: [[0, -0.8], [7.5, -0.1], [12.5, 0.5]],
  }, rate), 0.15, 0.55)
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

/** Two bubbles popping up, low then high; task requests and chat replies share it. */
export const NOTICE_NOTES = [261.63, 392] as const
export const NOTICE_LEAD_IN = 0.04
export const NOTICE_GAP = 0.13
/** How far each bubble's pitch rises above where it starts, and how fast: a bubble's sound climbs as it shrinks. */
export const NOTICE_RISE = { by: 1, rate: 22 } as const
export const NOTICE_SECONDS = 0.5
/** What everything else drops to during the chime: quieter, but still clearly playing. */
export const NOTICE_DUCK = 0.4

/** A low, round tone sliding up fast and dying away like a bubble's bloop, with a little second harmonic at its start so small speakers still carry it. */
function notice(rate: number): Stereo {
  const size = Math.floor(NOTICE_SECONDS * rate)
  const out: Stereo = [new Float32Array(size), new Float32Array(size)]
  const { by, rate: k } = NOTICE_RISE
  NOTICE_NOTES.forEach((f, n) => {
    const first = Math.round(n * NOTICE_GAP * rate), ring = size - first
    for (let i = 0; i < ring; i++) {
      const t = i / rate
      // the integral of f * (1 + by * (1 - e^(-kt)))
      const phase = f * (t + by * (t - (1 - Math.exp(-k * t)) / k))
      const shape = Math.min(1, t / 0.003) * Math.exp(-16 * t) * Math.min(1, (ring / rate - t) / 0.03)
      const v = (sin(phase) + sin(phase * 2) * 0.15 * Math.exp(-40 * t)) * shape
      // the first bubble leans left and the second right
      out[0][first + i] += v * (n === 0 ? 1 : 0.75)
      out[1][first + i] += v * (n === 0 ? 0.75 : 1)
    }
  })
  return levelled(out, 1, 0.5)
}

/** A tutorial step crossed off or newly shown: two soft rising bell notes, gentler than the notice chime. */
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

/** A company's file slides open: a soft breath of noise sweeping up and to the right, where the drawer opens. */
export const WHOOSH_SECONDS = 0.36
/** Where the sweep's band starts, peaks and ends, Hz. */
export const WHOOSH_BAND = [450, 2200, 1200] as const
function whoosh(rate: number): Stereo {
  const size = Math.floor(WHOOSH_SECONDS * rate)
  const out: Stereo = [new Float32Array(size), new Float32Array(size)]
  const [from, peak, to] = WHOOSH_BAND
  // a state-variable band-pass with a wide band, so it breathes rather than whistles
  let low = 0, band = 0
  for (let i = 0; i < size; i++) {
    const x = i / size
    const centre = x < 0.55 ? from + (peak - from) * Math.sin(x / 0.55 * Math.PI / 2) : peak + (to - peak) * (x - 0.55) / 0.45
    const f = 2 * Math.sin(Math.PI * centre / rate)
    low += f * band
    const high = NOISE[(i + 7919) & (NOISE_SIZE - 1)] - low - 0.9 * band
    band += f * high
    // swells to just past the middle, then falls away
    const shape = Math.pow(Math.sin(Math.PI * Math.min(1, x / 0.55) / 2), 2) * (x < 0.55 ? 1 : Math.pow(1 - (x - 0.55) / 0.45, 1.6))
    out[0][i] = band * shape * (1 - 0.7 * x)
    out[1][i] = band * shape * (0.3 + 0.7 * x)
  }
  return levelled(out, 0.5, 0.2)
}

/** The airport opens like an announcement: Do Mi So Do rising on a soft vibraphone, the notes ringing on into a chord. */
export const AIRPORT_NOTES = [523.25, 659.25, 783.99, 1046.5] as const
export const AIRPORT_GAP = 0.32
/** Silence before the first note, so the chime comes once the camera has begun to move. */
export const AIRPORT_LEAD_IN = 0.35
export const AIRPORT_SECONDS = AIRPORT_LEAD_IN + 3.6
function announce(rate: number): Stereo {
  const size = Math.floor(AIRPORT_SECONDS * rate)
  const out: Stereo = [new Float32Array(size), new Float32Array(size)]
  AIRPORT_NOTES.forEach((f, n) => {
    const first = Math.round((AIRPORT_LEAD_IN + n * AIRPORT_GAP) * rate), ring = size - first, last = n === AIRPORT_NOTES.length - 1
    for (let i = 0; i < ring; i++) {
      const t = i / rate
      const shape = Math.min(1, t / 0.006) * Math.exp(-(last ? 1.6 : 2.2) * t) * Math.min(1, (ring / rate - t) / 0.25)
      // a slow shimmer, like a vibraphone's turning fans
      const shimmer = 1 - 0.12 * (1 - Math.cos(TAU * 5.5 * t)) / 2
      const v = (sin(f * t) + sin(f * 2 * t) * 0.2 * Math.exp(-8 * t) + sin(f * 3.9 * t) * 0.06 * Math.exp(-25 * t)) * shape * shimmer
      // the notes step from left of centre to right of it
      const right = 0.4 + 0.2 * n / (AIRPORT_NOTES.length - 1)
      out[0][first + i] += v * (1 - right) * 2
      out[1][first + i] += v * right * 2
    }
  })
  return levelled(out, 0.45, 0.225)
}

/** The power tower opens on live current: a raw mains buzz with a sizzle riding each cycle, twice — zzt, zzzzt. */
export const HUM_SECONDS = 0.85
/** When each burst of current starts and stops, seconds in. */
export const HUM_BURSTS = [[0.02, 0.27], [0.34, 0.78]] as const
/** The mains buzz, Hz: twice the mains, as a transformer hums. */
export const HUM_FREQUENCY = 100
function hum(rate: number): Stereo {
  const size = Math.floor(HUM_SECONDS * rate)
  const out: Stereo = [new Float32Array(size), new Float32Array(size)]
  const rng = random(17)
  // the current flickers: a fresh level every few milliseconds, smoothed, so the buzz sputters rather than drones
  let flicker = 1, target = 1, next = 0
  const smooth = 1 - Math.exp(-1 / (0.004 * rate))
  let phase = 0, hiss = 0
  for (let i = 0; i < size; i++) {
    const t = i / rate
    const burst = HUM_BURSTS.find(([from, to]) => t >= from - 0.01 && t <= to + 0.04)
    if (!burst) { phase += HUM_FREQUENCY / rate; continue }
    const [from, to] = burst
    const gate = Math.min(1, Math.max(0, t - from) / 0.004) * Math.min(1, Math.max(0, to + 0.04 - t) / 0.04)
    if (i >= next) { target = 0.45 + rng() * 0.55; next = i + Math.floor((0.008 + rng() * 0.02) * rate) }
    flicker += (target - flicker) * smooth
    phase += HUM_FREQUENCY * (1 + 0.004 * sin(7 * t)) / rate
    const cycle = phase % 1
    // a narrow pulse is all harmonics: the hard edge of the buzz
    const buzz = pulse(phase, HUM_FREQUENCY, 0.18, rate) + pulse(phase * 2, HUM_FREQUENCY * 2, 0.4, rate) * 0.4
    // the arc fires on each peak of the current: bright noise in short spurts locked to the cycle
    const x = NOISE[(i * 7 + 1301) & (NOISE_SIZE - 1)]
    hiss += (x - hiss) * 0.35
    const spurt = Math.exp(-cycle * 9) + Math.exp(-((cycle + 0.5) % 1) * 9) * 0.6
    const sizzle = (x - hiss) * spurt * 2.2
    // the buzz sits in the middle; the sizzle wanders a little from side to side
    const level = flicker * gate, sway = 0.15 * sin(3 * t)
    out[0][i] = (buzz * 0.32 + sizzle * (1 - sway)) * level
    out[1][i] = (buzz * 0.32 + sizzle * (1 + sway)) * level
  }
  return levelled(out, 0.5, 0.2)
}

/** The immigration office opens with a rubber stamp brought down on a desk: a dull thump, then the paper rustles. */
export const STAMP_SECONDS = 0.5
/** When the stamp lands, seconds in: a moment of lift first, so the strike does not click. */
export const STAMP_AT = 0.03
/** When the paper rustles, seconds in. */
export const STAMP_PAPER = [0.1, 0.4] as const
function stamp(rate: number): Stereo {
  const size = Math.floor(STAMP_SECONDS * rate)
  const out: Stereo = [new Float32Array(size), new Float32Array(size)]
  const rng = random(29)
  const soft = 1 - Math.exp(-TAU * 2500 / rate), dark = 1 - Math.exp(-TAU * 1500 / rate), bright = 1 - Math.exp(-TAU * 5000 / rate)
  const [from, to] = STAMP_PAPER
  let felt = 0, below = 0, above = 0, grain = 0, target = 0, next = 0
  for (let i = 0; i < size; i++) {
    const t = i / rate, s = t - STAMP_AT
    let strike = 0
    if (s >= 0) {
      // rubber on wood: a low thump that sinks as it settles, a short knock of the desk, and a muffled smack
      const thud = sin(90 * s + 90 * (1 - Math.exp(-40 * s)) / 40) * Math.exp(-26 * s)
      const knock = sin(230 * s) * Math.exp(-60 * s) * 0.35
      felt += (NOISE[(i + 3301) & (NOISE_SIZE - 1)] - felt) * soft
      strike = (thud + knock + felt * Math.exp(-260 * s) * 0.8) * Math.min(1, s / 0.0015)
    }
    // the sheet shifts under the hand: bright noise in uneven grains, swelling and dying away
    const x = NOISE[(i * 3 + 17011) & (NOISE_SIZE - 1)]
    below += (x - below) * dark
    above += (x - above) * bright
    let paper = 0
    if (t > from && t < to) {
      if (i >= next) { target = rng() ** 2; next = i + Math.floor((0.004 + rng() * 0.012) * rate) }
      grain += (target - grain) * 0.02
      paper = (above - below) * Math.sin(Math.PI * (t - from) / (to - from)) ** 2 * (0.3 + grain) * 0.45
    }
    // the stamp sits in the middle; the paper slides off a little to the right
    const tail = Math.min(1, (STAMP_SECONDS - t) / 0.03)
    out[0][i] = (strike + paper * 0.8) * tail
    out[1][i] = (strike + paper * 1.2) * tail
  }
  return levelled(out, 0.5, 0.2)
}

/** The sea round the island, played as a loop: a deep swell under breakers that rise, spill and wash back. */
export const WAVES_SECONDS = 26
/** When each breaker begins, seconds into the loop; uneven, so the loop is hard to hear. */
export const WAVES_BREAKERS = [0.4, 5.6, 10.1, 15.9, 20.3] as const
function waves(rate: number): Stereo {
  const mix = new Mix(rate, WAVES_SECONDS)
  const rng = random(31)
  // a one-pole low-pass over the shared noise; `cutoff` may change from sample to sample
  const noise = (offset: number) => {
    let y = 0, i = offset
    return (cutoff: number) => {
      const x = NOISE[i++ & (NOISE_SIZE - 1)]
      y += (x - y) * Math.min(1, TAU * cutoff / rate)
      return [y, x - y] as const
    }
  }
  // The swell: two half-loop rises of deep noise, crossing so its loudness never dips, even at the seam.
  for (const n of [0, 1]) {
    const bed = noise(n * 30011)
    mix.voice(n * WAVES_SECONDS / 2, WAVES_SECONDS, 1.3, n ? 0.5 : -0.5, 0, (t) => bed(180)[0] * Math.sin(Math.PI * t / WAVES_SECONDS), 0.05)
  }
  WAVES_BREAKERS.forEach((start, n) => {
    const water = noise(Math.floor(rng() * NOISE_SIZE))
    const rise = 1.3 + rng() * 0.7, fall = 1.1 + rng() * 0.7, pan = (rng() - 0.5) * 1.2
    mix.voice(start, rise + fall * 4, 0.8 + rng() * 0.4, pan, 0.35, (t) => {
      // gathers slowly, breaks, then washes back with a fizz that lasts a little longer than the roar
      const u = t / rise
      const roar = u < 1 ? u * u : Math.exp(-(t - rise) / fall)
      const fizz = u < 1 ? u ** 4 : Math.exp(-(t - rise) / (fall * 1.5))
      const [low, high] = water(150 + 1400 * roar)
      return low * roar * 1.6 + high * fizz * 0.12 * (n % 2 ? 1 : 0.8)
    }, 0.4)
  })
  mix.reverb(1.6, 0.25)
  return mix.finish(0.07, 0.3)
}

const EFFECTS: Record<EffectKey, (rate: number) => Stereo> = {
  soundTakeoff: takeoff, soundLanding: landing, soundFlyover: flyover, soundUI: tap, soundNotice: notice, soundTutorial: tutorial, soundOpenTeam: whoosh, soundOpenAirport: announce, soundOpenTower: hum, soundOpenStaffing: stamp, soundWaves: waves,
}

export const effectSamples = (key: EffectKey, rate = RATE) => EFFECTS[key](rate)
