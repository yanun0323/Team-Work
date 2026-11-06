import { renderToStaticMarkup } from 'react-dom/server'
import { createRef } from 'react'
import { afterEach, expect, it } from 'vitest'
import { useStore } from './core/store'
import { blueprintList, flowList } from './core/model'
import { isLocked } from './core/data/presets'
import { OFFICIAL_SOURCE, sourceOfId, sourceUsers } from './core/domain/sources'
import type { Blueprint, Workflow, World } from './core/domain/types'
import { byOrigin } from './Pickers'
import { SourceDetail } from './Sources'
import { sourceName } from './source'

const h = { title: createRef<HTMLHeadingElement>(), tid: 't' }
// rendering reads the store's first world, so a folder source's blueprint and flow are put in it and taken out after
const w: World = useStore.getState().world
let added: string[] = []
afterEach(() => {
  for (const id of added) {
    delete w.blueprints[id]
    delete w.workflows[id]
  }
  added = []
})

/** The world with a folder source bringing a blueprint and a flow. */
function withSourced(): { w: World; src: string } {
  const src = Object.values(w.sources).find((s) => s.kind === 'local')!.id
  const own = Object.values(w.blueprints).find((b) => !isLocked(b.id) && !b.owner)
  const bp: Blueprint = { ...(own ?? Object.values(w.blueprints)[0]), id: `${src}--reviewer`, name: 'Reviewer', owner: undefined, skills: [], source: { kind: 'yaml', text: '' } }
  const wf: Workflow = { ...Object.values(w.workflows)[0], id: `${src}--ship`, name: 'Ship' }
  w.blueprints[bp.id] = bp
  w.workflows[wf.id] = wf
  added = [bp.id, wf.id]
  return { w, src }
}

it('reads the source of a blueprint or flow from its id', () => {
  expect(sourceOfId('src-3--reviewer')).toBe('src-3')
  expect(sourceOfId('bp-3')).toBe('')
  expect(sourceOfId('preset-a--b')).toBe('')
  expect(isLocked('src-3--reviewer')).toBe(true)
  expect(isLocked('bp-3')).toBe(false)
})

it('lists the user\'s own first, then each source under its name, then the built-in ones', () => {
  const { w, src } = withSourced()
  const ids = blueprintList(w).map((b) => b.id)
  const { groups, groupOf } = byOrigin(ids, w.sources)
  const labels = groups.map((g) => g.label)
  expect(labels.slice(-3)).toEqual([sourceName(w.sources[src]), sourceName(w.sources[OFFICIAL_SOURCE]), '內建'])
  expect(groupOf(`${src}--reviewer`)).toBe(groups.length - 3)
  // each group's items follow each other, as the pick-lists need
  const order = ids.map(groupOf)
  expect(order).toEqual([...order].sort((a, b) => a - b))
  expect(flowList(w).map((f) => groupOf(f.id)).filter((g) => g === groups.length - 3)).toHaveLength(1)
})

it('shows what a source brings on its sheet', () => {
  const { src } = withSourced()
  const html = renderToStaticMarkup(<SourceDetail id={src} open={null} onSkill={() => {}} onGoneSource={() => {}} {...h} />)
  expect(html).toContain('<h3>員工藍圖</h3>')
  expect(html).toContain('<b>Reviewer</b>')
  expect(html).toContain('<h3>任務藍圖</h3>')
  expect(html).toContain('<b>Ship</b>')
  expect(html).toContain('aria-label="重新讀取"')
})

it('keeps a source while someone works by its blueprint, but not for its own blueprints', () => {
  const { w, src } = withSourced()
  w.blueprints[`${src}--reviewer`] = { ...w.blueprints[`${src}--reviewer`], skills: [{ sourceId: src, include: null, exclude: [] }] }
  const others = sourceUsers(w, src).length
  expect(sourceUsers(w, src).some((u) => u.id === `${src}--reviewer`)).toBe(false)
  const r = Object.values(w.replicas)[0]
  const was = r.blueprintId
  r.blueprintId = `${src}--reviewer`
  expect(sourceUsers(w, src)).toHaveLength(others + 1)
  r.blueprintId = was
})
