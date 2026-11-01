// What to say about where a blueprint or a skill pack comes from: one line naming it, and for a Git repo
// whether its upstream was found and how the last update went. Pure, no React.

import { tr } from './core/i18n'
import type { BlueprintSource, GitSource, LocalSkills, Tool } from './core/domain/types'

/**
 * Where something comes from, as one line: `owner/repo @ version` (no version: the default branch), a
 * folder on this computer, or YAML.
 */
export function sourceText(s: BlueprintSource | LocalSkills) {
  if (s.kind === 'yaml') return tr('本地')
  if (s.kind === 'preset') return tr('內建')
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
  if (s < 60) return tr('剛剛')
  if (s < 3600) return tr('{a} 分鐘前', { a: Math.floor(s / 60) })
  return tr('{a} 小時前', { a: Math.floor(s / 3600) })
}

/**
 * The state of a source, most pressing first: an upstream that can't be found, then a failed update (the
 * version in use stays), then a newer version waiting, then up to date.
 */
export function sourceState(s: GitSource, now: number): SourceState {
  const inUse = s.ref || s.commit
  const newest = s.latestRef || s.latest
  if (!s.upstream) return { tone: 'bad', label: tr('找不到上游'), note: tr('repo 可能已改名、刪除或沒有讀取權限，仍使用 {inUse}', { inUse }) }
  if (s.update && !s.update.ok) {
    return { tone: 'bad', label: tr('更新失敗'), note: tr('{a}・{b}，仍使用 {inUse}', { a: ago(now, s.update.at), b: s.update.error ?? tr('原因不明'), inUse }) }
  }
  if (s.commit !== s.latest) return { tone: 'behind', label: tr('有新版本 {newest}', { newest }) }
  return { tone: 'ok', label: tr('已是最新'), note: s.update ? tr('更新成功・{a}', { a: ago(now, s.update.at) }) : undefined }
}

/** Names of the four tools an employee may be allowed. */
const TOOL_NAMES = {
  readFile: '讀取檔案',
  writeFile: '寫入檔案',
  webSearch: '網路搜尋',
  runCommand: '執行指令',
} as const

export const toolName = (t: Tool) => tr(TOOL_NAMES[t])
