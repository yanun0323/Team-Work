// What changed in each version, from release-notes/<version>/<language>.md at the top of the repository: the app shows
// them, and `make appcast` puts the new version's into the update window. Every version has all five languages
// (releaseNotes.test.ts checks).

import type { Locale } from './core/domain/types'
import { compareVersions } from './releaseNotes'

export interface Release {
  version: string
  text: Partial<Record<Locale, string>>
}

const FILES = import.meta.glob<string>('../../release-notes/*/*.md', { eager: true, query: '?raw', import: 'default' })

/** The versions in `files` (paths ending in <version>/<language>.md), newest first. */
export function releasesFrom(files: Record<string, string>): Release[] {
  const byVersion = new Map<string, Release>()
  for (const [path, text] of Object.entries(files)) {
    const m = /([^/]+)\/([^/]+)\.md$/.exec(path)
    if (!m) continue
    const [, version, locale] = m
    const release = byVersion.get(version) ?? { version, text: {} }
    release.text[locale as Locale] = text.trim()
    byVersion.set(version, release)
  }
  return [...byVersion.values()].sort((a, b) => compareVersions(b.version, a.version))
}

export const RELEASES = releasesFrom(FILES)

/** A version's notes in a language, or in English should that one be missing. */
export const notesIn = (release: Release, locale: Locale) => release.text[locale] ?? release.text.en ?? ''
