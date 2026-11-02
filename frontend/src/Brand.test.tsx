import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { Brand, QuotaList, UsageRing, balanceText, clockText, resetText } from './Brand'
import type { ModelProvider } from './core/domain/types'

it('names the app', () => {
  expect(renderToStaticMarkup(<Brand />)).toContain('<h1>Team Work</h1>')
})

it('shows the time on a 24-hour clock and the date with its weekday', () => {
  const at = new Date(2026, 9, 31, 0, 5)
  expect(clockText(at, 'zh')).toEqual({ time: '00:05', date: '2026/10/31（週六）' })
  expect(clockText(at, 'en').time).toBe('00:05')
})

const sub = (id: string, name: string): ModelProvider => ({ id, name, kind: 'anthropic', auth: { kind: 'subscription', signedIn: true }, baseUrl: '', models: [] })
const key = (id: string, name: string): ModelProvider => ({ id, name, kind: 'compatible', auth: { kind: 'apiKey', keyHint: '1234' }, baseUrl: '', models: [] })

it('shows a subscription as two rings and an API key as its balance, in the order given', () => {
  const html = renderToStaticMarkup(
    <QuotaList now={0} providers={[sub('a', 'Claude'), key('b', 'DeepSeek'), key('c', 'OpenAI')]} quotas={{ a: { fiveHour: 49.6, weekly: 12 }, b: { balance: 110, currency: 'CNY' } }} />,
  )
  expect(html.indexOf('Claude')).toBeLessThan(html.indexOf('DeepSeek'))
  expect(html).toContain('<span>50</span>')
  expect(html).toContain('<span>12</span>')
  expect(html).not.toContain('50%<')
  expect(html).toContain('>110.00 CNY<')
  expect(html).toMatch(/OpenAI<\/span><span class="fx-quota-balance fx-quota-none">-<\/span>/)
  expect(html).toContain('<span class="fx-quota-balance">110.00 CNY</span>')
})

it('greys out a ring with no number', () => {
  const html = renderToStaticMarkup(<UsageRing now={0} label={(a) => a} />)
  expect(html).not.toContain('fx-ring-fill')
  expect(html).toContain('>-<')
})

it('shows nothing without providers', () => {
  expect(renderToStaticMarkup(<QuotaList now={0} providers={[]} quotas={{}} />)).toBe('')
})

it('writes a balance with its currency, or a bare dash', () => {
  expect(balanceText({ balance: 12.5, currency: 'USD' })).toBe('12.50 USD')
  expect(balanceText(undefined)).toBe('-')
  expect(balanceText({})).toBe('-')
})

it('puts the time left under each ring, and says it in words', () => {
  const now = 1_000_000
  const html = renderToStaticMarkup(
    <QuotaList now={now} providers={[sub('a', 'Claude')]} quotas={{ a: { fiveHour: 50, fiveHourResetAt: now + 2 * 3600 + 13 * 60, weekly: 12 } }} />,
  )
  expect(html).toContain('<small aria-hidden="true">2h13m</small>')
  expect(html).toContain('aria-label="5 小時用量 50%，2 小時 13 分鐘後重置"')
  // no time for the weekly limit: its place stays empty, not '-'
  expect(html).toContain('<small aria-hidden="true"></small>')
})

it('writes the time left in its two largest units', () => {
  const now = 1_000_000
  expect(resetText(now, now + 42 * 60)).toBe('42m')
  expect(resetText(now, now + 30)).toBe('1m')
  expect(resetText(now, now + 3 * 3600)).toBe('3h')
  expect(resetText(now, now + 3 * 3600 + 12 * 60 + 5)).toBe('3h13m')
  expect(resetText(now, now + 4 * 86400 + 6 * 3600 + 59 * 60)).toBe('4d6h')
  expect(resetText(now, now + 2 * 86400 + 20 * 60)).toBe('2d')
  expect(resetText(now, now - 5)).toBe('')
  expect(resetText(now, undefined)).toBe('')
})
