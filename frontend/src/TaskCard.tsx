// A task as a clipping: on the company file's task board, and under the chat message it was made at. What else
// an employee creates in a chat is a clipping there too.

import type { ButtonHTMLAttributes } from 'react'
import { tr } from './core/i18n'
import { notStarted, progressOf, statusOf, subsOf, taskTokens } from './core/domain/sim'
import { nodeOf } from './core/domain/graph'
import type { Made, Task } from './core/domain/types'
import { fmtTokens } from './core/model'
import { useStore } from './core/store'
import { PixelFace } from './core/voxel/PixelFace'
import { WaitBadge } from './Controls'

const madeKind = { blueprint: '員工藍圖#kind', workflow: '任務藍圖', provider: '供應商' } as const

/** A blueprint, flow or provider an employee created, as a clipping under the chat message it was made at; none once it is gone. */
export function MadeCard({ made, className, ...button }: { made: Made } & ButtonHTMLAttributes<HTMLButtonElement>) {
  const name = useStore((s) => (made.kind === 'blueprint' ? s.world.blueprints : made.kind === 'workflow' ? s.world.workflows : s.world.providers)[made.id]?.name)
  if (name === undefined) return null
  return (
    <button type="button" className={`fx-task fx-hit${className ? ` ${className}` : ''}`} {...button}>
      <span className="fx-task-title"><span className="fx-task-no">{tr(madeKind[made.kind])}</span>{name}</span>
    </button>
  )
}

export function TaskCard({ task, className, ...button }: { task: Task } & ButtonHTMLAttributes<HTMLButtonElement>) {
  const w = useStore((s) => s.world)
  const faces = subsOf(w, task.id)
    .filter((s) => !s.cancelled && s.replicaId && (s.status === 'progressing' || s.status === 'review'))
    .map((s) => w.replicas[s.replicaId as string])
    .filter((r, i, all) => r && all.indexOf(r) === i)
  const tokens = taskTokens(w, task)
  const p = progressOf(w, task)
  // the step at work now, "+n" for others alongside it, then steps done of the flow's; a long name gives way first
  const step = p?.now.length ? nodeOf(task.workflow, p.now[0])?.name ?? p.now[0] : ''
  const more = p && p.now.length > 1 ? ` +${p.now.length - 1}` : ''
  return (
    <button type="button" className={`fx-task fx-hit${className ? ` ${className}` : ''}`} {...button}>
      {/* waiting on the user: red to answer, green to merge */}
      {statusOf(w, task) === 'review' && <WaitBadge merge={task.stage === 'awaitMerge'} />}
      <span className="fx-task-title"><span className="fx-task-no">#{task.number}</span>{task.title}</span>
      {faces.length > 0 && (
        <span className="fx-faces">
          {faces.map((r) => <span key={r.id} title={r.name}><PixelFace look={r.look} name={r.name} size={22} /></span>)}
        </span>
      )}
      {/* only what the board's column doesn't already say */}
      {((task.paused && !notStarted(task)) || task.stage === 'merging') && (
        <span className="fx-pill">{task.stage === 'merging' ? tr('合併中') : tr('已暫停')}</span>
      )}
      {(p || tokens > 0) && (
        <span className="fx-task-foot">
          {p && <span className="fx-task-progress">{step && <span className="fx-task-step">{step}</span>}{step && `${more} · `}{p.done}/{p.total}</span>}
          {tokens > 0 && <span className="fx-task-tokens">{fmtTokens(tokens)} Token</span>}
        </span>
      )}
    </button>
  )
}
