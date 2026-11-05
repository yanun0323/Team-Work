import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import type { ReactNode } from 'react'
import { Help, helpBodiesForTest, helpTopicIdsForTest } from './Help'
import { HELP_EN } from './HelpEn'

it('lists the main topics first, then the airport and the company', () => {
  const html = renderToStaticMarkup(<Help leaving={false} onGone={() => {}} />)
  const nav = html.slice(html.indexOf('<nav'), html.indexOf('</nav>'))
  const words = [...nav.matchAll(/<(button|h2)[^>]*>([^<]+)</g)].map((m) => m[2])
  expect(words).toEqual([
    '快速開始', '地圖', '機場', '公司',
    '機場', '對話', '模型供應商', '員工藍圖', '任務藍圖', '來源', '統計', '設定', '關於',
    '公司', '對話', '任務', '回覆與討論', '員工', '檔案瀏覽', '終端機', '設定',
  ])
})

const textOf = (node: ReactNode): string => renderToStaticMarkup(<>{node}</>).replace(/<[^>]+>/g, ' ')

it('has every topic in English, with no Chinese left', () => {
  expect(Object.keys(HELP_EN).sort()).toEqual(helpTopicIdsForTest().sort())
  for (const t of Object.values(HELP_EN)) {
    expect(`${t.label} ${t.title ?? ''} ${t.alt} ${textOf(t.body)}`, t.label).not.toMatch(/\p{Script=Han}/u)
  }
})

/** The tags a body is made of, at its top level. */
const topTags = (node: ReactNode): string[] => {
  const tags: string[] = []
  let depth = 0
  for (const m of renderToStaticMarkup(<>{node}</>).matchAll(/<(\/?)([a-z]+)[^>]*?(\/?)>/g)) {
    if (m[3]) continue
    if (m[1]) depth--
    else if (depth++ === 0) tags.push(m[2] === 'p' && m[0].includes('fx-help-pit') ? 'pit' : m[2])
  }
  return tags
}

it('puts the opening lines and pitfall on a white note, with the reference after it', () => {
  const html = renderToStaticMarkup(<Help leaving={false} onGone={() => {}} />)
  const page = html.slice(html.indexOf('id="fx-help-panel"'))
  expect(page).toMatch(/<div class="fx-help-note"><p>[^]*<p class="fx-help-pit">[^]*<\/p><\/div><dl>/)
})

it('opens each topic with what it is for, then at most one pitfall, then the reference in one box', () => {
  for (const { id, body } of helpBodiesForTest()) {
    expect(topTags(body).join(' '), id).toMatch(/^(p|ol)( (p|ol))* (pit )?dl$/)
  }
})
