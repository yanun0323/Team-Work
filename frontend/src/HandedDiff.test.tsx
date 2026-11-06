import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DiffNote, ViewSwitch } from './HandedDiff'
import type { DiffLine } from './diffView'

const same = (n: number): DiffLine[] => Array.from({ length: n }, (_, i) => ({ op: 'same', text: `s${i}` }))

describe('DiffNote', () => {
  it('marks each added and removed line, and folds a long unchanged run behind a button', () => {
    const html = renderToStaticMarkup(<DiffNote split={false} lines={[...same(10), { op: 'del', text: 'old' }, { op: 'add', text: 'new' }]} />)
    expect(html).toContain('<button type="button" class="fx-diff-fold">⋯ 7 行未變更</button>')
    expect(html).toContain('<div class="fx-diff-row fx-diff-del"><span class="fx-diff-no">11</span><span class="fx-diff-no"></span><span class="fx-diff-sign">−</span><span class="fx-diff-text">old</span></div>')
    expect(html).toContain('<div class="fx-diff-row fx-diff-add"><span class="fx-diff-no"></span><span class="fx-diff-no">11</span><span class="fx-diff-sign">+</span><span class="fx-diff-text">new</span></div>')
  })

  it('sets a changed line beside what it replaced', () => {
    const html = renderToStaticMarkup(<DiffNote split lines={[{ op: 'del', text: 'old' }, { op: 'add', text: 'new' }, { op: 'add', text: 'more' }]} />)
    expect(html).toMatch(/^<div class="fx-diff fx-diff-split">/)
    expect(html).toContain('<span class="fx-diff-text fx-diff-del">old</span><span class="fx-diff-no fx-diff-add">1</span><span class="fx-diff-sign fx-diff-add">+</span><span class="fx-diff-text fx-diff-add">new</span>')
    // the extra new line has nothing beside it
    expect(html).toContain('<span class="fx-diff-text fx-diff-none"></span><span class="fx-diff-no fx-diff-add">2</span>')
  })
})

describe('ViewSwitch', () => {
  it('says which way is on, and offers side by side only with room for it', () => {
    const html = renderToStaticMarkup(<ViewSwitch view="stacked" onView={() => {}} split={false} />)
    expect(html).toContain('aria-pressed="true">上下</button>')
    expect(html).toContain('aria-pressed="false">閱讀</button>')
    expect(html).not.toContain('左右')
    expect(renderToStaticMarkup(<ViewSwitch view="read" onView={() => {}} split />)).toContain('左右')
  })
})
