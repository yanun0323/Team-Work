import { useEffect, useState } from 'react'

/** Whether the Mac app has found an update. The app sets window.twUpdate and announces each change with a tw-update event. */
const found = () => (globalThis as { twUpdate?: boolean }).twUpdate === true

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
