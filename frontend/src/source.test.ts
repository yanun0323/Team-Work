import { describe, expect, it } from 'vitest'
import type { GitSource } from './core/domain/types'
import { OFFICIAL_SOURCE } from './core/domain/sources'
import { sourceName, sourceState, sourceText } from './source'

const git = (extra: Partial<GitSource> = {}): GitSource => ({
  kind: 'git', repo: 'https://github.com/acme/skills', ref: 'v1.0.0', commit: 'aaa', latestRef: 'v1.0.0', latest: 'aaa',
  private: false, upstream: true, ...extra,
})

describe('blueprint and skill sources', () => {
  it('names a repo with its version, or a folder', () => {
    expect(sourceText(git())).toBe('acme/skills @ v1.0.0')
    expect(sourceText(git({ ref: '' }))).toBe('acme/skills')
    expect(sourceText(git({ repo: 'git@github.com:acme/skills' }))).toBe('git@github.com:acme/skills @ v1.0.0')
    expect(sourceText({ kind: 'yaml', text: 'name: x' })).toBe('本地')
  })

  it('calls the official source by name, not by its repo', () => {
    const kept = { kind: 'git' as const, repo: 'https://github.com/yanun0323/Team-Work-Source', ref: '', upstream: true, autoApply: true }
    expect(sourceName({ ...kept, id: OFFICIAL_SOURCE })).toBe('官方來源')
    expect(sourceName({ ...kept, id: 'src1' })).toBe('yanun0323/Team-Work-Source')
  })

  it('says the most pressing thing first', () => {
    // no upstream beats a failed update, which beats a newer version waiting
    const gone = sourceState(git({ upstream: false, latest: 'bbb', update: { at: 0, ok: false, error: '找不到上游' } }), 300)
    expect([gone.tone, gone.label]).toEqual(['bad', '找不到上游'])
    expect(gone.note).toContain('仍使用 v1.0.0')
    const failed = sourceState(git({ latest: 'bbb', latestRef: 'v1.1.0', update: { at: 0, ok: false, error: '下載逾時' } }), 300)
    expect([failed.tone, failed.label]).toEqual(['bad', '更新失敗'])
    expect(failed.note).toBe('5 分鐘前・下載逾時，仍使用 v1.0.0')
    expect(sourceState(git({ latest: 'bbb', latestRef: 'v1.1.0' }), 0)).toEqual({ tone: 'behind', label: '有新版本 v1.1.0' })
    expect(sourceState(git({ update: { at: 0, ok: true } }), 30)).toEqual({ tone: 'ok', label: '已是最新', note: '更新成功・剛剛' })
  })
})
