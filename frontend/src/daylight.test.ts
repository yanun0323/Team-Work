import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { lightAt, MIN_SUN_ELEVATION, MINECRAFT_DAY, phaseOf } from './daylight'

const elevation = (phase: number) => THREE.MathUtils.radToDeg(Math.asin(lightAt(phase).toSun.y))

describe('phaseOf', () => {
  it('follows the clock', () => {
    expect(phaseOf('real', new Date(2026, 10, 4, 0, 0))).toBe(0)
    expect(phaseOf('real', new Date(2026, 10, 4, 12, 0))).toBe(0.5)
    expect(phaseOf('real', new Date(2026, 10, 4, 18, 0))).toBe(0.75)
  })

  it('runs a Minecraft day in 20 minutes, starting at sunrise', () => {
    const start = new Date(MINECRAFT_DAY * 1000)
    expect(phaseOf('minecraft', start)).toBe(0.25)
    expect(phaseOf('minecraft', new Date(start.getTime() + MINECRAFT_DAY / 4))).toBe(0.5)
    expect(phaseOf('minecraft', new Date(start.getTime() + MINECRAFT_DAY))).toBe(0.25)
  })

  it('stands still for always day or night', () => {
    expect(phaseOf('day', new Date(2026, 10, 4, 23, 0))).toBe(0.5)
    expect(phaseOf('night', new Date(2026, 10, 4, 12, 0))).toBe(0)
  })
})

describe('lightAt', () => {
  it('lights noon as the town was always lit', () => {
    const noon = lightAt(0.5)
    expect(noon.sky.getHexString()).toBe('3b86c6')
    expect(noon.strength).toBe(2.2)
    expect(noon.glow).toBe(0)
    expect(noon.toSun.clone().multiplyScalar(57.5).toArray().map(Math.round)).toEqual([-26, 48, 18])
  })

  it('makes the windows glow at night', () => {
    expect(lightAt(0).glow).toBe(1)
    expect(lightAt(0.9).glow).toBe(1)
    expect(lightAt(0.79).glow).toBeGreaterThan(0)
  })

  it('holds the full dawn and dusk look for an hour', () => {
    const at = (h: number) => lightAt(h / 24)
    for (const [from, to, sky] of [[5.5, 6.5, '8f86b4'], [17.5, 18.5, '8a5f8f']] as const) {
      for (let h = from; h <= to; h += 0.25) expect(at(h).sky.getHexString()).toBe(sky)
      expect(at(from - 0.5).sky.getHexString()).not.toBe(sky)
      expect(at(to + 0.5).sky.getHexString()).not.toBe(sky)
    }
  })

  it('changes smoothly round the whole day, midnight included', () => {
    for (let p = 0; p < 1; p += 0.001) {
      const a = lightAt(p), b = lightAt(p + 0.001)
      expect(Math.abs(a.strength - b.strength)).toBeLessThan(0.05)
      expect(a.toSun.angleTo(b.toSun)).toBeLessThan(0.03)
    }
  })

  it('never lets the sun sink below its lowest', () => {
    for (let p = 0; p < 1; p += 0.01) expect(elevation(p)).toBeGreaterThanOrEqual(MIN_SUN_ELEVATION - 1e-9)
  })
})
