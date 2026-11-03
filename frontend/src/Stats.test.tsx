import { expect, test } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { bars, fmtCacheRate, fmtCount, fmtUsd, partKey, rangeStart, usageColors, UsageReport, type UsageStats, type UsageTotals } from './Stats'

const totals = (o: Partial<UsageTotals>): UsageTotals => ({ calls: 1, input: 0, output: 0, cacheRead: 0, tokens: 0, costUsd: 0, unpriced: 0, ...o })

test('a range starts at the beginning of the local day, counting today', () => {
  const now = new Date(2026, 10, 3, 15, 30)
  expect(rangeStart('30d', now)).toBe(new Date(2026, 9, 5).getTime() / 1000)
  expect(rangeStart('all', now)).toBe(0)
})

test('cost is a dash when nothing was priced', () => {
  expect(fmtUsd(totals({ unpriced: 1 }))).toBe('—')
  expect(fmtUsd(totals({ calls: 0 }))).toBe('—')
  expect(fmtUsd(totals({ costUsd: 0.004 }))).toBe('<$0.01')
  expect(fmtUsd(totals({ calls: 2, unpriced: 1, costUsd: 1.5 }))).toBe('$1.50')
  expect(fmtCacheRate(totals({ input: 1000, cacheRead: 600 }))).toBe('60%')
  expect(fmtCount(1_234_567)).toBe('1.2M')
})

test('long periods are drawn a week to a bar', () => {
  const days = Array.from({ length: 61 }, (_, i) => ({ date: `d${i}`, ...totals({ tokens: 1 }), parts: [{ providerId: 'p', model: 'm', tokens: 1 }] }))
  const list = bars(days)
  expect(list).toHaveLength(9)
  expect(list[0]).toMatchObject({ label: 'd0 – d6', tokens: 7 })
  expect(list[0].parts.get(partKey('p', 'm'))).toBe(7)
  expect(list[8]).toMatchObject({ label: 'd56 – d60', tokens: 5 })
  expect(bars(days.slice(0, 7))).toHaveLength(7)
})

test('split by provider, a bar sums each provider\'s models', () => {
  const days = [{ date: 'd0', ...totals({ tokens: 6 }), parts: [
    { providerId: 'p', model: 'a', tokens: 1 }, { providerId: 'p', model: 'b', tokens: 2 }, { providerId: 'q', model: 'c', tokens: 3 },
  ] }]
  const [bar] = bars(days, 'provider')
  expect([...bar.parts]).toEqual([['p', 3], ['q', 3]])
})

test('the report lists each provider over its models', () => {
  const stats: UsageStats = {
    since: 0,
    total: totals({ calls: 2, tokens: 450, input: 1000, cacheRead: 600, unpriced: 2 }),
    providers: [{ id: 'p', name: 'Claude', ...totals({ calls: 2, tokens: 450, input: 1000, cacheRead: 600, unpriced: 2 }),
      models: [{ model: 'claude-opus', ...totals({ calls: 2, tokens: 450, input: 1000, cacheRead: 600, unpriced: 2 }) }] }],
    days: [{ date: '2026-11-03', ...totals({ tokens: 450 }), parts: [{ providerId: 'p', model: 'claude-opus', tokens: 450 }] }],
  }
  const html = renderToStaticMarkup(<UsageReport stats={stats} depth="model" />)
  expect(html).toContain('Claude')
  expect(html).toContain('claude-opus')
  expect(html).toContain('60%')
  expect(html.indexOf('Claude')).toBeLessThan(html.indexOf('claude-opus'))
  // a swatch before each row, and the day's bar in the model's colour
  expect(html.match(/fx-stats-swatch/g)).toHaveLength(2)
  const color = usageColors(stats.providers).get(partKey('p', 'claude-opus'))!
  expect(html).toContain(`background:${color}`)
  // by provider, the bar takes the provider's colour instead
  const byProvider = renderToStaticMarkup(<UsageReport stats={stats} />)
  expect(byProvider).toContain(`background:${usageColors(stats.providers).get('p')}`)
  expect(byProvider).not.toContain(`background:${color}`)
})

test('every row has its own colour', () => {
  const row = (id: string, models: string[]) => ({ id, name: id, ...totals({}), models: models.map((model) => ({ model, ...totals({}) })) })
  const providers = [row('a', ['a1', 'a2', 'a3']), row('b', ['b1', 'b2'])]
  const colors = usageColors(providers)
  expect(colors.size).toBe(7)
  expect(new Set(colors.values()).size).toBe(7)
})
