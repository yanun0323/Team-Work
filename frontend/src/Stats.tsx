// The airport's usage tab: what each provider's models consumed over a period.

import { useEffect, useState, type CSSProperties } from 'react'
import { request } from './core/backend'
import { MOCK } from './core/mode'
import { tr, type Key } from './core/i18n'
import { useStore } from './core/store'
import type { World } from './core/domain/types'
import { SHIRTS } from './crew'
import { shade } from './figureStyle'

export interface UsageTotals {
  calls: number
  input: number
  output: number
  cacheRead: number
  tokens: number
  costUsd: number
  unpriced: number
}
export interface UsageStats {
  since: number
  total: UsageTotals
  providers: Array<UsageTotals & { id: string; name: string; models: Array<UsageTotals & { model: string }> }>
  days: Array<UsageTotals & { date: string; parts: UsagePart[] }>
}
export interface UsagePart { providerId: string; model: string; tokens: number }

/** One model's share of the chart, keyed as in partKey. */
export const partKey = (providerId: string, model: string) => `${providerId}\u0000${model}`

/** The employees' shirt colours, the greys and cream left out, in an order that keeps neighbours apart. */
const TINTS = [SHIRTS[0], SHIRTS[1], SHIRTS[2], SHIRTS[4], SHIRTS[3], SHIRTS[7], SHIRTS[6], SHIRTS[9], SHIRTS[11], SHIRTS[10], SHIRTS[13]]

/**
 * Each row's colour: a provider is its shirt colour a shade darker and its models lighter mixes of it, so a model
 * reads as its provider's in the chart. Colours go round again once every one is used.
 */
export function usageColors(providers: UsageStats['providers']) {
  const out = new Map<string, string>()
  providers.forEach((p, i) => {
    const base = TINTS[i % TINTS.length]
    out.set(p.id, shade(base, 0.72))
    p.models.forEach((m, j) => {
      // the shirt itself first, then paler, round again past four
      out.set(partKey(p.id, m.model), `color-mix(in oklab, ${base} ${100 - (j % 4) * 18}%, #fff)`)
    })
  })
  return out
}

export const STATS_RANGES = ['30d', 'all'] as const
export type StatsRange = (typeof STATS_RANGES)[number]
const RANGE_LABELS: Record<StatsRange, Key> = { '30d': '過去 30 天', all: '所有歷史' }

/** Unix seconds at the start of the local day that begins the range: today and the days before it. */
export function rangeStart(range: StatsRange, now = new Date()): number {
  if (range === 'all') return 0
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30 + 1).getTime() / 1000
}

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })
export const fmtCount = (n: number) => (n < 10_000 ? n.toLocaleString('en-US') : compact.format(n))

/** The cost, or a dash when none of the calls had a price. */
export function fmtUsd(t: UsageTotals) {
  if (t.calls === 0 || t.unpriced === t.calls) return '—'
  if (t.costUsd > 0 && t.costUsd < 0.01) return '<$0.01'
  return `$${t.costUsd.toFixed(2)}`
}

/** How much of the input was read back from the cache. */
export const fmtCacheRate = (t: UsageTotals) => (t.input > 0 ? `${Math.round((t.cacheRead / t.input) * 100)}%` : '—')

/** More than this many days are drawn a week to a bar, so each stays wide enough to see. */
const DAILY_BARS = 60

export interface Bar { label: string; tokens: number; parts: Map<string, number> }

/** How finely the chart splits each bar: by provider, or by each provider's models. */
export const STATS_DEPTHS = ['provider', 'model'] as const
export type StatsDepth = (typeof STATS_DEPTHS)[number]
const DEPTH_LABELS: Record<StatsDepth, Key> = { provider: '供應商', model: '模型' }
const DEPTH_KEY = 'tw.statsDepth'
const savedDepth = (): StatsDepth => {
  try { return localStorage.getItem(DEPTH_KEY) === 'model' ? 'model' : 'provider' } catch { return 'provider' }
}

/** Bars keyed by provider id, or by partKey when split by model. */
export function bars(days: UsageStats['days'], depth: StatsDepth = 'model'): Bar[] {
  const step = days.length <= DAILY_BARS ? 1 : 7
  const out: Bar[] = []
  for (let i = 0; i < days.length; i += step) {
    const group = days.slice(i, i + step)
    const parts = new Map<string, number>()
    for (const d of group) {
      for (const p of d.parts ?? []) {
        const k = depth === 'model' ? partKey(p.providerId, p.model) : p.providerId
        parts.set(k, (parts.get(k) ?? 0) + p.tokens)
      }
    }
    const label = step === 1 ? group[0].date : `${group[0].date} – ${group[group.length - 1].date}`
    out.push({ label, tokens: group.reduce((a, d) => a + d.tokens, 0), parts })
  }
  return out
}

export function Stats() {
  const [range, setRange] = useState<StatsRange>('30d')
  const [depth, setDepth] = useState<StatsDepth>(savedDepth)
  const pickDepth = (d: StatsDepth) => {
    setDepth(d)
    try { localStorage.setItem(DEPTH_KEY, d) } catch { /* private mode */ }
  }
  const [stats, setStats] = useState<UsageStats | null>(null)
  const [error, setError] = useState('')
  const world = useStore((s) => s.world)
  useEffect(() => {
    const since = rangeStart(range)
    if (MOCK) {
      setStats(mockStats(world, range, since))
      return
    }
    const ctrl = new AbortController()
    const offset = -new Date().getTimezoneOffset()
    request<UsageStats>('GET', `/usage?since=${since}&offset=${offset}`, undefined, ctrl.signal).then(
      (s) => { setStats(s); setError('') },
      (e: Error) => { if (e.name !== 'AbortError') setError(e.message) },
    )
    return () => ctrl.abort()
    // the simulator's world changes all the time; its numbers only need to follow the range
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range])

  return (
    <div className="fx-stats">
      <div className="fx-stats-tools">
        <Switcher name="fx-stats-range" label={tr('統計區間')} options={STATS_RANGES} labels={RANGE_LABELS} value={range} onChange={setRange} />
        <Switcher name="fx-stats-depth" label={tr('圖表分色')} options={STATS_DEPTHS} labels={DEPTH_LABELS} value={depth} onChange={pickDepth} />
      </div>
      {error ? <p className="fx-empty" role="alert">{error}</p>
        : stats && (stats.total.calls === 0 ? <p className="fx-empty">{tr('這段期間沒有用量')}</p> : <UsageReport stats={stats} depth={depth} />)}
    </div>
  )
}

function Switcher<T extends string>({ name, label, options, labels, value, onChange }: {
  name: string; label: string; options: readonly T[]; labels: Record<T, Key>; value: T; onChange: (v: T) => void
}) {
  return (
    <div className="fx-switcher" role="radiogroup" aria-label={label}
      style={{ '--count': options.length, '--at': options.indexOf(value) } as CSSProperties}>
      <span className="fx-switcher-thumb" aria-hidden="true" />
      {options.map((o) => (
        <label key={o} className="fx-switcher-option">
          <input type="radio" name={name} checked={o === value} onChange={() => onChange(o)} />
          <span>{tr(labels[o])}</span>
        </label>
      ))}
    </div>
  )
}

export function UsageReport({ stats, depth = 'provider' }: { stats: UsageStats; depth?: StatsDepth }) {
  const { total } = stats
  const colors = usageColors(stats.providers)
  return (
    <>
      <dl className="fx-stats-sum">
        <div><dt>Token</dt><dd>{fmtCount(total.tokens)}</dd></div>
        <div><dt>{tr('費用')}</dt><dd>{fmtUsd(total)}</dd></div>
        <div><dt>{tr('快取命中率')}</dt><dd>{fmtCacheRate(total)}</dd></div>
      </dl>
      <DailyChart days={stats.days} providers={stats.providers} colors={colors} depth={depth} />
      <table className="fx-stats-table">
        <thead>
          <tr><th scope="col">{tr('供應商與模型')}</th><th scope="col">Token</th><th scope="col">{tr('快取命中率')}</th><th scope="col">{tr('費用')}</th></tr>
        </thead>
        {stats.providers.map((p) => (
          <tbody key={p.id}>
            <tr className="fx-stats-provider">
              <th scope="row"><Swatch color={colors.get(p.id)} />{p.name}</th><td>{fmtCount(p.tokens)}</td><td>{fmtCacheRate(p)}</td><td>{fmtUsd(p)}</td>
            </tr>
            {p.models.map((m) => (
              <tr key={m.model}>
                <th scope="row"><Swatch color={colors.get(partKey(p.id, m.model))} />{m.model}</th><td>{fmtCount(m.tokens)}</td><td>{fmtCacheRate(m)}</td><td>{fmtUsd(m)}</td>
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </>
  )
}

/** A small square of tinted paper that keys a row to its colour in the chart. */
const Swatch = ({ color }: { color?: string }) => (
  <span className="fx-stats-swatch" aria-hidden="true" style={{ '--swatch': color } as CSSProperties} />
)

function DailyChart({ days, providers, colors, depth }: {
  days: UsageStats['days']; providers: UsageStats['providers']; colors: Map<string, string>; depth: StatsDepth
}) {
  const list = bars(days, depth)
  // stacked in the table's order, its first row at the bottom
  const order = depth === 'model' ? providers.flatMap((p) => p.models.map((m) => partKey(p.id, m.model))) : providers.map((p) => p.id)
  const names = new Map<string, { provider: string; model?: string }>(depth === 'model'
    ? providers.flatMap((p) => p.models.map((m) => [partKey(p.id, m.model), { provider: p.name, model: m.model }] as const))
    : providers.map((p) => [p.id, { provider: p.name }] as const))
  const [shown, setShown] = useState<{ bar: number; key: string } | null>(null)
  if (list.length === 0) return null
  const peak = Math.max(...list.map((b) => b.tokens))
  const top = list.find((b) => b.tokens === peak)!
  return (
    <figure className="fx-stats-chart">
      <div className="fx-stats-bars" role="img" aria-label={tr('每日 Token，最多是 {label} 的 {tokens}', { label: top.label, tokens: fmtCount(peak) })}
        onPointerLeave={() => setShown(null)}>
        {list.map((b, i) => (
          <span key={b.label} className="fx-stats-bar" style={{ '--h': peak > 0 ? b.tokens / peak : 0 } as CSSProperties}>
            {order.map((k) => {
              const tokens = b.parts.get(k) ?? 0
              return tokens > 0 && (
                <span key={k} style={{ flexGrow: tokens, background: colors.get(k) }}
                  data-shown={shown?.bar === i && shown.key === k ? '' : undefined}
                  onPointerEnter={() => setShown({ bar: i, key: k })} />
              )
            })}
          </span>
        ))}
      </div>
      {shown && list[shown.bar] && (
        // in the corner away from the bar, so it never covers what it describes
        <div className={shown.bar < list.length / 2 ? 'fx-stats-note fx-stats-note-right' : 'fx-stats-note'} aria-hidden="true">
          <b><Swatch color={colors.get(shown.key)} />{names.get(shown.key)?.provider}</b>
          {names.get(shown.key)?.model && <span>{names.get(shown.key)?.model}</span>}
          <span>{list[shown.bar].label} · {fmtCount(list[shown.bar].parts.get(shown.key) ?? 0)} Token</span>
        </div>
      )}
      <figcaption aria-hidden="true"><span>{list[0].label.split(' – ')[0]}</span><span>{list[list.length - 1].label.split(' – ').pop()}</span></figcaption>
    </figure>
  )
}

/** Made-up numbers for the simulator, steady for each provider and range. */
function mockStats(w: World, range: StatsRange, since: number): UsageStats {
  const empty = (): UsageTotals => ({ calls: 0, input: 0, output: 0, cacheRead: 0, tokens: 0, costUsd: 0, unpriced: 0 })
  const add = (t: UsageTotals, u: UsageTotals) => {
    for (const k of Object.keys(u) as Array<keyof UsageTotals>) t[k] += u[k]
  }
  const n = range === '30d' ? 30 : 120
  const today = new Date()
  const days = Array.from({ length: n }, (_, i) => {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - n + 1 + i)
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    return { date, ...empty(), parts: [] as UsagePart[] }
  })
  const total = empty()
  const providers = Object.values(w.providers).map((p, pi) => {
    const sum = empty()
    const models = p.models.slice(0, 3).map((model, mi) => {
      const m = empty()
      days.forEach((day, di) => {
        const input = Math.round((40_000 + ((di * 7919 + pi * 104_729 + mi * 1299) % 90_000)) / (mi + 1))
        const cacheRead = Math.round(input * 0.6)
        const output = Math.round(input * 0.08)
        const subscription = p.auth.kind === 'subscription'
        const u = { calls: 12, input, output, cacheRead, tokens: input - cacheRead + output,
          costUsd: subscription ? 0 : ((input - cacheRead) * 3 + output * 15 + cacheRead * 0.3) / 1e6, unpriced: subscription ? 12 : 0 }
        add(m, u)
        add(day, u)
        day.parts.push({ providerId: p.id, model, tokens: u.tokens })
      })
      add(sum, m)
      return { model, ...m }
    })
    add(total, sum)
    return { id: p.id, name: p.name, ...sum, models }
  })
  return { since, total, providers, days }
}
