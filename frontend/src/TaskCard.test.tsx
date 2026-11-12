import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { MadeCard, TaskCard } from './TaskCard'
import { notStarted } from './core/domain/sim'
import type { SubTask } from './core/domain/types'
import { useStore } from './core/store'

it('shows what an employee created in a chat by its kind and name, and nothing once it is gone', () => {
  const w = useStore.getState().world
  const flow = Object.values(w.workflows)[0]
  // the server render reads the store's initial state
  Object.assign(useStore.getInitialState(), useStore.getState())
  expect(renderToStaticMarkup(<MadeCard made={{ kind: 'workflow', id: flow.id }} />))
    .toContain(`<span class="fx-task-title"><span class="fx-task-no">任務藍圖</span>${flow.name}</span>`)
  expect(renderToStaticMarkup(<MadeCard made={{ kind: 'blueprint', id: 'gone' }} />)).toBe('')
})

it('shows the step at work, others alongside it, and the steps done of the flow\'s', () => {
  const w = useStore.getState().world
  const task = Object.values(w.tasks).find((t) => t.stage === 'running' && t.workflow.nodes.length >= 3 && !notStarted(t))!
  const [a, b, c] = task.workflow.nodes
  const base = Object.values(w.subTasks).find((s) => s.taskId === task.id) ?? Object.values(w.subTasks)[0]
  const sub = (id: string, nodeId: string, extra: Partial<SubTask>): SubTask =>
    ({ ...base, id, taskId: task.id, nodeId, cancelled: false, validity: 'current', ownerReview: undefined, ...extra })
  const subTasks = Object.fromEntries(Object.entries(w.subTasks).filter(([, s]) => s.taskId !== task.id))
  subTasks.x1 = sub('x1', a.id, { status: 'complete', ownerReview: 'accepted' })
  subTasks.x2 = sub('x2', b.id, { status: 'progressing' })
  subTasks.x3 = sub('x3', c.id, { status: 'progressing' })
  useStore.setState({ world: { ...w, subTasks } })
  Object.assign(useStore.getInitialState(), useStore.getState())
  const html = renderToStaticMarkup(<TaskCard task={task} />)
  expect(html).toContain(`<span class="fx-task-progress"><span class="fx-task-step">${b.name}</span> +1 · 1/${task.workflow.nodes.length}</span>`)
})
