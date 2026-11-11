import { describe, expect, it } from 'vitest'
import type { Meeting, TaskActivity } from './core/domain/types'
import { activeMeeting, answerers, draftStillGoes, feedRows, meetingActions, meetingMentions, meetingTakesWords, meetingWord } from './meetingFeed'
import { tabIndents } from './MentionBox'

const look = { skin: '', hair: '', shirt: '', pants: '', hairStyle: 0, accessory: 0 } as unknown as Meeting['participants'][number]['look']
const meeting = (m: Partial<Meeting> = {}): Meeting => ({
  version: 2, id: 'sub-9', topic: '規則', chairId: 'rep-1', state: 'open', revision: 3, batch: 1, callsInBatch: 2, callsTotal: 2, startedAt: 0,
  participants: [
    { replicaId: 'rep-1', name: 'Mira', look, model: 'm' },
    { replicaId: 'rep-2', name: 'Kai', look, model: 'm' },
    { replicaId: 'rep-3', name: 'Ivy', look, model: 'm' },
  ],
  ...m,
})
const line = (a: Partial<TaskActivity>): TaskActivity => ({ id: `a${a.seq}`, seq: 1, at: 0, kind: 'message', from: 'agent', text: '', planVersion: 1, ...a })
const said = (seq: number, id = 'sub-9', a: Partial<TaskActivity> = {}) => line({ seq, kind: 'meeting', meetingVersion: 2, meetingPart: 'speech', meetingId: id, ...a })

describe('where a meeting\'s words go in the conversation', () => {
  it('keeps the words of a meeting under way as lines among the rest', () => {
    const m = meeting()
    const rows = feedRows([said(1), line({ seq: 2, kind: 'event' }), said(3)], () => m)
    expect(rows.map((r) => r.kind)).toEqual(['line', 'line', 'line'])
    expect(rows[0].kind === 'line' && rows[0].meeting).toBe(m)
  })

  it('makes a meeting that is over one card at its conclusion, the other lines in their places', () => {
    const m = meeting({ state: 'ended', summary: 's', summaryActivityId: 'a4' })
    const rows = feedRows([said(1), line({ seq: 2, kind: 'event' }), said(3), said(4, 'sub-9', { meetingPart: 'summary' }), line({ seq: 5 })], () => m)
    expect(rows.map((r) => r.kind)).toEqual(['line', 'card', 'line'])
    const card = rows[1]
    expect(card.kind === 'card' && [card.anchor.id, card.summary?.id]).toEqual(['a4', 'a4'])
  })

  it('puts the card at its last loaded words when the conclusion is on a page not read yet', () => {
    const m = meeting({ state: 'ended', summary: 's', summaryActivityId: 'a99' })
    const rows = feedRows([said(1), line({ seq: 2 }), said(3)], () => m)
    expect(rows.map((r) => r.kind)).toEqual(['line', 'card'])
    expect(rows[1].kind === 'card' && [rows[1].anchor.id, rows[1].summary]).toEqual(['a3', undefined])
  })

  it('gives each meeting its own card, and leaves an older meeting\'s words in a row gathered as before', () => {
    const over = (id: string) => meeting({ id, state: id === 'sub-8' ? 'cancelled' : 'ended' })
    const rows = feedRows([
      said(1, 'sub-8'), said(2, 'sub-7'),
      line({ seq: 3, kind: 'meeting', meetingId: 'old' }), line({ seq: 4, kind: 'meeting', meetingId: 'old' }),
      line({ seq: 5 }), line({ seq: 6, kind: 'meeting', meetingId: 'old' }),
    ], over)
    expect(rows.map((r) => r.kind)).toEqual(['card', 'card', 'legacy', 'line', 'legacy'])
    expect(rows[2].kind === 'legacy' && rows[2].lines.map((l) => l.seq)).toEqual([3, 4])
  })
})

describe('the meeting under way', () => {
  it('is one held in the conversation that is not over', () => {
    const subOf = (m: Meeting | undefined) => () => (m ? { meeting: m } as never : undefined)
    expect(activeMeeting('sub-9', subOf(meeting()))?.id).toBe('sub-9')
    expect(activeMeeting('sub-9', subOf(meeting({ state: 'ended' })))).toBeUndefined()
    expect(activeMeeting(undefined, subOf(meeting()))).toBeUndefined()
    expect(activeMeeting('sub-9', subOf(undefined))).toBeUndefined()
  })
})

describe('whom the user\'s words in a meeting go to', () => {
  it('asks those mentioned in order, else nobody named, which the chair answers', () => {
    const m = meeting()
    expect(meetingMentions('看一下', m)).toEqual([])
    expect(answerers('看一下', m).map((p) => p.name)).toEqual(['Mira'])
    expect(meetingMentions('@Ivy 先，再 @Kai，@Ivy', m)).toEqual(['rep-3', 'rep-2'])
    expect(answerers('@Ivy 先，再 @Kai', m).map((p) => p.name)).toEqual(['Ivy', 'Kai'])
  })

  it('makes @All everyone in it, the chair last, and asks nobody outside it', () => {
    const m = meeting()
    expect(meetingMentions('@All 怎麼看', m)).toEqual(['rep-2', 'rep-3', 'rep-1'])
    expect(meetingMentions('@Theo 你呢', m)).toEqual([])
  })
})

describe('where a meeting stands and what the user can do', () => {
  it('ends it while it goes on, goes on or ends once paused, and only retries a conclusion that was asked for and not written', () => {
    expect(meetingActions(meeting())).toEqual(['end'])
    expect(meetingActions(meeting({ state: 'paused', pauseReason: 'limit' }))).toEqual(['continue', 'end'])
    expect(meetingActions(meeting({ state: 'paused', pauseReason: 'taskPaused' }))).toEqual(['continue', 'end'])
    expect(meetingActions(meeting({ state: 'paused', pauseReason: 'context' }))).toEqual(['end'])
    expect(meetingActions(meeting({ state: 'paused', pauseReason: 'budget', closingRequested: true }))).toEqual(['retrySummary'])
    expect(meetingActions(meeting({ state: 'summaryFailed' }))).toEqual(['retrySummary'])
    expect(meetingActions(meeting({ state: 'closing' }))).toEqual([])
    expect(meetingActions(meeting({ state: 'ended' }))).toEqual([])
  })

  it('says it is paused, wrapping up or failed to conclude, and nothing while it goes on', () => {
    expect(meetingWord(meeting())).toBe('')
    expect(meetingWord(meeting({ state: 'paused' }))).toBe('已暫停')
    expect(meetingWord(meeting({ state: 'closing' }))).toBe('收尾中…')
    expect(meetingWord(meeting({ state: 'summaryFailed' }))).toBe('結論失敗')
    expect(meetingWord(meeting({ state: 'paused', closingRequested: true }))).toBe('結論失敗')
  })

  it('takes words while it goes on or is paused, to wait their turn, but not while its conclusion is being written', () => {
    expect(meetingTakesWords(meeting())).toBe(true)
    expect(meetingTakesWords(meeting({ state: 'paused', pauseReason: 'limit' }))).toBe(true)
    expect(meetingTakesWords(meeting({ state: 'closing' }))).toBe(false)
    expect(meetingTakesWords(meeting({ state: 'summaryFailed' }))).toBe(false)
    expect(meetingTakesWords(meeting({ state: 'paused', closingRequested: true }))).toBe(false)
  })
})

describe('a draft', () => {
  it('goes only where it was written to: not to the owner once its meeting ended, nor into a meeting that opened after', () => {
    expect(draftStillGoes('sub-9', 'sub-9')).toBe(true)
    expect(draftStillGoes('', '')).toBe(true)
    expect(draftStillGoes('sub-9', '')).toBe(false)
    expect(draftStillGoes('', 'sub-9')).toBe(false)
  })

  it('lets Tab leave an empty box, so the keyboard reaches the buttons around it, and indents once there is text', () => {
    expect(tabIndents('')).toBe(false)
    expect(tabIndents('x')).toBe(true)
  })
})
