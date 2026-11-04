import { useEffect, useState } from 'react'
import { version } from '../package.json'

/** The version, then the commit it was built from: v0.0.11 (4094275). */
export const VERSION = `v${version}${__COMMIT__ ? ` (${__COMMIT__})` : ''}`

/** Whether there is an app to ask about updates: the Mac app, or `make dev-mock`, which pretends to be one. */
export const CAN_CHECK = import.meta.env.MODE === 'desktop' || import.meta.env.MODE === 'mock'

type UpdateWindow = { twUpdate?: boolean; twChecking?: boolean }
const page = globalThis as UpdateWindow

/**
 * What the Mac app knows of updates: whether it has found one, and whether a check is under way. The app sets
 * window.twUpdate and window.twChecking and announces each change with a tw-update event. `make dev-mock` always has
 * an update, so the button can be seen there.
 */
const read = () => ({ found: import.meta.env.MODE === 'mock' || page.twUpdate === true, checking: page.twChecking === true })

export function useUpdateState() {
  const [state, setState] = useState(read)
  useEffect(() => {
    const sync = () => setState(read())
    sync()
    window.addEventListener('tw-update', sync)
    return () => window.removeEventListener('tw-update', sync)
  }, [])
  return state
}

type Handlers = { webkit?: { messageHandlers?: Record<string, { postMessage: (x: null) => void } | undefined> } }
const post = (name: string) => (window as unknown as Handlers).webkit?.messageHandlers?.[name]?.postMessage(null)

/** Asks the app's Sparkle to update; it shows its own windows from there. Outside the app there is no one to ask. */
export const checkForUpdate = () => post('update')

const MOCK_CHECK_MS = 1500

/**
 * Asks the app to look for a newer version now, without a window. The spinner shows at once; the app clears it,
 * and sets whether one was found, when the check ends. `make dev-mock` only pretends to look.
 */
export function checkNow() {
  if (page.twChecking) return
  page.twChecking = true
  window.dispatchEvent(new Event('tw-update'))
  if (import.meta.env.MODE === 'mock') {
    setTimeout(() => {
      page.twChecking = false
      window.dispatchEvent(new Event('tw-update'))
    }, MOCK_CHECK_MS)
    return
  }
  post('checkUpdate')
}
