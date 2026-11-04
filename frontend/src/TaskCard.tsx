// A task as a clipping: on the company file's task board, and under the chat message it was made at.

import type { ButtonHTMLAttributes } from 'react'
import { tr } from './core/i18n'
import { notStarted, statusOf, subsOf, taskTokens } from './core/domain/sim'
import type { Task } from './core/domain/types'
import { fmtTokens } from './core/model'
import { useStore } from './core/store'
import { PixelFace } from './core/voxel/PixelFace'
import { WaitBadge } from './Controls'

export function TaskCard({ task, className, ...button }: { task: Task } & ButtonHTMLAttributes<HTMLButtonElement>) {
  const w = useStore((s) => s.world)
  const faces = subsOf(w, task.id)
    .filter((s) => !s.cancelled && s.replicaId && (s.status === 'progressing' || s.status === 'review'))
    .map((s) => w.replicas[s.replicaId as string])
    .filter((r, i, all) => r && all.indexOf(r) === i)
  const tokens = taskTokens(w, task)
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
      {tokens > 0 && <span className="fx-task-tokens">{fmtTokens(tokens)} Token</span>}
    </button>
  )
}
