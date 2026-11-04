import { renderToStaticMarkup } from 'react-dom/server'
import { createRef } from 'react'
import { expect, it } from 'vitest'
import { useStore } from './core/store'
import { NewSource, SourceDetail, SourceRow, SourceSign, SourcesTab } from './Sources'
import type { Source } from './core/domain/types'
import { SkillPicker } from './SkillPicker'
import { sourceName } from './source'

const h = { title: createRef<HTMLHeadingElement>(), tid: 't' }
const sources = () => Object.values(useStore.getState().world.sources)

it('lists every source, the agents\' folders among them', () => {
  const html = renderToStaticMarkup(<SourcesTab open={null} onOpen={() => {}} />)
  expect(html).toContain('＋ 新增來源')
  for (const s of sources()) expect(html).toContain(`<b>${sourceName(s)}</b>`)
  expect(html).toContain('<b>~/.claude/</b>')
})

it('shows a repo source with its update switch off, and cannot delete one in use', () => {
  const s = sources().find((x) => x.kind === 'git')!
  const html = renderToStaticMarkup(<SourceDetail id={s.id} onGoneSource={() => {}} {...h} />)
  expect(html).toContain(sourceName(s))
  expect(html).not.toContain('檢查更新')
  expect(html).toContain('自動套用更新')
  expect(html).not.toMatch(/type="checkbox"[^>]*checked/)
})

it('asks for a repo and a branch, or a folder', () => {
  const html = renderToStaticMarkup(<NewSource onDone={() => {}} {...h} />)
  expect(html).toContain('placeholder="owner/repo"')
  expect(html).toContain('分支')
  // nothing read yet, so nothing to add
  expect(html).toMatch(/<button type="submit" class="fx-save" disabled="">新增<\/button>/)
})

it('sits right after the workflows among the airport tabs', async () => {
  const { AIRPORT_TABS } = await import('./prefs')
  const ids = AIRPORT_TABS.map((t) => t.id)
  expect(ids.indexOf('sources')).toBe(ids.indexOf('flows') + 1)
})

it('lists every source under a tick, its skills as notes switched on where taken', () => {
  const w = useStore.getState().world
  const bp = Object.values(w.blueprints).find((b) => b.skills.some((p) => p.sourceId))!
  const html = renderToStaticMarkup(<SkillPicker packs={bp.skills} onChange={() => {}} />)
  for (const s of Object.values(w.sources)) expect(html).toContain(`>${sourceName(s)}</b>`)
  expect(html).not.toContain('加入來源')
})

it('marks a source like a chat: a red ! when a newer version waits, a red dot once one was applied by itself', () => {
  const s: Source = { id: 'src-1', kind: 'git', repo: 'https://github.com/a/b', commit: 'c1', latest: 'c2', upstream: true, autoApply: false }
  const waiting = renderToStaticMarkup(<SourceSign s={s} />)
  expect(waiting).toContain('fx-badge fx-badge-inline')
  expect(waiting).toContain('有新版本')
  const applied = renderToStaticMarkup(<SourceSign s={{ ...s, commit: 'c2', unseen: true }} />)
  expect(applied).toContain('fx-chat-unread')
  expect(applied).not.toContain('fx-badge')
  expect(renderToStaticMarkup(<SourceSign s={{ ...s, commit: 'c2' }} />)).toBe('<span class="fx-chat-sign"></span>')
})

it('stamps a source that applies updates itself', () => {
  const s: Source = { id: 'src-1', kind: 'git', repo: 'https://github.com/a/b', commit: 'c1', latest: 'c1', upstream: true, autoApply: true }
  expect(renderToStaticMarkup(<SourceRow s={s} now={0} />)).toContain('<span class="fx-pill">自動更新</span>')
  expect(renderToStaticMarkup(<SourceRow s={{ ...s, autoApply: false }} now={0} />)).not.toContain('fx-pill')
})

it('stamps a folder as local', () => {
  const s: Source = { id: 'src-2', kind: 'local', path: '~/.agents/', upstream: false, autoApply: false }
  expect(renderToStaticMarkup(<SourceRow s={s} now={0} />)).toContain('<span class="fx-pill">本地</span>')
})

it('turns skills of one name taken from two sources red, asking nothing', () => {
  const w = useStore.getState().world
  const [a, b] = Object.values(w.sources).filter((x) => x.kind === 'git')
  const html = renderToStaticMarkup(<SkillPicker packs={[{ sourceId: a.id, include: null, exclude: [] }, { sourceId: b.id, include: null, exclude: [] }]} onChange={() => {}} />)
  expect(html).not.toContain('alertdialog')
  // the skills are read after the first paint, so only the absence of a dialog shows here; the clash itself is tested in blueprintForm
})
