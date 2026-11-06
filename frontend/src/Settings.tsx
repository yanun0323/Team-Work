// The settings: a drawer over the right half of the map, like a company file, but for the whole app.
// Its head names it the airport, the island's management centre; the tabs below hold the model providers, the employee blueprints
// the app-wide preferences and the about page. Providers and blueprints, and adding one, open on the same stack of detail sheets over the upper left. There is no
// close button: a click on the map puts everything away.

import { LANGUAGE_NAMES, LANGUAGES } from './LanguageMenu'
import { tr } from './core/i18n'
import { lazy, Suspense, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useStore } from './core/store'
import LICENSE from '../../LICENSE?raw'
import { BlueprintIcon } from './BlueprintIcon'
import { openOnce, SheetStack, useMapClickSheets, useSheets } from './Drawer'
import { useOpenedFromNotice } from './notices'
import { gitSources } from './core/domain/sim'
import { blueprintList, flowList, waitingTab } from './core/model'
import { AIRPORT_BLUEPRINT, isLocked } from './core/data/presets'
import { byOrigin } from './Pickers'
import { HideTool, itemKey, type Item } from './DrawerDetail'
import { FlowNotes, openCard } from './FlowNotes'
import { keptState, sourceState, sourceText } from './source'
import { SOCIAL_ICONS } from './socialIcons'
import { authLabel, makesImages, PROVIDER_KINDS } from './providers'
import { Chevron, Select, Toggle, useAutoGrow } from './Controls'
import { hideBlueprint, hideWorkflow, setLanguage } from './core/ops'
import { Chats, TABS as COMPANY_TABS, tabOr, type Tab as CompanyTab } from './DrawerTabs'
import { airportTabOr, AIRPORT_TABS, AUTO_TABS, AUTO_VIEWS, BUSY_ANIMATIONS, DAYLIGHTS, DEFAULT_PREFS, IDLE_FOLLOW_TARGETS, type IdleFollowTarget, IDLE_FOLLOWS, MAP_CLICKS, type AirportTab, type AutoTab, type AutoView, type MapClick, type BusyAnimation, usePrefs, type LogOrder, type Prefs, ZOOM_SENSITIVITY, COMPACT_DEFAULTS, COMPACT_SHARE } from './prefs'
import { request } from './core/backend'
import { MusicSection, Volume } from './SoundPage'
import { MOCK } from './core/mode'
import { DEFAULT_EFFORT, effortsOf, modelGroups, modelsOf } from './crew'
import { takeAirportTab, tutorialOf, updateTutorial } from './tutorial'
import { composing } from './ime'
import { Stats } from './Stats'
import { SourcesTab } from './Sources'
import { VERSION } from './update'
import type { Daylight } from './daylight'
import type { Locale } from './core/domain/types'

const Terminal = lazy(() => import('./Terminal'))

const LINKS = [
  { label: 'GitHub', href: 'https://github.com/yanun0323/Team-Work' },
  { label: 'Buy Me a Coffee', href: 'https://buymeacoffee.com/yanun' },
]
// a new issue on GitHub, its body ending with the version so reports say which build they came from
const ISSUE_URL = `https://github.com/yanun0323/Team-Work/issues/new?body=${encodeURIComponent(`\n\n---\n${VERSION}`)}`


/**
 * Ends the app. It always asks first, like deleting, and says so when work under way would stop. The app listens
 * for the message; a page in a browser has no such listener and never shows this.
 */
export function QuitTool() {
  const busy = useStore((s) => Object.values(s.world.subTasks).some((x) => x.status === 'progressing' && !x.cancelled)
    || Object.values(s.world.tasks).some((t) => t.stage === 'merging')
    || Object.values(s.world.chats).some((c) => c.replyAt !== undefined))
  const [asking, setAsking] = useState(false)
  const quit = () => (window as unknown as { webkit: { messageHandlers: { quit: { postMessage: (x: null) => void } } } }).webkit.messageHandlers.quit.postMessage(null)
  return (
    <button type="button" className={asking ? 'fx-tool fx-tool-ask fx-hit' : 'fx-tool fx-hit'}
      onClick={() => (asking ? quit() : setAsking(true))} onBlur={() => setAsking(false)}
      aria-label={asking ? (busy ? tr('還有工作在進行，確定退出') : tr('確定退出')) : tr('退出')} title={asking ? undefined : tr('退出')}>
      {asking ? (busy ? tr('工作會中斷，確定退出') : tr('確定退出')) : (
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
  const [tab, setTab] = useState<AirportTab>(() => {
    const { autoTab, defaultAirportTab } = usePrefs.getState()
    const asked = takeAirportTab()
    if (asked) return asked
    // the airport has no tasks, so only its chats can be waiting
    return autoTab !== 'off' && waitingTab(useStore.getState().world, '') === 'chats' ? 'chats' : airportTabOr(defaultAirportTab)
  })
  // the shell at home starts the first time its tab shows, and then runs until the airport closes
  const [terminalOpened, setTerminalOpened] = useState(tab === 'terminal')
  const [terminalFocus, setTerminalFocus] = useState(0)
  const title = useRef<HTMLHeadingElement>(null)
  const tabs = useRef<Array<HTMLButtonElement | null>>([])
  const sheets = useSheets()
  useMapClickSheets(sheets, leaving)
  useEffect(() => {
    title.current?.focus({ preventScroll: true })
    if (tab === 'terminal') setTerminalFocus((n) => n + 1)
    // only on opening
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // the airport has only chats to open
  useOpenedFromNotice('', leaving, (x) => {
    setTab('chats')
    openOnce(sheets, x)
  })
  const base = sheets.layers[0]
  const open = base && !base.leaving ? itemKey(base.item) : null

  // the detail sheets stay open across tabs, until the airport closes
  const pick = (next: AirportTab) => {
    if (next === 'terminal') setTerminalOpened(true)
    setTab(next)
  }
  // arrow keys move between tabs, as in any tab list
  const onTabKey = (e: KeyboardEvent) => {
    const i = AIRPORT_TABS.findIndex((x) => x.id === tab)
    const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: AIRPORT_TABS.length - 1 }[e.key]
    if (next === undefined) return
    e.preventDefault()
    const j = (next + AIRPORT_TABS.length) % AIRPORT_TABS.length
    pick(AIRPORT_TABS[j].id)
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
              <h1 id="fx-settings-title" ref={title} tabIndex={-1}>{tr('機場')}</h1>
              <p className="fx-where">{tr('小島管理中心')}</p>
            </div>
            {import.meta.env.MODE === 'desktop' && <div className="fx-head-tools"><QuitTool /></div>}
          </div>
          <div className="fx-tabs" role="tablist" aria-label={tr('設定')} onKeyDown={onTabKey}>
            {AIRPORT_TABS.map((x, i) => (
              <button key={x.id} ref={(el) => void (tabs.current[i] = el)} type="button" role="tab"
                id={`fx-settings-tab-${x.id}`} aria-controls="fx-settings-panel" aria-selected={tab === x.id}
                tabIndex={tab === x.id ? 0 : -1} onClick={() => {
                  pick(x.id)
                  if (x.id === 'terminal') setTerminalFocus((n) => n + 1)
                }}>
                {tr(x.label)}
              </button>
            ))}
          </div>
        </header>
        {/* keyed, so each tab turns in like a fresh page; the terminal is kept apart, so it outlasts a change of tab */}
        {tab !== 'terminal' && (
        <section key={tab} id="fx-settings-panel" className="fx-page" role="tabpanel" aria-labelledby={`fx-settings-tab-${tab}`}>
          {tab === 'chats' && <Chats teamId="" open={open} onOpen={sheets.open} />}
          {tab === 'providers' && <Providers open={open} onOpen={sheets.open} />}
          {tab === 'blueprints' && <Blueprints open={open} onOpen={sheets.open} />}
          {tab === 'sources' && <SourcesTab open={open} onOpen={sheets.open} />}
          {tab === 'flows' && <Flows open={open} onOpen={sheets.open} />}
          {tab === 'prefs' && <PrefsPage />}
          {tab === 'stats' && <Stats />}
          {tab === 'about' && <About />}
        </section>
        )}
        {terminalOpened && (
          <section id={tab === 'terminal' ? 'fx-settings-panel' : undefined} className="fx-page fx-page-terminal" role="tabpanel"
            aria-labelledby="fx-settings-tab-terminal" hidden={tab !== 'terminal'}>
            <Suspense fallback={null}>
              <Terminal teamId="" focusRequest={terminalFocus}
                onLeave={() => tabs.current[AIRPORT_TABS.findIndex((x) => x.id === 'terminal')]?.focus()} />
            </Suspense>
          </section>
        )}
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
      <button className="fx-task fx-task-new fx-flow-new fx-hit" {...opener({ kind: 'newProvider' })}>{tr('＋ 新增模型供應商')}</button>
      <ul className="fx-list">
        {Object.values(w.providers).map((p) => (
          <li key={p.id}><button className="fx-row fx-hit" {...opener({ kind: 'provider', id: p.id })}>
            <span className="fx-row-main">
              <b>{p.name}</b>
              <span>{tr('{label} · {a} · {length} 個模型', { label: PROVIDER_KINDS[p.kind].label, a: authLabel(p), length: p.models.length })}</span>
            </span>
          </button></li>
        ))}
      </ul>
    </div>
  )
}

/** Which groups were opened or closed by hand, kept on this computer under `key`; the rest follow the default. */
function useFolds(key: string | undefined) {
  const [folds, setFolds] = useState<Record<string, boolean>>(() => {
    if (!key) return {}
    try {
      const v: unknown = JSON.parse(localStorage.getItem(key) ?? '{}')
      return v && typeof v === 'object' ? (v as Record<string, boolean>) : {}
    } catch { return {} } // private mode, or not JSON
  })
  const set = (group: string, open: boolean) => {
    const next = { ...folds, [group]: open }
    setFolds(next)
    if (key) try { localStorage.setItem(key, JSON.stringify(next)) } catch { /* private mode */ }
  }
  return [folds, set] as const
}

/**
 * The items under where they come from: 我的, each source by its name, then 內建, each heading only when it has some.
 * With `fold`, each heading opens and closes its group, and how they were left is kept under that key; the first group
 * starts open and the rest closed, so a long list of others' blueprints does not bury your own. A closed group says how
 * many it holds.
 */
function ByOrigin<T extends { id: string }>({ items, render, fold }: { items: T[]; render: (list: T[]) => React.ReactNode; fold?: string }) {
  const sources = useStore((s) => s.world.sources)
  const { groups, groupOf } = byOrigin(items.map((x) => x.id), sources)
  const [folds, setFold] = useFolds(fold)
  return (
    <>
      {groups.map((g, at) => {
        const list = render(items.filter((x) => groupOf(x.id) === at))
        if (!fold) return <section key={g.key} className="fx-d-group fx-owned"><h4>{g.label}</h4>{list}</section>
        const shown = folds[g.key] ?? at === 0
        const body = `fx-origin-${fold}-${at}`
        return (
          <section key={g.key} className="fx-d-group fx-owned">
            <h4>
              <button type="button" className="fx-fold" aria-expanded={shown} aria-controls={body} onClick={() => setFold(g.key, !shown)}>
                <Chevron />
                <span className="fx-fold-name">{g.label}</span>
                {!shown && <span className="fx-fold-count">{g.count}</span>}
              </button>
            </h4>
            <div id={body} className="fx-fold-body" hidden={!shown}>{shown && list}</div>
          </section>
        )
      })}
    </>
  )
}

function Blueprints({ open, onOpen }: { open: string | null; onOpen: (x: Item) => void }) {
  const w = useStore((s) => s.world)
  const act = useStore((s) => s.act)
  const hidden = usePrefs((s) => s.hiddenBlueprints)
  const opener = (x: Item) => ({ type: 'button' as const, 'aria-expanded': open === itemKey(x), 'aria-controls': 'fx-detail', onClick: () => onOpen(x) })
  return (
    <div className="fx-d-groups">
      <button className="fx-task fx-task-new fx-flow-new fx-hit" {...opener({ kind: 'newBlueprint' })}>{tr('＋ 新增員工藍圖')}</button>
      <ByOrigin items={blueprintList(w)} render={(list) => (
        <ul className="fx-list">
          {list.map((bp) => {
            // a repo that can't be found or failed to update is flagged on the list too
            const kept = bp.skills.flatMap((p) => (p.sourceId && w.sources[p.sourceId] ? [w.sources[p.sourceId]] : []))
            const trouble = gitSources(bp).filter((s) => sourceState(s, w.now).tone === 'bad').length
              + [...new Set(kept)].filter((s) => keptState(s, w.now)?.tone === 'bad').length
            return (
              // the airport staff's is never hired from, so it always looks hidden
              <li key={bp.id} className={hidden.includes(bp.id) || bp.id === AIRPORT_BLUEPRINT ? 'fx-hidable fx-hidden-item' : 'fx-hidable'}>
                <button className="fx-row fx-hit" {...opener({ kind: 'blueprint', id: bp.id })}>
                  <span aria-hidden="true"><BlueprintIcon look={bp.look} name={bp.name} size={34} /></span>
                  <span className="fx-row-main">
                    <b>{bp.name}</b>
                    {!isLocked(bp.id) && <span>{sourceText(bp.source)}</span>}
                    {trouble > 0 && <span className="fx-src-note-bad">{tr('{trouble} 個來源有問題', { trouble })}</span>}
                  </span>
                </button>
                {bp.id !== AIRPORT_BLUEPRINT && (
                  <HideTool className="fx-hide-on-hover" hidden={hidden.includes(bp.id)} onChange={(on) => act((x) => hideBlueprint(x, bp.id, on))} />
                )}
              </li>
            )
          })}
        </ul>
      )} />
    </div>
  )
}

function Flows({ open, onOpen }: { open: string | null; onOpen: (x: Item) => void }) {
  const w = useStore((s) => s.world)
  const act = useStore((s) => s.act)
  const hidden = usePrefs((s) => s.hiddenWorkflows)
  const opener = (x: Item) => ({ type: 'button' as const, 'aria-expanded': open === itemKey(x), 'aria-controls': 'fx-detail', onClick: () => onOpen(x) })
  return (
    <div className="fx-flows">
      <button className="fx-task fx-task-new fx-flow-new fx-hit" {...opener({ kind: 'newFlow' })}>{tr('＋ 新增任務藍圖')}</button>
      {/* each flow opens as a whole; its title is the button, stretched over the flow */}
      <ByOrigin items={flowList(w)} fold="fx-flow-groups" render={(list) => list.map((wf) => (
        <section key={wf.id} className={`fx-flow fx-flow-card fx-blueprint fx-hidable${hidden.includes(wf.id) ? ' fx-hidden-item' : ''}`} onClick={openCard}>
          <h3>
            <button className="fx-flow-open" {...opener({ kind: 'flow', id: wf.id })}>{wf.name}</button>
          </h3>
          <FlowNotes wf={wf} />
          <HideTool className="fx-hide-on-hover" hidden={hidden.includes(wf.id)} onChange={(on) => act((x) => hideWorkflow(x, wf.id, on))} />
        </section>
      ))} />
    </div>
  )
}

const LOG_ORDERS = { newestFirst: '新的在最上面', newestLast: '新的在最下面' } as const

/** App-wide preferences; changes are persisted and broadcast by the backend. */
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
      setMessage(tr('設定已重新載入'))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const openFolder = async () => {
    setMessage('')
    setError('')
    try {
      await request('POST', '/settings/open-folder')
    } catch (e) {
      setError((e as Error).message)
    }
  }
  return (
    <section className="fx-d-group" aria-labelledby="fx-settings-files">
      <h4 id="fx-settings-files">{tr('設定檔')}</h4>
      <div className="fx-settings-file-acts">
        <button type="button" className="fx-save" disabled={busy} onClick={() => void reload()}>
          {busy ? tr('載入中…') : tr('重新載入設定')}
        </button>
        <button type="button" className="fx-save" onClick={() => void openFolder()}>{tr('開啟設定檔資料夾')}</button>
      </div>
      <p role="status">{message}</p>
      <p role="alert">{error}</p>
    </section>
  )
}

/** The AGENTS.md every employee gets. It is a file that can change outside the app, so it is reread on coming back. */
export function SystemSection() {
  const titleModel = usePrefs((s) => s.chatTitleModel)
  const titleEffort = usePrefs((s) => s.chatTitleEffort)
  const codexSkills = usePrefs((s) => s.codexSkills)
  const claudeSkills = usePrefs((s) => s.claudeSkills)
  const setPrefs = usePrefs((s) => s.set)
  const [saved, setSaved] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  // typing not saved yet outranks what the file says
  const typing = useRef(false)
  useEffect(() => {
    let live = true
    const load = async () => {
      try {
        const { prompt } = await request<{ prompt: string }>('GET', '/settings/global-prompt')
        if (!live || typing.current) return
        setSaved(prompt)
        setDraft(prompt)
        setError('')
      } catch (e) {
        if (live) setError((e as Error).message)
      }
    }
    void load()
    window.addEventListener('focus', load)
    return () => {
      live = false
      window.removeEventListener('focus', load)
    }
  }, [])
  const box = useRef<HTMLTextAreaElement>(null)
  useAutoGrow(box, draft)
  const save = async () => {
    if (draft === saved) {
      typing.current = false
      return
    }
    try {
      await request('PUT', '/settings/global-prompt', { prompt: draft })
      typing.current = false
      setSaved(draft)
      setError('')
    } catch (e) {
      setError((e as Error).message)
    }
  }
  return (
    <section className="fx-d-group" aria-labelledby="fx-prefs-system">
      <h4 id="fx-prefs-system">{tr('系統')}</h4>
      <div className="fx-fields">
        <ChatTitleFields model={titleModel} effort={titleEffort} onChange={setPrefs} />
        <ImageProviderField />
        <Toggle label={tr('使用 Codex Skill')} checked={codexSkills} onChange={(v) => setPrefs({ codexSkills: v })} />
        <Toggle label={tr('使用 Claude Skill')} checked={claudeSkills} onChange={(v) => setPrefs({ claudeSkills: v })} />
        <label className="fx-field fx-field-top">
          <span>{tr('全域員工規則')}</span>
          <textarea ref={box} className="fx-control fx-prefs-prompt" rows={6} value={draft} disabled={saved === null} spellCheck={false}
            onChange={(e) => { typing.current = true; setDraft(e.target.value) }} onBlur={() => void save()} />
        </label>
      </div>
      <p role="alert">{error}</p>
    </section>
  )
}

/** Naming new chats from their first message: off, or the model and level that do it. */
export function ChatTitleFields({ model, effort, onChange: set }: { model: string; effort: string; onChange: (p: Partial<Prefs>) => void }) {
  const w = useStore((s) => s.world)
  const models = modelsOf(w)
  const levels = effortsOf(w, model)
  return (
    <>
      <Toggle label={tr('自動命名對話')} checked={!!model}
        onChange={(on) => set(on ? { chatTitleModel: models[0] ?? '', chatTitleEffort: DEFAULT_EFFORT } : { chatTitleModel: '', chatTitleEffort: '' })} />
      {model && (
        <>
          <Select label={tr('模型')} value={model} options={models.includes(model) ? models : [...models, model]}
            groups={modelGroups(w).map((g) => ({ label: g.label, count: g.models.length }))}
            groupOf={(m) => modelGroups(w).findIndex((g) => g.models.includes(m))}
            onChange={(m) => set({ chatTitleModel: m, chatTitleEffort: effortsOf(w, m).includes(effort) ? effort : DEFAULT_EFFORT })} />
          <Select label={tr('思考等級')} value={levels.includes(effort) ? effort : DEFAULT_EFFORT} options={levels}
            onChange={(e) => set({ chatTitleEffort: e })} />
        </>
      )}
    </>
  )
}

/** The ChatGPT subscription every employee draws pictures with, or none. */
export function ImageProviderField() {
  const providers = useStore((s) => s.world.providers)
  const value = usePrefs((s) => s.imageProvider)
  const set = usePrefs((s) => s.set)
  const ids = Object.values(providers).filter(makesImages).map((p) => p.id)
  return (
    <Select label={tr('圖片生成')} value={ids.includes(value) ? value : ''} options={['', ...ids]}
      labelOf={(id) => (id ? providers[id].name : tr('沒有'))} onChange={(imageProvider) => set({ imageProvider })} />
  )
}

const COMPACT_GROUPS = [['compact1M', '1M+'], ['compact256K', '256K+'], ['compact128K', '128K+'], ['compactSmall', '< 128K']] as const

/** How full a chat may get, by the size of its model, before it is summed up. 20K tokens always stay free besides. */
export function CompactSection() {
  const prefs = usePrefs()
  const changed = COMPACT_GROUPS.some(([key]) => prefs[key] !== COMPACT_DEFAULTS[key])
  return (
    <section className="fx-d-group" aria-labelledby="fx-prefs-compact">
      <h4 id="fx-prefs-compact">{tr('自動整理對話')}</h4>
      <div className="fx-fields">
        {COMPACT_GROUPS.map(([key, label]) => (
          <Volume key={key} label={label} value={prefs[key]} {...COMPACT_SHARE} onChange={(v) => prefs.set({ [key]: v })} />
        ))}
      </div>
      {changed && (
        <div className="fx-settings-file-acts">
          <button type="button" className="fx-save" onClick={() => prefs.set(COMPACT_DEFAULTS)}>{tr('恢復預設')}</button>
        </div>
      )}
    </section>
  )
}

export function AdvancedSection() {
  const saved = usePrefs((s) => s.terminalCommand)
  const set = usePrefs((s) => s.set)
  const [draft, setDraft] = useState(saved)
  useEffect(() => setDraft(saved), [saved])
  // Save when leaving the field, not once per letter.
  const save = () => { if (draft !== saved) set({ terminalCommand: draft }) }
  return (
    <section className="fx-d-group" aria-labelledby="fx-prefs-advanced">
      <h4 id="fx-prefs-advanced">{tr('進階')}</h4>
      <div className="fx-fields">
        <label className="fx-field">
          <span>{tr('終端機預設指令')}</span>
          <input className="fx-control" value={draft} spellCheck={false} autoComplete="off" autoCapitalize="off"
            onChange={(e) => setDraft(e.target.value)} onBlur={save}
            onKeyDown={(e) => { if (e.key === 'Enter' && !composing(e.nativeEvent)) save() }} />
        </label>
      </div>
    </section>
  )
}

/** Everything on the settings page back to its default, language included. The global AGENTS.md is the user's writing, not a preference, and stays. */
export function resetSettings() {
  usePrefs.getState().set(DEFAULT_PREFS)
  useStore.getState().act((x) => void setLanguage(x, 'zh'))
}

/** Asks first, like deleting: the first press turns it into the question, the second resets; looking away cancels. */
export function ResetSettings() {
  const [asking, setAsking] = useState(false)
  const press = () => {
    if (asking) resetSettings()
    setAsking(!asking)
  }
  return (
    <div className="fx-settings-file-acts">
      <button type="button" className="fx-save fx-danger" onClick={press} onBlur={() => setAsking(false)}>
        {asking ? tr('確定重設回預設值') : tr('重設回預設值')}
      </button>
    </div>
  )
}

/** Skipping hides the list until it is started over; starting over empties what was learned, both at once. */
function TutorialActs() {
  const hidden = useStore((s) => tutorialOf(s.world).hidden)
  return (
    <div className="fx-settings-file-acts">
      {!hidden && <button type="button" className="fx-save" onClick={() => updateTutorial({ hidden: true })}>{tr('略過教學')}</button>}
      <button type="button" className="fx-save" onClick={() => updateTutorial({ reset: true })}>{tr('重新開始教學')}</button>
    </div>
  )
}

/** A wait in seconds as the settings show it: off, or in seconds, minutes or hours. */
export const idleFollowLabel = (s: number) =>
  s === 0 ? tr('關閉#view') : s < 60 ? tr('{a} 秒', { a: s }) : s < 3600 ? tr('{a} 分鐘', { a: s / 60 }) : tr('{a} 小時', { a: s / 3600 })

export function PrefsPage() {
  const prefs = usePrefs()
  const language = useStore((s) => s.world.language)
  const act = useStore((s) => s.act)
  const check = (key: Exclude<keyof Prefs, 'logOrder' | 'defaultTab' | 'defaultAirportTab' | 'chatTitleModel' | 'chatTitleEffort' | 'imageProvider' | 'musicVolume' | 'effectsVolume' | 'musicStyle' | 'zoomSensitivity' | 'idleFollow' | 'idleFollowTarget' | 'terminalCommand' | 'autoView' | 'mapClick' | 'busyAnimation' | 'autoTab' | 'daylight' | 'hiddenBlueprints' | 'hiddenWorkflows' | keyof typeof COMPACT_DEFAULTS>, label: string) => (
    <Toggle label={label} checked={prefs[key]} onChange={(v) => prefs.set({ [key]: v })} />
  )
  return (
    <div className="fx-d-groups fx-prefs-groups">
      <section className="fx-d-group" aria-labelledby="fx-prefs-general">
        <h4 id="fx-prefs-general">{tr('一般')}</h4>
        <div className="fx-fields">
          <Select label={tr('語言')} value={language} options={[...LANGUAGES]} labelOf={(l) => LANGUAGE_NAMES[l as Locale]}
            onChange={(l) => act((x) => void setLanguage(x, l as Locale))} />
          <Select label={tr('預設機場頁面')} value={airportTabOr(prefs.defaultAirportTab)} options={AIRPORT_TABS.map((x) => x.id)}
            labelOf={(id) => tr(AIRPORT_TABS.find((x) => x.id === id)!.label)} onChange={(v) => prefs.set({ defaultAirportTab: v as AirportTab })} />
          <Select label={tr('預設公司頁面')} value={tabOr(prefs.defaultTab)} options={COMPANY_TABS.filter((x) => x.id !== 'files').map((x) => x.id)}
            labelOf={(id) => tr(COMPANY_TABS.find((x) => x.id === id)!.label)} onChange={(v) => prefs.set({ defaultTab: v as CompanyTab })} />
          <Select label={tr('自動切換預設頁面')} value={prefs.autoTab} options={Object.keys(AUTO_TABS)} labelOf={(o) => tr(AUTO_TABS[o as AutoTab])}
            onChange={(v) => prefs.set({ autoTab: v as AutoTab })} />
        </div>
      </section>
      <section className="fx-d-group" aria-labelledby="fx-prefs-controls">
        <h4 id="fx-prefs-controls">{tr('操作')}</h4>
        <div className="fx-fields">
          <Volume label={tr('縮放靈敏度')} value={prefs.zoomSensitivity} {...ZOOM_SENSITIVITY} onChange={(zoomSensitivity) => prefs.set({ zoomSensitivity })} />
          <Select label={tr('自動檢視')} value={prefs.autoView} options={Object.keys(AUTO_VIEWS)} labelOf={(o) => tr(AUTO_VIEWS[o as AutoView])}
            onChange={(v) => prefs.set({ autoView: v as AutoView })} />
          <Select label={tr('閒置時跟隨民眾')} value={String(prefs.idleFollow)} options={IDLE_FOLLOWS.map(String)}
            labelOf={(o) => idleFollowLabel(Number(o))} onChange={(v) => prefs.set({ idleFollow: Number(v) })} />
          <Select label={tr('閒置鏡頭跟隨目標')} value={prefs.idleFollowTarget} options={Object.keys(IDLE_FOLLOW_TARGETS)}
            labelOf={(o) => tr(IDLE_FOLLOW_TARGETS[o as IdleFollowTarget])} onChange={(v) => prefs.set({ idleFollowTarget: v as IdleFollowTarget })} />
          <Select label={tr('點選地圖')} value={prefs.mapClick} options={Object.keys(MAP_CLICKS)} labelOf={(o) => tr(MAP_CLICKS[o as MapClick])}
            onChange={(v) => prefs.set({ mapClick: v as MapClick })} />
        </div>
      </section>
      <section className="fx-d-group" aria-labelledby="fx-prefs-use">
        <h4 id="fx-prefs-use">{tr('功能')}</h4>
        <div className="fx-fields">
          <Select label={tr('任務紀錄排序')} value={prefs.logOrder} options={Object.keys(LOG_ORDERS)} labelOf={(o) => tr(LOG_ORDERS[o as LogOrder])}
            onChange={(v) => prefs.set({ logOrder: v as LogOrder })} />
          {!MOCK && <Toggle label={tr('保留終端機')} checked={prefs.keepTerminals} onChange={(v) => prefs.set({ keepTerminals: v })} />}
          {import.meta.env.MODE === 'desktop' && check('systemNotices', tr('系統通知'))}
        </div>
      </section>
      <section className="fx-d-group" aria-labelledby="fx-prefs-perf">
        <h4 id="fx-prefs-perf">{tr('遊戲物件')}</h4>
        <div className="fx-fields">
          {check('detail', tr('細節'))}
          {check('shadows', tr('陰影'))}
          {check('crowd', tr('地圖民眾'))}
          {check('planes', tr('飛機動畫'))}
          {check('clouds', tr('雲朵'))}
          <Select label={tr('時間')} value={prefs.daylight} options={Object.keys(DAYLIGHTS)} labelOf={(o) => tr(DAYLIGHTS[o as Daylight])}
            onChange={(v) => prefs.set({ daylight: v as Daylight })} />
          <Select label={tr('建築工作動畫')} value={prefs.busyAnimation} options={Object.keys(BUSY_ANIMATIONS)} labelOf={(o) => tr(BUSY_ANIMATIONS[o as BusyAnimation])}
            onChange={(v) => prefs.set({ busyAnimation: v as BusyAnimation })} />
        </div>
      </section>
      <MusicSection />
      {!MOCK && <SystemSection />}
      {!MOCK && <CompactSection />}
      {!MOCK && <AdvancedSection />}
      <section className="fx-d-group" aria-labelledby="fx-prefs-tutorial">
        <h4 id="fx-prefs-tutorial">{tr('教學')}</h4>
        <TutorialActs />
      </section>
      {!MOCK && <ReloadSettings />}
      <ResetSettings />
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
            <span>{x.label}</span><span className="fx-sr">{tr('（另開分頁）')}</span>
          </a></li>
        ))}
      </ul>
      <section className="fx-d-group" aria-labelledby="fx-license">
        <h4 id="fx-license">{tr('授權')}</h4>
        <pre className="fx-license" tabIndex={0}>{LICENSE}</pre>
      </section>
      <section className="fx-d-group" aria-labelledby="fx-version">
        <h4 id="fx-version">{tr('版本')}</h4>
        <p><code>{VERSION}</code></p>
      </section>
      <a className="fx-save" href={ISSUE_URL} target="_blank" rel="noreferrer">
        {tr('問題回報')}<span className="fx-sr">{tr('（另開分頁）')}</span>
      </a>
    </div>
  )
}
