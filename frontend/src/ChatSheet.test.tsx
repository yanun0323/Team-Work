import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { AskBox, ChatFoot, ChatId, CompactLine, ContextUse, HandoffLine, NoteName, ToolLine } from './ChatSheet'
import { useStore } from './core/store'
import type { Chat } from './core/domain/types'

it('shows the chat id as a button that copies it', () => {
  const html = renderToStaticMarkup(<ChatId id="chat-7" />)
  expect(html).toContain('type="button"')
  expect(html).toContain('aria-label="複製對話 ID"')
  expect(html).toContain('>chat-7</button>')
})

it('draws where the earlier conversation was summed up as a divider, not a tool line', () => {
  expect(renderToStaticMarkup(<CompactLine />)).toBe('<li class="fx-room-handoff">已整理較早的對話</li>')
})

it('shows a picture image_gen saved without the path it was saved to', () => {
  expect(renderToStaticMarkup(<ToolLine text="read_file a.txt" />)).toBe('<li class="fx-room-tool"><code>read_file a.txt</code></li>')
  expect(renderToStaticMarkup(<ToolLine text="design/a.png" images={[<i key={0}>a.png</i>]} />))
    .toBe('<li class="fx-room-tool"><div class="fx-chat-images fx-room-tool-images"><i>a.png</i></div></li>')
})

it('draws a handoff as a divider that opens the chat it came from, unless that is gone', () => {
  const h = { before: 2, replicaId: 'r', name: 'Ada', chatId: 'chat-7' }
  const line = (gone: boolean) => renderToStaticMarkup(<HandoffLine handoff={h} to="Bea" gone={gone} open={false} onOpen={() => {}} />)
  expect(line(false)).toBe('<li class="fx-room-handoff"><button type="button" class="fx-hit" aria-expanded="false">從 chat-7 交給 Bea</button></li>')
  expect(line(true)).toBe('<li class="fx-room-handoff">從 chat-7 交給 Bea</li>')
  // one kept from before the chat it came from was recorded says who had it
  expect(renderToStaticMarkup(<HandoffLine handoff={{ ...h, chatId: undefined }} to="Bea" gone={false} open={false} onOpen={() => {}} />)).toBe('<li class="fx-room-handoff">Ada 交給 Bea</li>')
})

it('shows under the box how much the next call sends, of what the model can read', () => {
  const w = useStore.getState().world
  w.providers.ctx = { id: 'ctx', name: 'C', kind: 'openai', baseUrl: '', auth: { kind: 'apiKey', keyHint: 'x' }, models: ['ctx-model'] }
  // the server render reads the store's initial state
  Object.assign(useStore.getInitialState(), useStore.getState())
  const chat: Chat = { id: 'c', teamId: 't', replicaId: 'r', name: 'R', look: Object.values(w.replicas)[0].look, model: 'ctx-model', tokens: 9, context: 123_456, messages: [], createdAt: 0 }
  try {
    expect(renderToStaticMarkup(<ContextUse chat={chat} />)).toBe('<p class="fx-room-context">123,456 / 272,000</p>')
    expect(renderToStaticMarkup(<ContextUse chat={{ ...chat, context: undefined }} />)).toContain('>0 / 272,000<')
    // the chat's id sits before it, on the same line under the box
    const foot = renderToStaticMarkup(<ChatFoot chat={{ ...chat, id: 'chat-42' }} />)
    expect(foot).toMatch(/^<div class="fx-room-foot fx-room-say-wide"><button[^>]*>chat-42<\/button><p class="fx-room-context">123,456 \/ 272,000<\/p><\/div>$/)
  } finally {
    delete w.providers.ctx
  }
})

it('folds a question\'s options away under who asked, and opens them again', () => {
  const look = Object.values(useStore.getState().world.replicas)[0].look
  const open = renderToStaticMarkup(<AskBox to={{ name: 'Ann', look }} options={['A', 'B']} folded={false} onFold={() => {}} onPick={() => {}} />)
  expect(open).toMatch(/<button type="button" class="fx-room-to fx-room-fold" aria-expanded="true">直接回答.*Ann/)
  expect(open).toContain('<button type="button" class="fx-choice">A</button><button type="button" class="fx-choice">B</button>')
  const folded = renderToStaticMarkup(<AskBox to={{ name: 'Ann', look }} options={['A', 'B']} folded onFold={() => {}} onPick={() => {}} />)
  expect(folded).toContain('aria-expanded="false"')
  expect(folded).not.toContain('fx-choice')
  // with nobody to name, the switch still says what it folds
  expect(renderToStaticMarkup(<AskBox options={['A']} folded={false} onFold={() => {}} onPick={() => {}} />)).toContain('aria-expanded="true">選項<svg')
})

it('shows whose a note is only when its colour is shared, and reads it out either way', () => {
  expect(renderToStaticMarkup(<NoteName name="Ada" shown={false} />)).toBe('<span class="fx-sr">Ada：</span>')
  expect(renderToStaticMarkup(<NoteName name="Ada" shown />)).toBe('<span class="fx-chat-name">Ada<span class="fx-sr">：</span></span>')
})
