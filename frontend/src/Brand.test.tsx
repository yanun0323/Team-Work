import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { Brand, QuotaList, UsageRing, balanceText, clockText, leftOf, resetText } from './Brand'
import type { ModelProvider } from './core/domain/types'

it('shows the clock in place of a title, and names the app only for a screen reader', () => {
  const html = renderToStaticMarkup(<Brand />)
  expect(html).toContain('<h1 class="fx-sr">Team Work</h1>')
  expect(html).not.toContain('wordmark')
  expect(html).toContain('class="fx-brand-time"')
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
  // what is left, not what is used: 100 - 49.6 and 100 - 12
  expect(html).toContain('<span>50</span>')
  expect(html).toContain('<span>88</span>')
  expect(html).not.toContain('50%<')
  expect(html).toContain('>110.00 CNY<')
  expect(html).toContain('<span class="fx-quota-balance">110.00 CNY</span>')
})

it('leaves out an API key whose balance is unknown, but keeps a subscription without numbers', () => {
  const html = renderToStaticMarkup(<QuotaList now={0} providers={[sub('a', 'Claude'), key('c', 'OpenAI')]} quotas={{}} />)
  expect(html).toContain('Claude')
  expect(html).not.toContain('OpenAI')
  expect(html).not.toContain('fx-quota-balance')
  expect(renderToStaticMarkup(<QuotaList now={0} providers={[key('c', 'OpenAI')]} quotas={{}} />)).toBe('')
})

it('greys out a ring with no number', () => {
  const html = renderToStaticMarkup(<UsageRing now={0} label={(a) => a} />)
  expect(html).not.toContain('fx-ring-fill')
  expect(html).toContain('>-<')
})

it('turns the share used into the share left, kept within 0 to 100', () => {
  expect(leftOf(undefined)).toBeUndefined()
  expect(leftOf(0)).toBe(100)
  expect(leftOf(25)).toBe(75)
  expect(leftOf(120)).toBe(0)
  expect(leftOf(-5)).toBe(100)
})

it('leaves a used-up ring empty', () => {
  const html = renderToStaticMarkup(<UsageRing left={0} now={0} label={(a) => a} />)
  expect(html).not.toContain('fx-ring-fill')
  expect(html).toContain('<span>0</span>')
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
    <QuotaList now={now} providers={[sub('a', 'Claude')]} quotas={{ a: { fiveHour: 70, fiveHourResetAt: now + 2 * 3600 + 13 * 60, weekly: 12 } }} />,
  )
  expect(html).toContain('<small aria-hidden="true">2h13m</small>')
  expect(html).toContain('aria-label="5 小時剩餘 30%，2 小時 13 分鐘後重置"')
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
