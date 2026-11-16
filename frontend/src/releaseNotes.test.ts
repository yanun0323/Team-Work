import { describe, expect, it } from 'vitest'
import { SEEN_KEY as INTRO_SEEN_KEY } from './boot'
import { compareVersions, NOTES_SEEN_KEY, notesDue } from './releaseNotes'
import { notesIn, RELEASES, releasesFrom } from './releaseNotesText'

const LOCALES = ['zh', 'en', 'zh-Hans', 'ja', 'ko'] as const

function storage(items: Record<string, string> = {}) {
  const kept = new Map(Object.entries(items))
  return { kept, getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v) }
}

describe('compareVersions', () => {
  it('reads each part as a number', () => {
    expect(compareVersions('0.0.10', '0.0.9')).toBeGreaterThan(0)
    expect(compareVersions('0.1.0', '0.0.68')).toBeGreaterThan(0)
    expect(compareVersions('0.0.68', '0.0.68')).toBe(0)
  })
})

describe('notesDue', () => {
  it('shows nothing to someone new, and remembers the version', () => {
    const s = storage()
    expect(notesDue(s, '0.0.69')).toBe(false)
    expect(s.kept.get(NOTES_SEEN_KEY)).toBe('0.0.69')
  })

  it('shows the notes to someone who used a version from before them', () => {
    expect(notesDue(storage({ [INTRO_SEEN_KEY]: '1' }), '0.0.69')).toBe(true)
  })

  it('shows them once per newer version', () => {
    const s = storage({ [INTRO_SEEN_KEY]: '1', [NOTES_SEEN_KEY]: '0.0.68' })
    expect(notesDue(s, '0.0.69')).toBe(true)
    expect(notesDue(s, '0.0.69')).toBe(false)
  })

  it('does not show them for an older version', () => {
    expect(notesDue(storage({ [INTRO_SEEN_KEY]: '1', [NOTES_SEEN_KEY]: '0.0.69' }), '0.0.68')).toBe(false)
  })

  it('shows nothing when storage cannot be read', () => {
    const broken = { getItem: () => { throw new Error('private') }, setItem: () => {} }
    expect(notesDue(broken, '0.0.69')).toBe(false)
  })
})

describe('release notes', () => {
  it('lists the versions newest first, by number', () => {
    const r = releasesFrom({ 'x/0.0.9/en.md': 'nine', 'x/0.0.10/en.md': 'ten\n', 'x/0.0.10/ja.md': '十' })
    expect(r.map((x) => x.version)).toEqual(['0.0.10', '0.0.9'])
    expect(r[0].text).toEqual({ en: 'ten', ja: '十' })
  })

  it('falls back to English for a missing language', () => {
    expect(notesIn({ version: '1', text: { en: 'hi' } }, 'ko')).toBe('hi')
  })

  it('has every version in all five languages', () => {
    expect(RELEASES.length).toBeGreaterThan(0)
    const missing = RELEASES.flatMap((r) => LOCALES.filter((l) => !r.text[l]).map((l) => `${r.version}/${l}`))
    expect(missing).toEqual([])
  })
})
