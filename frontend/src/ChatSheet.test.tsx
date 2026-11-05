import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { CompactLine, ContextUse } from './ChatSheet'
import { useStore } from './core/store'
import type { Chat } from './core/domain/types'

it('draws where the earlier conversation was summed up as a divider, not a tool line', () => {
  expect(renderToStaticMarkup(<CompactLine />)).toBe('<li class="fx-room-handoff">已整理較早的對話</li>')
})

it('shows under the box how much the next call sends, of what the model can read', () => {
  const w = useStore.getState().world
  w.providers.ctx = { id: 'ctx', name: 'C', kind: 'openai', baseUrl: '', auth: { kind: 'apiKey', keyHint: 'x' }, models: ['ctx-model'] }
  // the server render reads the store's initial state
  Object.assign(useStore.getInitialState(), useStore.getState())
  const chat: Chat = { id: 'c', teamId: 't', replicaId: 'r', name: 'R', look: Object.values(w.replicas)[0].look, model: 'ctx-model', tokens: 9, context: 123_456, messages: [], createdAt: 0 }
  try {
    expect(renderToStaticMarkup(<ContextUse chat={chat} />)).toBe('<p class="fx-room-context fx-room-say-wide">123,456 / 272,000</p>')
    expect(renderToStaticMarkup(<ContextUse chat={{ ...chat, context: undefined }} />)).toContain('>0 / 272,000<')
  } finally {
    delete w.providers.ctx
  }
})
