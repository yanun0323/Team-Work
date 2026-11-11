// Meetings held in an owner-led task's conversation (version 2): how their words sit among the rest of it, whom the
// user's words go to, and where a draft was meant to go. Pure, so it can be tested without a screen.

import type { Meeting, MeetingParticipant, SubTask, TaskActivity } from './core/domain/types'
import { ALL, mentionedPeople, withAll, type Person } from './mentions'

export const isMeetingWords = (a: TaskActivity) => a.kind === 'meeting' && a.meetingVersion === 2 && !!a.meetingId

/** A meeting is over once it has ended with a conclusion, or was cancelled with none. */
export const meetingOver = (m: Meeting | undefined) => m?.state === 'ended' || m?.state === 'cancelled'

export type FeedRow =
  | { kind: 'line'; a: TaskActivity; meeting?: Meeting }
  /** An older meeting's words, the ones in a row gathered. */
  | { kind: 'legacy'; lines: TaskActivity[] }
  /** A meeting that is over, as one card where its conclusion is, else where its last loaded words are. */
  | { kind: 'card'; meeting: Meeting; anchor: TaskActivity; summary?: TaskActivity }

/**
 * The conversation's rows, oldest first. The words of a meeting under way stay lines of their own among the rest; a
 * meeting that is over is one card, however many other lines came between its words; an older meeting's words in a
 * row are one line, as they were.
 */
export function feedRows(items: TaskActivity[], meetingOf: (id: string) => Meeting | undefined): FeedRow[] {
  // where each meeting that is over goes: its conclusion, else its last words loaded
  const anchors = new Map<string, TaskActivity>()
  for (const a of items) {
    if (!isMeetingWords(a)) continue
    const m = meetingOf(a.meetingId!)
    if (!meetingOver(m)) continue
    const was = anchors.get(a.meetingId!)
    const summary = a.meetingPart === 'summary' || a.id === m!.summaryActivityId
    if (!was || summary || (was.meetingPart !== 'summary' && was.id !== m!.summaryActivityId)) anchors.set(a.meetingId!, a)
  }
  const rows: FeedRow[] = []
  for (let i = 0; i < items.length; i++) {
    const a = items[i]
    if (isMeetingWords(a)) {
      const m = meetingOf(a.meetingId!)
      if (!meetingOver(m)) { rows.push({ kind: 'line', a, meeting: m }); continue }
      if (anchors.get(a.meetingId!) !== a) continue
      const summary = a.meetingPart === 'summary' || a.id === m!.summaryActivityId ? a : undefined
      rows.push({ kind: 'card', meeting: m!, anchor: a, summary })
      continue
    }
    if (a.kind === 'meeting' && a.meetingId) {
      const lines = [a]
      while (items[i + 1]?.kind === 'meeting' && !isMeetingWords(items[i + 1]) && items[i + 1].meetingId === a.meetingId) lines.push(items[++i])
      rows.push({ kind: 'legacy', lines })
      continue
    }
    rows.push({ kind: 'line', a })
  }
  return rows
}

/** The meeting under way in a task, when it is one held in the conversation. */
export function activeMeeting(activeId: string | undefined, subOf: (id: string) => SubTask | undefined): Meeting | undefined {
  const m = activeId ? subOf(activeId)?.meeting : undefined
  return m?.version === 2 && !meetingOver(m) ? m : undefined
}

/** Whom "@" offers in a meeting: All, then those in it, the chair first. */
export const meetingPeople = (m: Meeting): Person[] => [ALL, ...m.participants.map((p) => ({ id: p.replicaId, name: p.name }))]

/**
 * Who answer the user's words, in order: those mentioned, "@All" being everyone with the chair last; none mentioned
 * means the chair alone, which the backend decides, so it is sent as none.
 */
export function meetingMentions(text: string, m: Meeting): string[] {
  const guests = m.participants.filter((p) => p.replicaId !== m.chairId).map((p) => p.replicaId)
  return withAll(mentionedPeople(text, meetingPeople(m)), guests, m.chairId).filter((id) => id !== ALL.id)
}

/** Who the box's words will go to: those mentioned, else the chair. */
export function answerers(text: string, m: Meeting): MeetingParticipant[] {
  const ids = meetingMentions(text, m)
  const of = (id: string) => m.participants.find((p) => p.replicaId === id)
  return (ids.length ? ids : [m.chairId]).flatMap((id) => of(id) ?? [])
}

/**
 * Where a draft goes, decided when its first word was written: a meeting's id, or '' for the owner. A draft for a
 * meeting that has since ended, or written to the owner before one opened, is not sent anywhere on its own.
 */
export const draftStillGoes = (writtenFor: string, now: string) => writtenFor === now

/** What the bar says of where the meeting stands; nothing while it goes on. */
export function meetingWord(m: Meeting): '' | '已暫停' | '收尾中…' | '結論失敗' {
  if (m.state === 'summaryFailed' || (m.state === 'paused' && m.closingRequested)) return '結論失敗'
  if (m.state === 'paused') return '已暫停'
  if (m.state === 'closing') return '收尾中…'
  return ''
}

/** What the user can do to the meeting where it stands. */
export function meetingActions(m: Meeting): ('continue' | 'end' | 'retrySummary')[] {
  // a conclusion asked for and not written is only asked for again, never talked on
  if (m.state === 'summaryFailed' || (m.state === 'paused' && m.closingRequested)) return ['retrySummary']
  if (m.state === 'closing' || meetingOver(m)) return []
  // a meeting stopped on its own waits for the user; one stopped for a context too long can only end
  if (m.state === 'paused' && m.pauseReason !== 'context') return ['continue', 'end']
  return ['end']
}

/** Whether the user's words are taken now: never while it is ending, as the conclusion is being written from them. */
export const meetingTakesWords = (m: Meeting) => m.state === 'open' || (m.state === 'paused' && !m.closingRequested)
