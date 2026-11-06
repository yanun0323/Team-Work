// The time and date, in the corner of the main screen, with the version under them (in the Mac app a button that
// checks for an update) and, beside the time, a spinner while it checks and a button once it has found one; below them what is left of each model provider's allowance.

import { useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { useStore } from './core/store'
import { request } from './core/backend'
import { MOCK } from './core/mode'
import { LOCALE_TAGS, tr } from './core/i18n'
import type { Locale, ModelProvider } from './core/domain/types'
import { CAN_CHECK, checkForUpdate, checkNow, useUpdateState, VERSION } from './update'

export function clockText(now: Date, locale: Locale) {
  const tag = LOCALE_TAGS[locale]
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

const QUOTA_EVERY_MS = 30 * 1000

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

/** The last allowances heard, by provider id; kept while the corner is hidden so it comes back with them. */
const useQuotas = create<{ quotas: Record<string, Quota> }>(() => ({ quotas: {} }))

/**
 * Asks the backend for every provider's allowance now and every few minutes, and again when providers change. Call it
 * from something that stays on screen, not from the corner that hides behind panels.
 */
export function useQuotaPolling() {
  const providers = useStore((s) => s.world.providers)
  const signature = Object.values(providers).map((p) => `${p.id}:${p.auth.kind}:${p.auth.kind === 'subscription' ? p.auth.signedIn : p.auth.keyHint}:${p.baseUrl}`).join('|')
  useEffect(() => {
    if (MOCK || !signature) return
    const ctrl = new AbortController()
    const load = () => request<Record<string, Quota>>('GET', '/quotas', undefined, ctrl.signal).then((quotas) => useQuotas.setState({ quotas }), () => {})
    load()
    const timer = setInterval(load, QUOTA_EVERY_MS)
    return () => { ctrl.abort(); clearInterval(timer) }
  }, [signature])
}

const calm = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
const TWEEN_MS = 900

/**
 * The value to show while it runs to its target: from 0 when it first becomes known, from what was shown when it
 * changes. A value known from the start is shown as it is, and so is every value when the user asks for less motion.
 */
function useTween(target?: number) {
  const [shown, setShown] = useState(target)
  const current = useRef(target)
  useEffect(() => {
    const from = current.current ?? 0
    if (target === undefined || calm || from === target) {
      current.current = target
      setShown(target)
      return
    }
    const start = performance.now()
    let frame = requestAnimationFrame(function step(t) {
      const p = Math.min((t - start) / TWEEN_MS, 1)
      current.current = from + (target - from) * (1 - (1 - p) ** 3)
      setShown(current.current)
      if (p < 1) frame = requestAnimationFrame(step)
    })
    return () => cancelAnimationFrame(frame)
  }, [target])
  return shown
}

/** The share of a limit still free, 0 to 100, from the share used; undefined when unknown. */
export const leftOf = (used?: number) => (used === undefined ? undefined : 100 - Math.min(Math.max(used, 0), 100))

/** How worrying a share left is: over 50 is fine, 20 to 50 is low, under 20 is running out. */
export const levelOf = (left: number) => (left > 50 ? 'ok' : left >= 20 ? 'low' : 'out')

/**
 * A ring filled as far as the limit is still free, coloured by levelOf where it ends, with the share in the middle (grey with '-' when unknown), and
 * under it the time left before the limit starts over.
 */
export function UsageRing({ left: target, resetAt, now, label }: { left?: number; resetAt?: number; now: number; label: (text: string) => string }) {
  const r = 12
  const length = 2 * Math.PI * r
  // the ring fills and the number counts up as the share comes in; the label says where they end
  const free = useTween(target)
  const known = free !== undefined
  // the ring shows the bare number; the % is read out
  const text = known ? `${Math.round(free)}` : '-'
  const left = resetWords(now, resetAt)
  const spoken = label(target !== undefined ? `${Math.round(target)}%` : tr('無資料'))
  return (
    <span className="fx-usage" role="img" aria-label={left ? tr('{a}，{b}後重置', { a: spoken, b: left }) : spoken}>
      <span className="fx-ring" aria-hidden="true">
        <svg viewBox="0 0 30 30">
          <circle className="fx-ring-track" cx="15" cy="15" r={r} />
          {known && free > 0 && (
            <circle className={`fx-ring-fill fx-ring-${levelOf(target ?? free)}`} cx="15" cy="15" r={r} strokeDasharray={`${(length * free) / 100} ${length}`} />
          )}
        </svg>
        <span key={known ? 'number' : 'dash'}>{text}</span>
      </span>
      <small aria-hidden="true">{resetText(now, resetAt)}</small>
    </span>
  )
}

/**
 * Every provider's allowance, one row each; now is in Unix seconds. A subscription always has its row; an API key only
 * once its balance is known. Rows go by name, and those with the same name in the order they were made: ids end in a
 * running number, compared as a number since mp-476 would come after mp-57 as text.
 */
export function QuotaList({ providers, quotas, now }: { providers: ModelProvider[]; quotas: Record<string, Quota>; now: number }) {
  const shown = providers
    .filter((p) => p.auth.kind === 'subscription' || quotas[p.id]?.balance !== undefined)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id, undefined, { numeric: true }))
  if (!shown.length) return null
  return (
    <ul className="fx-quotas" aria-label={tr('模型額度')}>
      {shown.map((p) => {
        const q = quotas[p.id]
        return (
          <li key={p.id}>
            <span className="fx-quota-name">{p.name}</span>
            {p.auth.kind === 'subscription' ? (
              <>
                <UsageRing left={leftOf(q?.fiveHour)} resetAt={q?.fiveHourResetAt} now={now} label={(a) => tr('5 小時剩餘 {a}', { a })} />
                <UsageRing left={leftOf(q?.weekly)} resetAt={q?.weeklyResetAt} now={now} label={(a) => tr('每週剩餘 {a}', { a })} />
              </>
            ) : (
              <Balance quota={q} />
            )}
          </li>
        )
      })}
    </ul>
  )
}

/** An API key's balance, counting up from 0 when it comes in. */
function Balance({ quota }: { quota?: Quota }) {
  const balance = useTween(quota?.balance)
  const known = balance !== undefined
  return (
    <span key={known ? 'number' : 'dash'} className={known ? 'fx-quota-balance' : 'fx-quota-balance fx-quota-none'}>
      {balanceText({ ...quota, balance })}
    </span>
  )
}

/** How long the spinner takes to fade in or out; fusion.css says the same. */
const SPINNER_FADE_MS = 300

export function Brand() {
  const locale = useStore((s) => s.world.language)
  const providers = useStore((s) => s.world.providers)
  const quotas = useQuotas((s) => s.quotas)
  const { found, checking } = useUpdateState()
  // the spinner stays a moment after the check ends, to fade out while the red ! comes in over it
  const [spinner, setSpinner] = useState(checking)
  useEffect(() => {
    if (checking) return setSpinner(true)
    const timer = setTimeout(() => setSpinner(false), SPINNER_FADE_MS)
    return () => clearTimeout(timer)
  }, [checking])
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(timer)
  }, [])
  const { time, date } = clockText(now, locale)
  return (
    <div className="fx-brand fx-tag">
      {/* the clock stands where a title would; the name is still there for a screen reader */}
      <h1 className="fx-sr">Team Work</h1>
      <div className="fx-brand-clock">
        <time dateTime={now.toISOString()}>
          <span className="fx-brand-time">{time}</span>
          <span className="fx-brand-date">{date}</span>
        </time>
        {checking ? (
          <span className="fx-brand-checking" role="status" aria-label={tr('正在檢查更新')} title={tr('正在檢查更新')} />
        ) : spinner && (
          <span className="fx-brand-checking leaving" aria-hidden="true" />
        )}
        {!checking && found && (
          <button type="button" className="fx-brand-update" onClick={checkForUpdate} aria-label={tr('有新版本')} title={tr('有新版本')}>
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path d="M8 3.5v5.5" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
              <circle cx="8" cy="12.4" r="1.25" fill="currentColor" />
            </svg>
          </button>
        )}
      </div>
      {CAN_CHECK ? (
        <button type="button" className="fx-brand-version" onClick={checkNow} aria-label={`${tr('檢查新版本')} ${VERSION}`}>
          <span>{VERSION}</span>
          <span aria-hidden="true">{tr('檢查新版本')}</span>
        </button>
      ) : (
        <small className="fx-brand-version">{VERSION}</small>
      )}
      <QuotaList providers={Object.values(providers)} quotas={quotas} now={Math.floor(now.getTime() / 1000)} />
    </div>
  )
}
