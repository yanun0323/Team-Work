// The app's name with the time and date, in the corner of the main screen, and below them what is left of
// each model provider's allowance.

import { useEffect, useState } from 'react'
import { useStore } from './core/store'
import { request } from './core/backend'
import { MOCK } from './core/mode'
import { tr } from './core/i18n'
import type { Locale, ModelProvider } from './core/domain/types'

export function clockText(now: Date, locale: Locale) {
  const tag = locale === 'zh' ? 'zh-TW' : 'en-US'
  return {
    time: new Intl.DateTimeFormat(tag, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now),
    date: new Intl.DateTimeFormat(tag, { year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' }).format(now),
  }
}

/** What a provider reports of its allowance; a field it doesn't report is missing. */
export interface Quota {
  /** How much of a subscription's 5-hour and weekly limits is used, 0 to 100. */
  fiveHour?: number
  weekly?: number
  /** When those limits start over, in Unix seconds. */
  fiveHourResetAt?: number
  weeklyResetAt?: number
  /** The money left on an API key's account, in currency. */
  balance?: number
  currency?: string
}

const QUOTA_EVERY_MS = 2 * 60 * 1000

/** The balance with its currency, or '-' without one. */
export const balanceText = (q?: Quota) => (q?.balance === undefined ? '-' : `${q.balance.toFixed(2)} ${q.currency ?? ''}`.trim())

/** The two largest units of the time left, for a reset that is still ahead; a zero second unit is left out. */
function resetParts(now: number, at?: number): [number, 'd' | 'h' | 'm'][] {
  if (!at || at <= now) return []
  const minutes = Math.max(1, Math.ceil((at - now) / 60))
  const [d, h, m] = [Math.floor(minutes / 1440), Math.floor((minutes % 1440) / 60), minutes % 60]
  const parts: [number, 'd' | 'h' | 'm'][] = d ? [[d, 'd'], [h, 'h']] : h ? [[h, 'h'], [m, 'm']] : [[m, 'm']]
  return parts.filter(([v], i) => i === 0 || v > 0)
}

/** The time left before a limit starts over, short enough to fit under its ring: 42m, 3h12m, 4d6h; '' when unknown. */
export const resetText = (now: number, at?: number) => resetParts(now, at).map(([v, u]) => `${v}${u}`).join('')

const UNIT_WORDS = { d: '{a} 天', h: '{a} 小時', m: '{a} 分鐘' } as const

/** The same, in words for a screen reader. */
const resetWords = (now: number, at?: number) => resetParts(now, at).map(([a, u]) => tr(UNIT_WORDS[u], { a })).join(' ')

/** Asks the backend for every provider's allowance now and every few minutes, and again when providers change. */
function useQuotas(providers: Record<string, ModelProvider>) {
  const [quotas, setQuotas] = useState<Record<string, Quota>>({})
  const signature = Object.values(providers).map((p) => `${p.id}:${p.auth.kind}:${p.auth.kind === 'subscription' ? p.auth.signedIn : p.auth.keyHint}:${p.baseUrl}`).join('|')
  useEffect(() => {
    if (MOCK || !signature) return
    const ctrl = new AbortController()
    const load = () => request<Record<string, Quota>>('GET', '/quotas', undefined, ctrl.signal).then(setQuotas, () => {})
    load()
    const timer = setInterval(load, QUOTA_EVERY_MS)
    return () => { ctrl.abort(); clearInterval(timer) }
  }, [signature])
  return quotas
}

/**
 * A ring filled as far as the limit is used, with the share in the middle (grey with '-' when unknown), and
 * under it the time left before the limit starts over.
 */
export function UsageRing({ used, resetAt, now, label }: { used?: number; resetAt?: number; now: number; label: (text: string) => string }) {
  const r = 12
  const length = 2 * Math.PI * r
  const known = used !== undefined
  const text = known ? `${Math.round(used)}%` : '-'
  const left = resetWords(now, resetAt)
  const spoken = label(known ? text : tr('無資料'))
  return (
    <span className="fx-usage" role="img" aria-label={left ? tr('{a}，{b}後重置', { a: spoken, b: left }) : spoken}>
      <span className="fx-ring" aria-hidden="true">
        <svg viewBox="0 0 30 30">
          <circle className="fx-ring-track" cx="15" cy="15" r={r} />
          {known && used > 0 && (
            <circle className="fx-ring-fill" cx="15" cy="15" r={r} strokeDasharray={`${(length * Math.min(used, 100)) / 100} ${length}`} />
          )}
        </svg>
        <span>{text}</span>
      </span>
      <small aria-hidden="true">{resetText(now, resetAt)}</small>
    </span>
  )
}

/** Every provider's allowance, one row each; now is in Unix seconds. */
export function QuotaList({ providers, quotas, now }: { providers: ModelProvider[]; quotas: Record<string, Quota>; now: number }) {
  if (!providers.length) return null
  return (
    <ul className="fx-quotas" aria-label={tr('模型額度')}>
      {providers.map((p) => {
        const q = quotas[p.id]
        return (
          <li key={p.id}>
            <span className="fx-quota-name">{p.name}</span>
            {p.auth.kind === 'subscription' ? (
              <>
                <UsageRing used={q?.fiveHour} resetAt={q?.fiveHourResetAt} now={now} label={(a) => tr('5 小時用量 {a}', { a })} />
                <UsageRing used={q?.weekly} resetAt={q?.weeklyResetAt} now={now} label={(a) => tr('每週用量 {a}', { a })} />
              </>
            ) : (
              <span className="fx-quota-balance">{balanceText(q)}</span>
            )}
          </li>
        )
      })}
    </ul>
  )
}

export function Brand() {
  const locale = useStore((s) => s.world.language)
  const providers = useStore((s) => s.world.providers)
  const quotas = useQuotas(providers)
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(timer)
  }, [])
  const { time, date } = clockText(now, locale)
  return (
    <div className="fx-brand fx-tag">
      <h1>Team Work</h1>
      <p><time dateTime={now.toISOString()}>{time}　{date}</time></p>
      <QuotaList providers={Object.values(providers)} quotas={quotas} now={Math.floor(now.getTime() / 1000)} />
    </div>
  )
}
