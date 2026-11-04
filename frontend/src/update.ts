import { useEffect, useState } from 'react'
import { version } from '../package.json'

/** The version, then the commit it was built from: v0.0.11 (4094275). */
export const VERSION = `v${version}${__COMMIT__ ? ` (${__COMMIT__})` : ''}`

/**
 * Whether the Mac app has found an update. The app sets window.twUpdate and announces each change with a tw-update
 * event. `make dev-mock` always has one, so the button can be seen there.
 */
const found = () => import.meta.env.MODE === 'mock' || (globalThis as { twUpdate?: boolean }).twUpdate === true

export function useUpdateFound() {
  const [ready, setReady] = useState(found)
  useEffect(() => {
    const sync = () => setReady(found())
    sync()
    window.addEventListener('tw-update', sync)
    return () => window.removeEventListener('tw-update', sync)
  }, [])
  return ready
}

/** Asks the app's Sparkle to update; it shows its own windows from there. Outside the app there is no one to ask. */
export const checkForUpdate = () =>
  (window as unknown as { webkit?: { messageHandlers?: { update?: { postMessage: (x: null) => void } } } }).webkit?.messageHandlers?.update?.postMessage(null)
