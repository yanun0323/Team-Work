import { expect, test } from 'vitest'
import { draftKey, readDraft, saveDraft } from './chatDraft'

test('a new chat and a chat under way keep separate drafts', () => {
  expect(draftKey(undefined, 't1')).toBe('new:t1')
  expect(draftKey(undefined, '')).toBe('new:')
  expect(draftKey('c1', 't1')).toBe('c1')
})

test('a draft is kept until it is emptied', () => {
  const image = { name: 'a.png', url: 'data:image/png;base64,' } as never
  saveDraft('c1', { text: 'hello', images: [image] })
  expect(readDraft('c1')).toEqual({ text: 'hello', images: [image] })
  expect(readDraft('c2')).toEqual({ text: '', images: [] })
  saveDraft('c1', { text: '', images: [] })
  expect(readDraft('c1')).toEqual({ text: '', images: [] })
})
