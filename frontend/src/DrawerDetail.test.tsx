import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { DeleteTool, Detail, type Item } from './DrawerDetail'
import { blueprintChoices } from './Pickers'
import { useStore } from './core/store'
import type { ModelProvider } from './core/domain/types'
import { AIRPORT_BLUEPRINT, isLocked } from './core/data/presets'
import { sourceName } from './source'
import { useDraft } from './draft'
import { subsOf } from './core/domain/sim'

it('offers to swap at once only when someone already on a step comes off it', () => {
  const w = useStore.getState().world
  const sub = Object.values(w.subTasks).find((s) => s.status === 'progressing' && s.replicaId && !s.cancelled)!
  const task = w.tasks[sub.taskId]
  const other = Object.values(w.replicas).find((r) => r.teamId === task.teamId && r.id !== sub.replicaId)!
  const sheet = (staff: Record<string, string[]>) => {
    Object.assign(useStore.getInitialState(), useStore.getState())
    Object.assign(useDraft.getInitialState(), { draft: { title: task.title, description: task.description, workflowId: task.workflowId, staff, from: null, taskId: task.id, ownerId: task.ownerId } })
    const noop = () => {}
    return renderToStaticMarkup(<Detail item={{ kind: 'taskEdit', id: task.id }} teamId={task.teamId} depth={0} covered={false} leaving={false}
      onGone={noop} onBack={noop} onDone={noop} onClear={noop} onPush={noop} onOpen={noop} />)
  }
  const kept = Object.fromEntries(task.workflow.nodes.map((n) => [n.id, [...n.replicaIds]]))
  expect(subsOf(w, task.id).filter((s) => s.replicaId && !s.cancelled && s.status !== 'complete')
    .every((s) => kept[s.nodeId].includes(s.replicaId!))).toBe(true)
  try {
    const same = sheet(kept)
    expect(same).toContain('>儲存</button>')
    expect(same).not.toContain('儲存並立刻換人')
    const swapped = sheet({ ...kept, [sub.nodeId]: [other.id] })
    expect(swapped).toContain('>儲存，下一步起生效</button>')
    expect(swapped).toContain('>儲存並立刻換人</button>')
  } finally {
    Object.assign(useDraft.getInitialState(), { draft: null })
  }
})

it('hands no run over at once in a task its owner runs, a meeting under way included', () => {
  const w = useStore.getState().world
  const task = Object.values(w.tasks).find((t) => t.orchestration === 'owner' && t.coordination?.activeMeetingId)!
  const meeting = subsOf(w, task.id).find((s) => s.meeting && s.status !== 'complete')!
  const node = task.workflow.nodes.find((n) => n.id === meeting.nodeId)!
  const other = Object.values(w.replicas).find((r) => r.teamId === task.teamId && r.id !== meeting.replicaId)!
  const staff = Object.fromEntries(task.workflow.nodes.map((n) => [n.id, [...n.replicaIds]]))
  const sheet = (s: Record<string, string[]>) => {
    Object.assign(useStore.getInitialState(), useStore.getState())
    Object.assign(useDraft.getInitialState(), { draft: { title: task.title, description: task.description, workflowId: task.workflowId, staff: s, from: null, taskId: task.id, ownerId: task.ownerId } })
    const noop = () => {}
    return renderToStaticMarkup(<Detail item={{ kind: 'taskEdit', id: task.id }} teamId={task.teamId} depth={0} covered={false} leaving={false}
      onGone={noop} onBack={noop} onDone={noop} onClear={noop} onPush={noop} onOpen={noop} />)
  }
  try {
    // the chair is the task's owner, not someone the step was staffed with, and a run under way is kept as it was told;
    // the backend turns a swap away, so the sheet offers none
    const html = sheet({ ...staff, [node.id]: [other.id] })
    expect(html).toContain('>儲存</button>')
    expect(html).not.toContain('儲存，下一步起生效')
    expect(html).not.toContain('儲存並立刻換人')
  } finally {
    Object.assign(useDraft.getInitialState(), { draft: null })
  }
})

it('writes the flow of a task its owner runs on its edit sheet, keeping the steps that ran', () => {
  const w = useStore.getState().world
  const task = Object.values(w.tasks).find((t) => t.orchestration === 'owner' && t.stage === 'running' && subsOf(w, t.id).length > 0)!
  const ran = new Set(subsOf(w, task.id).map((s) => s.nodeId))
  const done = task.workflow.nodes.find((n) => ran.has(n.id))!
  const fresh = task.workflow.nodes.find((n) => !ran.has(n.id))!
  const staff = Object.fromEntries(task.workflow.nodes.map((n) => [n.id, [...n.replicaIds]]))
  const sheet = (item: Item, custom = structuredClone(task.workflow)) => {
    Object.assign(useStore.getInitialState(), useStore.getState())
    Object.assign(useDraft.getInitialState(), { draft: { title: task.title, description: task.description, workflowId: task.workflowId, staff, from: null, taskId: task.id, ownerId: task.ownerId, custom } })
    const noop = () => {}
    return renderToStaticMarkup(<Detail item={item} teamId={task.teamId} depth={0} covered={false} leaving={false}
      onGone={noop} onBack={noop} onDone={noop} onClear={noop} onPush={noop} onOpen={noop} />)
  }
  try {
    const html = sheet({ kind: 'taskEdit', id: task.id })
    expect(html).toContain('＋ 新增步驟')
    // a step that ran is faded and has no bin; one that did not can go
    expect(html).not.toContain(`aria-label="刪除 ${done.name}"`)
    expect(html).toContain(`aria-label="刪除 ${fresh.name}"`)
    expect(html).toMatch(new RegExp(`data-step="${done.id}" class="[^"]*fx-node-done`))
    // a step's own sheet writes it, as on a new task, and only one that never ran can be deleted
    const step = (id: string) => sheet({ kind: 'staff', node: id, title: '' } as Item)
    expect(step(fresh.id)).toContain('aria-label="步驟名稱"')
    expect(step(fresh.id)).toContain('Prompt')
    expect(step(fresh.id)).toContain('aria-label="刪除"')
    expect(step(done.id)).toContain('aria-label="步驟名稱"')
    expect(step(done.id)).not.toContain('aria-label="刪除"')
    // a step with no name keeps it from being saved
    const unnamed = structuredClone(task.workflow)
    unnamed.nodes.find((n) => n.id === fresh.id)!.name = ''
    const off = sheet({ kind: 'taskEdit', id: task.id }, unnamed)
    expect(off).toMatch(/<button type="submit" class="fx-save" disabled=""/)
    expect(off).toContain('有步驟沒有名稱')
  } finally {
    Object.assign(useDraft.getInitialState(), { draft: null })
  }
})

it('picks no blueprint for an employee whose blueprint is gone, so saving waits for one', () => {
  const w = useStore.getState().world
  const r = Object.values(w.replicas)[0]
  const was = r.blueprintId
  const sheet = () => {
    Object.assign(useStore.getInitialState(), useStore.getState())
    const noop = () => {}
    return renderToStaticMarkup(<Detail item={{ kind: 'crewEdit', id: r.id }} teamId={r.teamId} depth={0} covered={false} leaving={false}
      onGone={noop} onBack={noop} onDone={noop} onClear={noop} onPush={noop} onOpen={noop} />)
  }
  const saveOff = (html: string) => /<button type="submit" class="fx-save" disabled=""/.test(html)
  try {
    expect(saveOff(sheet())).toBe(false)
    r.blueprintId = 'preset-assistant'
    expect(saveOff(sheet())).toBe(true)
  } finally {
    r.blueprintId = was
  }
})

it('shows how many tokens a provider\'s models can read: its own, the one set, or the 128K guess', () => {
  const w = useStore.getState().world
  const sheet = (p: ModelProvider) => {
    w.providers[p.id] = p
    // the server render reads the store's initial state
    Object.assign(useStore.getInitialState(), useStore.getState())
    const noop = () => {}
    return renderToStaticMarkup(<Detail item={{ kind: 'provider', id: p.id }} teamId="" depth={0} covered={false} leaving={false}
      onGone={noop} onBack={noop} onDone={noop} onClear={noop} onPush={noop} onOpen={noop} />)
  }
  const base = { name: 'P', baseUrl: '', auth: { kind: 'apiKey' as const, keyHint: 'x' }, models: [] }
  try {
    expect(sheet({ ...base, id: 'w1', kind: 'anthropic' })).toContain('Context window</h3><p class="fx-d-text"><code>1,000,000</code>')
    expect(sheet({ ...base, id: 'w2', kind: 'google', contextWindow: 200_000 })).toContain('<code>200,000</code>')
    expect(sheet({ ...base, id: 'w3', kind: 'compatible' })).toContain('<code>128,000</code>')
  } finally {
    for (const id of ['w1', 'w2', 'w3']) delete w.providers[id]
  }
})

it('offers to read a provider\'s models again only when it can answer', () => {
  const w = useStore.getState().world
  const sheet = (p: ModelProvider) => {
    w.providers[p.id] = p
    Object.assign(useStore.getInitialState(), useStore.getState())
    const noop = () => {}
    return renderToStaticMarkup(<Detail item={{ kind: 'provider', id: p.id }} teamId="" depth={0} covered={false} leaving={false}
      onGone={noop} onBack={noop} onDone={noop} onClear={noop} onPush={noop} onOpen={noop} />)
  }
  const base = { name: 'P', kind: 'anthropic' as const, baseUrl: '', models: [] }
  try {
    expect(sheet({ ...base, id: 'r1', auth: { kind: 'apiKey', keyHint: 'x' } })).toContain('aria-label="重新讀取模型"')
    expect(sheet({ ...base, id: 'r2', auth: { kind: 'subscription', signedIn: true } })).toContain('aria-label="重新讀取模型"')
    expect(sheet({ ...base, id: 'r3', auth: { kind: 'subscription' } })).not.toContain('重新讀取模型')
  } finally {
    for (const id of ['r1', 'r2', 'r3']) delete w.providers[id]
  }
})

it('says where a task blueprint that cannot be edited comes from, and nothing for one of your own', () => {
  const w = useStore.getState().world
  const mine = Object.values(w.workflows).find((f) => !isLocked(f.id))!
  const source = Object.values(w.sources).find((x) => x.kind === 'git')!
  const sourced = `${source.id}--copy`
  w.workflows['preset-copy'] = { ...mine, id: 'preset-copy' }
  w.workflows[sourced] = { ...mine, id: sourced }
  Object.assign(useStore.getInitialState(), useStore.getState())
  const noop = () => {}
  const sheet = (id: string) => renderToStaticMarkup(<Detail item={{ kind: 'flow', id }} teamId="" depth={0} covered={false} leaving={false}
    onGone={noop} onBack={noop} onDone={noop} onClear={noop} onPush={noop} onOpen={noop} />)
  try {
    expect(sheet('preset-copy')).toContain('<span class="fx-d-origin">內建</span>')
    expect(sheet(sourced)).toContain(`<span class="fx-d-origin">${sourceName(source)}</span>`)
    expect(sheet(mine.id)).not.toContain('fx-d-origin')
  } finally {
    delete w.workflows['preset-copy']
    delete w.workflows[sourced]
  }
})

it('keeps a delete that cannot be done now reachable, saying why to the keyboard and a screen reader too', () => {
  const html = renderToStaticMarkup(<DeleteTool what="來源" disabled why="還有 2 個藍圖或員工使用這個來源，無法刪除" onConfirm={() => {}} />)
  expect(html).not.toContain('disabled=""')
  expect(html).toContain('aria-disabled="true"')
  const id = html.match(/aria-describedby="([^"]+)"/)![1]
  expect(html).toContain(`<span id="${id}" class="fx-tool-why">還有 2 個藍圖或員工使用這個來源，無法刪除</span>`)
  // one that can delete is a plain bin, asking first
  expect(renderToStaticMarkup(<DeleteTool what="來源" onConfirm={() => {}} />)).not.toContain('aria-disabled')
})

it('shows environment failure details instead of claiming verification exhausted retries', () => {
  const w = useStore.getState().world
  const task = Object.values(w.tasks)[0]
  const id = 'environment-review-test'
  const node = task.workflow.nodes.find((n) => n.kind !== 'talk')!
  w.subTasks[id] = {
    id, taskId: task.id, nodeId: node.id, parentId: null, upstreamIds: [], replicaId: null,
    status: 'review', progress: 0, createdAt: 0, attempts: 0, costUsd: 0, tokens: 0,
    routedTo: [], routed: false, arrivedAt: 0, waiting: false, log: [], cancelled: false, duration: 0, script: { lines: [] },
    review: { kind: 'failed', from: 'progressing', reason: 'environment', prompt: 'Environment preparation failed; work and verification have not started: npm unavailable', options: [{ id: 'retry' }, { id: 'skip' }], at: 0 },
  }
  try {
    Object.assign(useStore.getInitialState(), useStore.getState())
    const noop = () => {}
    const html = renderToStaticMarkup(<Detail item={{ kind: 'sub', id }} teamId={task.teamId} depth={0} covered={false} leaving={false}
      onGone={noop} onBack={noop} onDone={noop} onClear={noop} onPush={noop} onOpen={noop} />)
    expect(html).toContain('Environment preparation failed; work and verification have not started: npm unavailable')
    expect(html).not.toContain('automatic retries')
  } finally {
    delete w.subTasks[id]
  }
})

it('deletes a blueprint in use by moving everyone on it, in every company, to another one picked first', () => {
  const w = useStore.getState().world
  const base = Object.values(w.replicas)[0]
  const bp = w.blueprints[base.blueprintId] ?? Object.values(w.blueprints).find((b) => !b.owner)!
  const team = w.teams[base.teamId]
  w.blueprints['bp-old'] = { ...bp, id: 'bp-old', name: 'Old', owner: undefined }
  w.blueprints['bp-spare'] = { ...bp, id: 'bp-spare', name: 'Spare', owner: undefined }
  w.teams['team-far'] = { ...team, id: 'team-far', name: 'Far Co' }
  w.replicas['rep-here'] = { ...base, id: 'rep-here', name: 'Here', blueprintId: 'bp-old' }
  w.replicas['rep-far'] = { ...base, id: 'rep-far', teamId: 'team-far', name: 'Faraway', blueprintId: 'bp-old' }
  const noop = () => {}
  const sheet = (item: Item) => {
    Object.assign(useStore.getInitialState(), useStore.getState())
    return renderToStaticMarkup(<Detail item={item} teamId={team.id} depth={0} covered={false} leaving={false}
      onGone={noop} onBack={noop} onDone={noop} onClear={noop} onPush={noop} onOpen={noop} />)
  }
  try {
    // in use: a bin that opens the sheet, not one that cannot be pressed
    const detail = sheet({ kind: 'blueprint', id: 'bp-old' })
    expect(detail).toContain('aria-expanded="false" aria-label="刪除"')
    expect(detail).not.toContain('aria-disabled')
    // no one on it: the bin that asks first, as before
    const spare = sheet({ kind: 'blueprint', id: 'bp-spare' })
    expect(spare).toContain('aria-label="刪除"')
    expect(spare).not.toContain('aria-expanded="false" aria-label="刪除"')
    // built-in: no bin at all
    expect(sheet({ kind: 'blueprint', id: AIRPORT_BLUEPRINT })).not.toContain('aria-label="刪除"')

    const form = sheet({ kind: 'blueprintDelete', id: 'bp-old' })
    expect(form).toContain('刪除 Old')
    expect(form).toContain('<b>Here</b></li>')
    expect(form).toContain('<b>Faraway</b><span>Far Co</span>')
    expect(form).toContain('<button type="submit" class="fx-save" disabled="">轉移並刪除</button>')
    // gone meanwhile: says so
    expect(sheet({ kind: 'blueprintDelete', id: 'bp-none' })).not.toContain('轉移並刪除')

    const choices = blueprintChoices(w, ['bp-spare'], '', 'bp-old')
    expect(choices).not.toContain('bp-old')
    expect(choices).not.toContain('bp-spare')
    expect(choices).not.toContain(AIRPORT_BLUEPRINT)
    expect(choices.length).toBeGreaterThan(0)
  } finally {
    for (const id of ['rep-here', 'rep-far']) delete w.replicas[id]
    for (const id of ['bp-old', 'bp-spare']) delete w.blueprints[id]
    delete w.teams['team-far']
  }
})
