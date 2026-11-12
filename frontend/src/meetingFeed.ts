// Meetings held in an owner-led task's conversation (version 2): how their words sit among the rest of it, whom the
// user's words go to, and where a draft was meant to go. Pure, so it can be tested without a screen.

import { MEETING_GUESTS } from './core/domain/sim'
import { worksIn, type Look, type Meeting, type SubTask, type Task, type TaskActivity, type World } from './core/domain/types'
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

/**
 * Who the user may call into a meeting by "@": employees allowed on the task who work in its company and are not in
 * it yet, in the order given; none once it is full.
 */
export function meetingJoinable(w: World, task: Task, m: Meeting): string[] {
  if (m.participants.length - 1 >= MEETING_GUESTS) return []
  const allowed = task.coordination?.authorization.replicaIds ?? []
  return allowed.filter((id) => worksIn(w.replicas[id], task.teamId) && !m.participants.some((p) => p.replicaId === id))
}

/** Whom "@" offers in a meeting: All, then those in it, the chair first, then those who would join it. */
export const meetingPeople = (m: Meeting, joinable: Person[] = []): Person[] => [ALL, ...m.participants.map((p) => ({ id: p.replicaId, name: p.name })), ...joinable]

/**
 * Who answer the user's words, in order: those mentioned, "@All" being everyone in it with the chair last, and those
 * mentioned who are not in it yet joining it; none mentioned means the chair alone, which the backend decides, so it
 * is sent as none.
 */
export function meetingMentions(text: string, m: Meeting, joinable: Person[] = []): string[] {
  const guests = m.participants.filter((p) => p.replicaId !== m.chairId).map((p) => p.replicaId)
  return withAll(mentionedPeople(text, meetingPeople(m, joinable)), guests, m.chairId).filter((id) => id !== ALL.id)
}

/** Who the box's words will go to: those mentioned, else the chair. */
export function answerers(text: string, m: Meeting, joinable: (Person & { look: Look })[] = []): { id: string; name: string; look: Look }[] {
  const ids = meetingMentions(text, m, joinable)
  const of = (id: string) => {
    const p = m.participants.find((x) => x.replicaId === id)
    return p ? [{ id, name: p.name, look: p.look }] : joinable.filter((x) => x.id === id).map(({ id, name, look }) => ({ id, name, look }))
  }
  return (ids.length ? ids : [m.chairId]).flatMap(of)
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
