import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { changeAsk, ChangeLines } from './ChangeCard'
import { chatSign } from './crew'
import { setAppLanguage } from './core/i18n'
import { handOffChat, resolveChatChange, rewindChat, sayInChat } from './core/domain/sim'
import type { Chat, PendingChange, World } from './core/domain/types'

afterEach(() => setAppLanguage('zh'))

const change: PendingChange = { kind: 'blueprint', targetId: 'bp', name: 'Dev', lines: [
  { field: 'prompt', before: '舊', after: '新' },
  { field: 'comment', before: '', after: '加上' },
  { field: 'node', after: '新步驟' },
  { field: 'edge', before: 'A → B' },
] }

const chatWorld = () => {
  const chat = { id: 'c', teamId: '', replicaId: '', name: 'x', model: 'm', tokens: 0, createdAt: 0, change,
    messages: [{ at: 0, from: 'user', text: '嗨' }, { at: 1, from: 'agent', text: '好' }] } as unknown as Chat
  return { now: 2, seq: 0, chats: { c: chat }, replicas: {} } as unknown as World
}

describe('a change card', () => {
  it('shows what was and what will be', () => {
    const html = renderToStaticMarkup(<ChangeLines change={change} />)
    expect(html).toContain('舊')
    expect(html).toContain('新')
    expect(html).toContain('（空白）')
    expect((html.match(/<del>/g) ?? []).length).toBe(3) // an added step has nothing before it
    expect((html.match(/<ins>/g) ?? []).length).toBe(3) // a removed connection has nothing after it
  })

  it('shows a source a blueprint brings as only added', () => {
    const html = renderToStaticMarkup(<ChangeLines change={{ ...change, lines: [{ field: 'source', after: 'https://github.com/a/b main @ 1a2b3c4' }] }} />)
    expect(html).toContain('新增來源')
    expect(html).toContain('1a2b3c4')
    expect(html).not.toContain('<del>')
  })

  it('names what it is about, in either language', () => {
    expect(changeAsk(change)).toContain('藍圖「Dev」')
    expect(changeAsk({ ...change, kind: 'workflow' })).toContain('任務藍圖「Dev」')
    expect(changeAsk({ ...change, kind: 'provider' })).toContain('供應商「Dev」')
    expect(renderToStaticMarkup(<ChangeLines change={{ ...change, kind: 'provider', lines: [{ field: 'apiKey', before: '…1234', after: '…5678' }, { field: 'prices', before: '', after: 'm: 1 / 2 / 0' }] }} />)).toMatch(/API Key.*價格/)
    setAppLanguage('en')
    expect(changeAsk(change)).toBe('I would like to change the blueprint "Dev":')
    expect(renderToStaticMarkup(<ChangeLines change={change} />)).toContain('Comment')
  })

  it('marks the chat as waiting on the user', () => {
    expect(chatSign(chatWorld().chats.c)).toBe('question')
  })

  it('goes away with an answer, with saying something else, and with taking back a message', () => {
    for (const end of [
      (w: World) => resolveChatChange(w, 'c', true),
      (w: World) => resolveChatChange(w, 'c', false),
      (w: World) => sayInChat(w, 'c', '先別改'),
      (w: World) => rewindChat(w, 'c', 0),
    ]) {
      const w = chatWorld()
      end(w)
      expect(w.chats.c.change).toBeUndefined()
    }
  })

  it('stays out of a copy of the chat', () => {
    const w = chatWorld()
    expect(handOffChat(w, 'c', 1, w.chats.c.replicaId)?.change).toBeUndefined()
    expect(w.chats.c.change).toBeDefined()
  })
})
