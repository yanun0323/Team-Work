// What each tab of the company file shows. All of it reads the live world, so it moves with the simulation.

import { useEffect } from 'react'
import { nodeOf } from './core/domain/graph'
import { statusOf, subsOf } from './core/domain/sim'
import type { Chat, Status, TeamSettings } from './core/domain/types'
import { BlueprintIcon } from './BlueprintIcon'
import { useT } from './core/i18n'
import { byBlueprint, mindOf } from './crew'
import { activity, teamReplicas, teamTasks } from './core/model'
import { useStore } from './core/store'
import { PixelFace } from './core/voxel/PixelFace'
import { Select, Stepper, WaitBadge } from './Controls'
import { editTeam, refreshPrompt } from './core/ops'
import { itemKey, type Item } from './DrawerDetail'

export type Tab = 'chats' | 'tasks' | 'crew' | 'settings'

export const TABS: { id: Tab; label: string }[] = [
  { id: 'chats', label: '對話' },
  { id: 'tasks', label: '任務' },
  { id: 'crew', label: '員工' },
  { id: 'settings', label: '設定' },
]

const COLUMNS: { status: Status; label: string }[] = [
  { status: 'todo', label: '待辦' },
  { status: 'progressing', label: '進行中' },
  { status: 'review', label: '待回覆' },
  { status: 'complete', label: '完成' },
]

/** Which item's detail sheet is open (by itemKey), and how to open one. */
interface Opens { teamId: string; open: string | null; onOpen: (x: Item) => void }

export function TabBody({ tab, ...p }: Opens & { tab: Tab }) {
  if (tab === 'chats') return <Chats {...p} />
  if (tab === 'tasks') return <Tasks {...p} />
  if (tab === 'crew') return <Crew {...p} />
  return <Settings {...p} />
}

/** The props that make something open its detail sheet; it stays shaded while the sheet is open. */
function opener(x: Item, { open, onOpen }: Opens) {
  return { type: 'button' as const, 'aria-expanded': open === itemKey(x), 'aria-controls': 'fx-detail', onClick: () => onOpen(x) }
}

function Empty({ children }: { children: string }) {
  return <p className="fx-empty">{children}</p>
}

/** The company's chats, the latest activity first, and a new one. */
function Chats(p: Opens) {
  const w = useStore((s) => s.world)
  const lastAt = (c: Chat) => c.messages[c.messages.length - 1]?.at ?? c.createdAt
  const chats = Object.values(w.chats).filter((c) => c.teamId === p.teamId).sort((a, b) => lastAt(b) - lastAt(a))
  return (
    <div className="fx-d-groups fx-crew-groups">
      <button className="fx-task fx-task-new fx-flow-new fx-hit" {...opener({ kind: 'newChat' }, p)}>＋ 新對話</button>
      {!chats.length && <Empty>還沒有對話</Empty>}
      {chats.length > 0 && (
        <ul className="fx-list">
          {chats.map((c) => {
            const r = w.replicas[c.replicaId]
            const name = r?.name ?? c.name
            return (
              <li key={c.id}><button className="fx-row fx-hit" {...opener({ kind: 'chat', id: c.id }, p)}>
                <PixelFace look={r?.look ?? c.look} name={name} size={34} />
                <span className="fx-row-main">
                  <b>{name}<span className="fx-chat-model">{c.model}</span></b>
                  <span className="fx-chat-first">{c.messages[0]?.text}</span>
                </span>
              </button></li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

export function Tasks(p: Opens) {
  const { teamId } = p
  const w = useStore((s) => s.world)
  const tasks = teamTasks(w, teamId).filter((x) => x.stage !== 'cancelled')
  return (
    <div className="fx-board">
      {COLUMNS.map((c) => {
        const list = tasks.filter((x) => statusOf(w, x) === c.status)
        return (
          <section key={c.status} className={`fx-lane fx-lane-${c.status}`} aria-label={c.label}>
            <h3>{c.label}<span className="fx-count">{list.length}</span></h3>
            {c.status === 'todo' && (
              <button className="fx-task fx-task-new fx-hit" {...opener({ kind: 'newTask' }, p)}>＋ 新增任務</button>
            )}
            {list.map((task) => {
              const faces = subsOf(w, task.id)
                .filter((s) => !s.cancelled && s.replicaId && (s.status === 'progressing' || s.status === 'review'))
                .map((s) => w.replicas[s.replicaId as string])
                .filter((r, i, all) => r && all.indexOf(r) === i)
              return (
                <button key={task.id} className="fx-task fx-hit" {...opener({ kind: 'task', id: task.id }, p)}>
                  {/* waiting on the user: red to answer, green to merge */}
                  {c.status === 'review' && <WaitBadge merge={task.stage === 'awaitMerge'} />}
                  <span className="fx-task-title"><span className="fx-task-no">#{task.number}</span>{task.title}</span>
                  {faces.length > 0 && (
                    <span className="fx-faces">
                      {faces.map((r) => <span key={r.id} title={r.name}><PixelFace look={r.look} name={r.name} size={22} /></span>)}
                    </span>
                  )}
                  {/* only what the column doesn't already say */}
                  {(task.paused || task.stage === 'merging') && (
                    <span className="fx-pill">{task.paused ? '已暫停' : '合併中'}</span>
                  )}
                </button>
              )
            })}
          </section>
        )
      })}
    </div>
  )
}

function Crew(p: Opens) {
  const { teamId } = p
  const t = useT()
  const w = useStore((s) => s.world)
  const crew = teamReplicas(w, teamId)
  return (
    <div className="fx-d-groups fx-crew-groups">
      <button className="fx-task fx-task-new fx-flow-new fx-hit" {...opener({ kind: 'newCrew' }, p)}>＋ 新增員工</button>
      {!crew.length && <Empty>{t('roster.empty')}</Empty>}
      {byBlueprint(w, crew).map(({ bp, list }) => (
        <section key={bp.id} className="fx-d-group" aria-label={bp.name}>
          {/* the group's title is its blueprint, which opens on a sheet of its own */}
          <h4><button className="fx-bp-head fx-hit" {...opener({ kind: 'blueprint', id: bp.id }, p)}>
            <span aria-hidden="true"><BlueprintIcon look={bp.look} name={bp.name} size={24} /></span>{bp.name}<span className="fx-count">{list.length}</span>
          </button></h4>
          <ul className="fx-list">
            {list.map((r) => {
              const a = activity(w, r)
              // idle people show nothing; busy ones show the step and task
              const doing = a.sub && a.task
                ? `${nodeOf(a.task.workflow, a.sub.nodeId)?.name ?? ''} · #${a.task.number}`
                : a.merging ? `合併 · #${a.merging.number}` : null
              return (
                <li key={r.id}><button className="fx-row fx-hit" {...opener({ kind: 'crew', id: r.id }, p)}>
                  <PixelFace look={r.look} name={r.name} size={34} />
                  <span className="fx-row-main"><b>{r.name}</b><span>{mindOf(r)}</span></span>
                  {doing && <span className="fx-pill fx-pill-on">{doing}</span>}
                </button></li>
              )
            })}
          </ul>
        </section>
      ))}
    </div>
  )
}

function Settings({ teamId, ...p }: Opens) {
  const team = useStore((s) => s.world.teams[teamId])
  const act = useStore((s) => s.act)
  // the prompt is the project's AGENTS.md: coming back to the app may mean it was just edited elsewhere
  useEffect(() => {
    const refresh = () => refreshPrompt(teamId)
    refresh()
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [teamId])
  // gone, while the file turns away
  if (!team) return null
  const num = (key: keyof TeamSettings, label: string, unit: string, min: number, step: number) => (
    <Stepper
      label={label} unit={unit} min={min} step={step} value={team.settings[key]}
      onChange={(v) => act((x) => editTeam(x, teamId, { settings: { ...x.teams[teamId].settings, [key]: v } }))}
    />
  )
  return (
    <div className="fx-fields">
      <label className="fx-field">
        <span>名稱</span>
        <input className="fx-control" value={team.name} onChange={(e) => act((x) => editTeam(x, teamId, { name: e.target.value }))} />
      </label>
      <Select
        label="目標分支" value={team.targetBranch} options={team.branches}
        onChange={(v) => act((x) => editTeam(x, teamId, { targetBranch: v }))}
      />
      <label className="fx-field fx-field-top">
        <span>AGENTS.md</span>
        <textarea className="fx-control" rows={6} value={team.prompt}
          onChange={(e) => act((x) => editTeam(x, teamId, { prompt: e.target.value }))} />
      </label>
      <hr />
      {num('timeoutMin', '子任務逾時', '分鐘', 1, 1)}
      {num('costLimitUsd', '任務費用上限', 'USD', 0.5, 0.5)}
      {num('retries', '失敗重試', '次', 0, 1)}
      <hr />
      <button className="fx-save fx-danger" {...opener({ kind: 'disband' }, { teamId, ...p })}>解散公司</button>
    </div>
  )
}
