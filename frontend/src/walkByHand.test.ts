import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { ISO_DIR, SCREEN_RIGHT } from './camera'
import { ISLAND_SPEED } from './crowd'
import { HAND_SPEED, LET_GO_SECONDS, takeOver, walkVelocity, type Walk, type WalkKey } from './walkByHand'

const walk = (keys: WalkKey[], fast = false, taps: WalkKey[] = []): Walk => ({ keys, taps, fast, typing: false })
/** Where a ground velocity goes on the screen: [right, up], at unit length. */
const onScreen = ([x, z]: [number, number]) => {
  const v = new THREE.Vector3(x, 0, z)
  // up the screen is away from the camera along the ground
  const away = new THREE.Vector3(-ISO_DIR.x, 0, -ISO_DIR.z).normalize()
  return [v.dot(SCREEN_RIGHT) / v.length(), v.dot(away) / v.length()]
}

describe('walkVelocity', () => {
  it('stands still with nothing held, or opposite keys', () => {
    expect(walkVelocity(walk([]))).toEqual([0, 0])
    expect(walkVelocity(walk(['w', 's']))).toEqual([0, 0])
    expect(walkVelocity(walk(['a', 'd']))).toEqual([0, 0])
  })

  it('walks a little faster by hand than people go about on their own', () => {
    expect(HAND_SPEED).toBeGreaterThan(ISLAND_SPEED)
  })

  it('walks up, down, left and right on the screen at walking speed', () => {
    const ways: Array<[WalkKey, number[]]> = [['w', [0, 1]], ['s', [0, -1]], ['a', [-1, 0]], ['d', [1, 0]]]
    for (const [k, way] of ways) {
      const v = walkVelocity(walk([k]))
      expect(Math.hypot(...v)).toBeCloseTo(HAND_SPEED)
      onScreen(v).forEach((c, i) => expect(c).toBeCloseTo(way[i]))
    }
  })

  it('walks the diagonal at the same speed, runs with Shift, and counts the keys on the screen too', () => {
    const v = walkVelocity(walk(['w', 'd']))
    expect(Math.hypot(...v)).toBeCloseTo(HAND_SPEED)
    onScreen(v).forEach((c) => expect(c).toBeCloseTo(Math.SQRT1_2))
    expect(Math.hypot(...walkVelocity(walk(['a'], true)))).toBeCloseTo(HAND_SPEED * 2)
    expect(walkVelocity(walk([], false, ['w']))).toEqual(walkVelocity(walk(['w'])))
  })
})

describe('takeOver', () => {
  it('leaves the user going about on their own until a key is pressed', () => {
    const hold = { last: -Infinity }
    expect(takeOver(hold, 0, [0, 0])).toBeUndefined()
    expect(takeOver(hold, 30, [0, 0])).toBeUndefined()
  })

  it('walks them by hand from the first key, standing still between keys', () => {
    const hold = { last: -Infinity }
    expect(takeOver(hold, 10, [1, 0])).toEqual([1, 0])
    expect(takeOver(hold, 11, [0, 0])).toEqual([0, 0])
    expect(takeOver(hold, 10 + LET_GO_SECONDS - 0.1, [0, 0])).toEqual([0, 0])
    // a key again starts the wait over
    expect(takeOver(hold, 10 + LET_GO_SECONDS - 0.1, [0, 1])).toEqual([0, 1])
    expect(takeOver(hold, 10 + LET_GO_SECONDS + 1, [0, 0])).toEqual([0, 0])
  })

  it('lets them go about on their own again once nothing is pressed for a while', () => {
    const hold = { last: -Infinity }
    takeOver(hold, 10, [1, 0])
    expect(takeOver(hold, 10 + LET_GO_SECONDS + 0.1, [0, 0])).toBeUndefined()
    // and takes them back at the next key
    expect(takeOver(hold, 40, [-1, 0])).toEqual([-1, 0])
  })
})
