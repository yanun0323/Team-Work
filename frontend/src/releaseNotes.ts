// When the release notes open by themselves: on the first launch of a new version, for someone who used an older one.
// The notes themselves are in releaseNotesText.ts, loaded only when they are shown.

import { SEEN_KEY as INTRO_SEEN_KEY } from './boot'

/** The last version whose launch was looked at. */
export const NOTES_SEEN_KEY = 'team-work-notes-seen'

/** Compares two versions such as 0.0.9 and 0.0.10 part by part, as numbers. */
export function compareVersions(a: string, b: string) {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d) return d
  }
  return 0
}

/**
 * Whether this launch should show `version`'s notes, remembering it either way. Only an update counts: someone new
 * (no version seen, and no landing played before) has nothing to compare with, and an older version brings no news.
 * Storage that can't be read shows nothing.
 */
export function notesDue(storage: Pick<Storage, 'getItem' | 'setItem'>, version: string) {
  let seen: string | null
  let used: boolean
  try {
    seen = storage.getItem(NOTES_SEEN_KEY)
    used = storage.getItem(INTRO_SEEN_KEY) !== null
  } catch {
    return false
  }
  try { storage.setItem(NOTES_SEEN_KEY, version) } catch { /* shown again next time */ }
  return seen === null ? used : compareVersions(version, seen) > 0
}
