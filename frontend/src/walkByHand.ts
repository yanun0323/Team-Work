// The user's own figure on their island, walked with W, A, S and D while their profile is open (World.tsx): which of
// those keys are held, on the keyboard or on the keys drawn in the corner (WalkKeys.tsx). `Strollers` reads it every
// frame, as `walkVelocity`; the figure goes about on its own until a key is pressed, and again once none has been for a
// while (`takeOver`).

import { useEffect } from 'react'
import { create } from 'zustand'
import { SCREEN_RIGHT } from './camera'
import { ISLAND_SPEED } from './crowd'
import type { P } from './walk'

export type WalkKey = 'w' | 'a' | 's' | 'd'

/** How fast the user walks by hand, in world units a second: a little faster than people go about on their own. */
export const HAND_SPEED = ISLAND_SPEED * 1.4
/** Seconds with no key pressed before the user goes about on their own again. */
export const LET_GO_SECONDS = 8

const CODES: Partial<Record<string, WalkKey>> = { KeyW: 'w', KeyA: 'a', KeyS: 's', KeyD: 'd' }
/** Each key's way on the screen: [right, up]. */
const SCREEN: Record<WalkKey, P> = { w: [0, 1], a: [-1, 0], s: [0, -1], d: [1, 0] }

export interface Walk {
  /** Held on the keyboard. */
  keys: readonly WalkKey[]
  /** Held down on the screen with the pointer. */
  taps: readonly WalkKey[]
  /** Shift held: running. */
  fast: boolean
  /** Something to type in has the focus, so the keys type rather than walk. */
  typing: boolean
}

export const useWalk = create<Walk>(() => ({ keys: [], taps: [], fast: false, typing: false }))

const add = (list: readonly WalkKey[], k: WalkKey) => (list.includes(k) ? list : [...list, k])
const drop = (list: readonly WalkKey[], k: WalkKey) => (list.includes(k) ? list.filter((x) => x !== k) : list)

/** Whether `k` is held, either way. */
export const held = (w: Walk, k: WalkKey) => w.keys.includes(k) || w.taps.includes(k)

/** A key on the screen pressed (`on`) or let go. */
export const tap = (k: WalkKey, on: boolean) => useWalk.setState((w) => ({ taps: on ? add(w.taps, k) : drop(w.taps, k) }))

/**
 * Which way and how fast the user walks, in world units a second, from the keys held: W up the screen, S down, A left,
 * D right, two at once on the diagonal; Shift runs. [0, 0] with none held, or opposite ones.
 */
export function walkVelocity(w: Walk): P {
  let right = 0
  let up = 0
  for (const k of ['w', 'a', 's', 'd'] as const) {
    if (!held(w, k)) continue
    right += SCREEN[k][0]
    up += SCREEN[k][1]
  }
  const length = Math.hypot(right, up)
  if (!length) return [0, 0]
  const speed = (HAND_SPEED * (w.fast ? 2 : 1)) / length
  // the screen's right and up flattened onto the ground: up the screen is away from the camera
  const [rx, rz] = [SCREEN_RIGHT.x, SCREEN_RIGHT.z]
  return [(rx * right + rz * up) * speed, (rz * right - rx * up) * speed]
}

/**
 * Who walks the user, at `now` in seconds with `v` steered (`walkVelocity`): undefined while they go about on their own,
 * as they do until a key is pressed and again once none has been for `LET_GO_SECONDS`; otherwise `v`, standing still
 * between keys. `hold` keeps when a key was last pressed.
 */
export function takeOver(hold: { last: number }, now: number, v: P): P | undefined {
  if (v[0] || v[1]) hold.last = now
  return now - hold.last < LET_GO_SECONDS ? v : undefined
}

const typingIn = (el: EventTarget | null) => el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))

/**
 * While `on`, W, A, S and D on the keyboard walk the user, and Shift with them runs; not while typing, nor with Ctrl,
 * ⌘ or ⌥ (a shortcut). Everything held is let go when it goes off, or the window loses the focus.
 */
export function useWalkKeys(on: boolean) {
  useEffect(() => {
    if (!on) return
    const typing = (el: EventTarget | null) => {
      const now = typingIn(el)
      useWalk.setState(now ? { typing: true, keys: [] } : { typing: false })
    }
    typing(document.activeElement)
    const down = (e: KeyboardEvent) => {
      if (e.key === 'Shift') useWalk.setState({ fast: true })
      // macOS sends no key-up for a key let go while ⌘ is down
      if (e.ctrlKey || e.metaKey || e.altKey) return useWalk.setState({ keys: [] })
      const k = CODES[e.code]
      if (!k || typingIn(e.target)) return
      // handled here: otherwise the Mac app's WKWebView hands the key back to AppKit, which beeps
      e.preventDefault()
      useWalk.setState((w) => ({ keys: add(w.keys, k), fast: e.shiftKey }))
    }
    const up = (e: KeyboardEvent) => {
      if (e.key === 'Shift') useWalk.setState({ fast: false })
      const k = CODES[e.code]
      if (k) useWalk.setState((w) => ({ keys: drop(w.keys, k) }))
    }
    const letGo = () => useWalk.setState({ keys: [], taps: [], fast: false })
    const focusIn = (e: FocusEvent) => typing(e.target)
    const focusOut = (e: FocusEvent) => typing(e.relatedTarget)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', letGo)
    document.addEventListener('focusin', focusIn)
    document.addEventListener('focusout', focusOut)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', letGo)
      document.removeEventListener('focusin', focusIn)
      document.removeEventListener('focusout', focusOut)
      letGo()
      useWalk.setState({ typing: false })
    }
  }, [on])
}
