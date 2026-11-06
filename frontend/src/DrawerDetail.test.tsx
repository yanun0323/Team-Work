import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { Detail } from './DrawerDetail'
import { useStore } from './core/store'
import type { ModelProvider } from './core/domain/types'

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
