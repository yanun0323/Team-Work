// What to say about where a blueprint or a skill pack comes from: one line naming it, and for a Git repo
// whether its upstream was found and how the last update went. Pure, no React.

import type { BlueprintSource, GitSource, LocalSkills, Tool } from './core/domain/types'

/**
 * Where something comes from, as one line: `owner/repo @ version` (no version: the default branch), a
 * folder on this computer, or YAML.
 */
export function sourceText(s: BlueprintSource | LocalSkills) {
  if (s.kind === 'yaml') return '本地'
  if (s.kind === 'preset') return '內建'
  if (s.kind === 'local') return s.path
  const repo = s.repo.replace('git@github.com:', '')
  return s.ref ? `${repo} @ ${s.ref}` : repo
}

export interface SourceState {
  /** bad: needs the user; behind: a newer version is waiting; ok: up to date. */
  tone: 'bad' | 'behind' | 'ok'
  label: string
  note?: string
}

/** How long ago a world time was, in words. */
export function ago(now: number, at: number) {
  const s = Math.max(0, now - at)
  if (s < 60) return '剛剛'
  if (s < 3600) return `${Math.floor(s / 60)} 分鐘前`
  return `${Math.floor(s / 3600)} 小時前`
}

/**
 * The state of a source, most pressing first: an upstream that can't be found, then a failed update (the
 * version in use stays), then a newer version waiting, then up to date.
 */
export function sourceState(s: GitSource, now: number): SourceState {
  const inUse = s.ref || s.commit
  const newest = s.latestRef || s.latest
  if (!s.upstream) return { tone: 'bad', label: '找不到上游', note: `repo 可能已改名、刪除或沒有讀取權限，仍使用 ${inUse}` }
  if (s.update && !s.update.ok) {
    return { tone: 'bad', label: '更新失敗', note: `${ago(now, s.update.at)}・${s.update.error ?? '原因不明'}，仍使用 ${inUse}` }
  }
  if (s.commit !== s.latest) return { tone: 'behind', label: `有新版本 ${newest}` }
  return { tone: 'ok', label: '已是最新', note: s.update ? `更新成功・${ago(now, s.update.at)}` : undefined }
}

/** Names of the four tools an employee may be allowed. */
export const TOOL_NAMES: Record<Tool, string> = {
  readFile: '讀取檔案',
  writeFile: '寫入檔案',
  webSearch: '網路搜尋',
  runCommand: '執行指令',
}
