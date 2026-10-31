import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { Help } from './Help'

it('lists the main topics first, then the airport and the company', () => {
  const html = renderToStaticMarkup(<Help leaving={false} onGone={() => {}} />)
  const nav = html.slice(html.indexOf('<nav'), html.indexOf('</nav>'))
  const words = [...nav.matchAll(/<(button|h2)[^>]*>([^<]+)</g)].map((m) => m[2])
  expect(words).toEqual([
    '快速開始', '地圖', '機場', '公司',
    '機場', '模型供應商', '員工藍圖', '任務流程', '設定', '關於',
    '公司', '對話', '任務', '回覆與討論', '員工', '終端機', '設定',
  ])
})
