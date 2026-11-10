import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { DeleteTool, Detail } from './DrawerDetail'
import { useStore } from './core/store'
import type { ModelProvider } from './core/domain/types'
import { isLocked } from './core/data/presets'
import { sourceName } from './source'

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
