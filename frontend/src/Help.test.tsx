import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import type { ReactNode } from 'react'
import { Help, helpTopicIdsForTest } from './Help'
import { HELP_EN } from './HelpEn'

it('lists the main topics first, then the airport and the company', () => {
  const html = renderToStaticMarkup(<Help leaving={false} onGone={() => {}} />)
  const nav = html.slice(html.indexOf('<nav'), html.indexOf('</nav>'))
  const words = [...nav.matchAll(/<(button|h2)[^>]*>([^<]+)</g)].map((m) => m[2])
  expect(words).toEqual([
    '快速開始', '地圖', '機場', '公司',
    '機場', '模型供應商', '員工藍圖', '任務藍圖', '來源', '設定', '關於',
    '公司', '對話', '任務', '回覆與討論', '員工', '終端機', '設定',
  ])
})

const textOf = (node: ReactNode): string => renderToStaticMarkup(<>{node}</>).replace(/<[^>]+>/g, ' ')

it('has every topic in English, with no Chinese left', () => {
  expect(Object.keys(HELP_EN).sort()).toEqual(helpTopicIdsForTest().sort())
  for (const t of Object.values(HELP_EN)) {
    expect(`${t.label} ${t.title ?? ''} ${t.alt} ${textOf(t.body)}`, t.label).not.toMatch(/\p{Script=Han}/u)
  }
})
