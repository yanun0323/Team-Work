// The settings: a drawer over the right half of the map, like a company file, but for the whole app.
// Its head names it the airport, the island's management centre; the tabs below hold the model providers, the employee blueprints
// the app-wide preferences and the about page. Providers and blueprints, and adding one, open on the same stack of detail sheets over the upper left. There is no
// close button: a click on the map puts everything away.

import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useStore } from './core/store'
import { version } from '../package.json'
import { BlueprintIcon } from './BlueprintIcon'
import { SheetStack, useSheets } from './Drawer'
import { gitSources } from './core/domain/sim'
import { flowList } from './core/model'
import { itemKey, type Item } from './DrawerDetail'
import { FlowNotes, openCard } from './FlowNotes'
import { sourceState, sourceText } from './source'
import { SOCIAL_ICONS } from './socialIcons'
import { authLabel, PROVIDER_KINDS } from './providers'
import { Select, Toggle } from './Controls'
import { TABS as COMPANY_TABS, tabOr, type Tab as CompanyTab } from './DrawerTabs'
import { usePrefs, type LogOrder, type Prefs } from './prefs'
import { request } from './core/backend'
import { MOCK } from './core/mode'

// TODO: the real addresses; these are placeholders until they are given
const LINKS = [
  { label: 'GitHub', href: 'https://github.com/' },
  { label: 'Discord', href: 'https://discord.com/' },
  { label: 'X', href: 'https://x.com/' },
  { label: 'Threads', href: 'https://www.threads.net/' },
  { label: 'Buy Me a Coffee', href: 'https://www.buymeacoffee.com/' },
]
const THANKS = [{ name: 'yanun0323', href: 'https://github.com/yanun0323' }]

const TABS = [
  { id: 'providers', label: '模型供應商' },
  { id: 'blueprints', label: '員工藍圖' },
  { id: 'flows', label: '任務流程' },
  { id: 'prefs', label: '設定' },
  { id: 'about', label: '關於' },
] as const
type Tab = (typeof TABS)[number]['id']

/**
 * Ends the app. With work under way it would stop that work, so it asks first, like deleting. The app listens for
 * the message; a page in a browser has no such listener and never shows this.
 */
export function QuitTool() {
  const busy = useStore((s) => Object.values(s.world.subTasks).some((x) => x.status === 'progressing' && !x.cancelled)
    || Object.values(s.world.tasks).some((t) => t.stage === 'merging')
    || Object.values(s.world.chats).some((c) => c.replyAt !== undefined))
  const [asking, setAsking] = useState(false)
  const quit = () => (window as unknown as { webkit: { messageHandlers: { quit: { postMessage: (x: null) => void } } } }).webkit.messageHandlers.quit.postMessage(null)
  return (
    <button type="button" className={asking ? 'fx-tool fx-tool-ask fx-hit' : 'fx-tool fx-hit'}
      onClick={() => (busy && !asking ? setAsking(true) : quit())} onBlur={() => setAsking(false)}
      aria-label={asking ? '還有工作在進行，確定退出' : '退出'} title={asking ? undefined : '退出'}>
      {asking ? '工作會中斷，確定退出' : (
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <path d="M8 2v6M4.6 4.2a5 5 0 1 0 6.8 0" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      )}
    </button>
  )
}

export function Settings({ leaving, onGone }: {
  leaving: boolean
  /** Called when the page has turned away. */
  onGone: () => void
}) {
  const [tab, setTab] = useState<Tab>('providers')
  const title = useRef<HTMLHeadingElement>(null)
  const tabs = useRef<Array<HTMLButtonElement | null>>([])
  const sheets = useSheets()
  const { back } = sheets
  useEffect(() => title.current?.focus({ preventScroll: true }), [])
  const base = sheets.layers[0]
  const open = base && !base.leaving ? itemKey(base.item) : null

  // the sheet belongs to the tab it was opened from
  const pick = (next: Tab) => {
    if (next !== tab) back(-1, false)
    setTab(next)
  }
  // arrow keys move between tabs, as in any tab list
  const onTabKey = (e: KeyboardEvent) => {
    const i = TABS.findIndex((x) => x.id === tab)
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: TABS.length - 1 }[e.key]
    if (next === undefined) return
    e.preventDefault()
    const j = (next + TABS.length) % TABS.length
    pick(TABS[j].id)
    tabs.current[j]?.focus()
  }

  return (
    <>
    <aside id="fx-settings" className={leaving ? 'fx-drawer leaving' : 'fx-drawer'} aria-labelledby="fx-settings-title"
      aria-hidden={leaving || undefined} inert={leaving || undefined}
      onAnimationEnd={(e) => { if (leaving && e.target === e.currentTarget) onGone() }}>
      <span className="fx-tape fx-tape-l" aria-hidden="true" />
      <span className="fx-tape fx-tape-r" aria-hidden="true" />
      <div className="fx-sheet">
        <header className="fx-head">
          <div className="fx-title fx-title-plain">
            <div className="fx-title-text">
              <h1 id="fx-settings-title" ref={title} tabIndex={-1}>機場</h1>
              <p className="fx-where">小島管理中心</p>
            </div>
            {import.meta.env.MODE === 'desktop' && <QuitTool />}
          </div>
          <div className="fx-tabs" role="tablist" aria-label="設定" onKeyDown={onTabKey}>
            {TABS.map((x, i) => (
              <button key={x.id} ref={(el) => void (tabs.current[i] = el)} type="button" role="tab"
                id={`fx-settings-tab-${x.id}`} aria-controls="fx-settings-panel" aria-selected={tab === x.id}
                tabIndex={tab === x.id ? 0 : -1} onClick={() => pick(x.id)}>
                {x.label}
              </button>
            ))}
          </div>
        </header>
        {/* keyed, so each tab turns in like a fresh page */}
        <section key={tab} id="fx-settings-panel" className="fx-page" role="tabpanel" aria-labelledby={`fx-settings-tab-${tab}`}>
          {tab === 'providers' && <Providers open={open} onOpen={sheets.open} />}
          {tab === 'blueprints' && <Blueprints open={open} onOpen={sheets.open} />}
          {tab === 'flows' && <Flows open={open} onOpen={sheets.open} />}
          {tab === 'prefs' && <PrefsPage />}
          {tab === 'about' && <About />}
        </section>
      </div>
    </aside>
    <SheetStack sheets={sheets} teamId="" leaving={leaving} />
    </>
  )
}

function Providers({ open, onOpen }: { open: string | null; onOpen: (x: Item) => void }) {
  const w = useStore((s) => s.world)
  const opener = (x: Item) => ({ type: 'button' as const, 'aria-expanded': open === itemKey(x), 'aria-controls': 'fx-detail', onClick: () => onOpen(x) })
  return (
    <div className="fx-d-groups">
      <button className="fx-task fx-task-new fx-flow-new fx-hit" {...opener({ kind: 'newProvider' })}>＋ 新增模型供應商</button>
      <ul className="fx-list">
        {Object.values(w.providers).map((p) => (
          <li key={p.id}><button className="fx-row fx-hit" {...opener({ kind: 'provider', id: p.id })}>
            <span className="fx-row-main">
              <b>{p.name}</b>
              <span>{PROVIDER_KINDS[p.kind].label} · {authLabel(p)} · {p.models.length} 個模型</span>
            </span>
          </button></li>
        ))}
      </ul>
    </div>
  )
}

function Blueprints({ open, onOpen }: { open: string | null; onOpen: (x: Item) => void }) {
  const w = useStore((s) => s.world)
  const opener = (x: Item) => ({ type: 'button' as const, 'aria-expanded': open === itemKey(x), 'aria-controls': 'fx-detail', onClick: () => onOpen(x) })
  return (
    <div className="fx-d-groups">
      <button className="fx-task fx-task-new fx-flow-new fx-hit" {...opener({ kind: 'newBlueprint' })}>＋ 新增員工藍圖</button>
      <ul className="fx-list">
        {Object.values(w.blueprints).map((bp) => {
          // a repo that can't be found or failed to update is flagged on the list too
          const trouble = gitSources(bp).filter((s) => sourceState(s, w.now).tone === 'bad').length
          return (
            <li key={bp.id}><button className="fx-row fx-hit" {...opener({ kind: 'blueprint', id: bp.id })}>
              <span aria-hidden="true"><BlueprintIcon look={bp.look} name={bp.name} size={34} /></span>
              <span className="fx-row-main">
                <b>{bp.name}</b>
                <span>{sourceText(bp.source)}</span>
                {trouble > 0 && <span className="fx-src-note-bad">{trouble} 個來源有問題</span>}
              </span>
            </button></li>
          )
        })}
      </ul>
    </div>
  )
}

function Flows({ open, onOpen }: { open: string | null; onOpen: (x: Item) => void }) {
  const w = useStore((s) => s.world)
  const opener = (x: Item) => ({ type: 'button' as const, 'aria-expanded': open === itemKey(x), 'aria-controls': 'fx-detail', onClick: () => onOpen(x) })
  return (
    <div className="fx-flows">
      <button className="fx-task fx-task-new fx-flow-new fx-hit" {...opener({ kind: 'newFlow' })}>＋ 新增任務流程</button>
      {/* each flow opens as a whole; its title is the button, stretched over the flow */}
      {flowList(w).map((wf) => {
        return (
          <section key={wf.id} className="fx-flow fx-flow-card" onClick={openCard}>
            <h3>
              <button className="fx-flow-open" {...opener({ kind: 'flow', id: wf.id })}>{wf.name}</button>
            </h3>
            <FlowNotes wf={wf} />
          </section>
        )
      })}
    </div>
  )
}

const LOG_ORDERS: Record<LogOrder, string> = { newestFirst: '新的在最上面', newestLast: '新的在最下面' }

/** App-wide preferences; each change takes effect at once and is kept in the browser. */
export function ReloadSettings() {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const reload = async () => {
    setBusy(true)
    setMessage('')
    setError('')
    try {
      await request('POST', '/settings/reload')
      setMessage('設定已重新載入')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="fx-d-group" aria-labelledby="fx-settings-files">
      <h4 id="fx-settings-files">設定檔</h4>
      <button type="button" className="fx-save" disabled={busy} onClick={() => void reload()}>
        {busy ? '載入中…' : '重新載入設定'}
      </button>
      <p role="status">{message}</p>
      <p role="alert">{error}</p>
    </section>
  )
}

function PrefsPage() {
  const prefs = usePrefs()
  const check = (key: Exclude<keyof Prefs, 'logOrder' | 'defaultTab'>, label: string) => (
    <Toggle label={label} checked={prefs[key]} onChange={(v) => prefs.set({ [key]: v })} />
  )
  return (
    <div className="fx-d-groups">
      {!MOCK && <ReloadSettings />}
      <section className="fx-d-group" aria-labelledby="fx-prefs-use">
        <h4 id="fx-prefs-use">功能</h4>
        <div className="fx-fields">
          <Select label="任務紀錄排序" value={prefs.logOrder} options={Object.keys(LOG_ORDERS)} labelOf={(o) => LOG_ORDERS[o as LogOrder]}
            onChange={(v) => prefs.set({ logOrder: v as LogOrder })} />
          <Select label="預設頁籤" value={tabOr(prefs.defaultTab)} options={COMPANY_TABS.map((x) => x.id)}
            labelOf={(id) => COMPANY_TABS.find((x) => x.id === id)!.label} onChange={(v) => prefs.set({ defaultTab: v as CompanyTab })} />
          {!MOCK && <Toggle label="保留終端機" checked={prefs.keepTerminals} onChange={(v) => prefs.set({ keepTerminals: v })} />}
        </div>
      </section>
      <section className="fx-d-group" aria-labelledby="fx-prefs-perf">
        <h4 id="fx-prefs-perf">遊戲物件</h4>
        <div className="fx-fields">
          {check('detail', '細節')}
          {check('shadows', '陰影')}
          {check('crowd', '地圖民眾')}
          {check('planes', '飛機動畫')}
          {check('clouds', '雲朵')}
        </div>
      </section>
    </div>
  )
}

function About() {
  return (
    <div className="fx-d-groups">
      {/* each a sticky note stuck on the page */}
      <ul className="fx-links">
        {LINKS.map((x) => (
          <li key={x.label}><a className="fx-link" href={x.href} target="_blank" rel="noreferrer">
            <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path d={SOCIAL_ICONS[x.label]} fill="currentColor" /></svg>
            <span>{x.label}</span><span className="fx-sr">（另開分頁）</span>
          </a></li>
        ))}
      </ul>
      <section className="fx-d-group" aria-labelledby="fx-thanks">
        <h4 id="fx-thanks">感謝名單</h4>
        <ul className="fx-thanks">
          {THANKS.map((x) => <li key={x.name}><a href={x.href} target="_blank" rel="noreferrer">{x.name}<span className="fx-sr">（另開分頁）</span></a></li>)}
        </ul>
      </section>
      <section className="fx-d-group" aria-labelledby="fx-version">
        <h4 id="fx-version">版本</h4>
        <p><code>v{version}</code></p>
      </section>
    </div>
  )
}
