import { describe, expect, it } from 'vitest'
import { acceptMention, ALL, answerMentions, fileChoices, mentionAt, mentionedPeople, personChoices, saidParts, skillChoices, withAll } from './mentions'

const at = (text: string) => mentionAt(text, text.length)

describe('the word at the cursor', () => {
  it('counts "$", "#" and "@" only at the start of a word', () => {
    expect(at('$go')).toMatchObject({ kind: '$', start: 0, query: 'go' })
    expect(at('用\n#src/a')).toMatchObject({ kind: '#', start: 2, query: 'src/a' })
    expect(at('a$go')).toBeNull()
    expect(at('me#x')).toBeNull()
    expect(at('問 @Bea')).toMatchObject({ kind: '@', start: 2, query: 'Bea' })
    expect(at('me@x')).toBeNull()
    expect(at('/help')).toBeNull()
    expect(at('$go ')).toBeNull()
  })

  it('reads up to the cursor, not past it', () => {
    expect(mentionAt('$go more', 2)).toMatchObject({ token: '$g', query: 'g' })
  })

  it('keeps spaces inside an open quote, and ends at the closing one', () => {
    expect(at('read #"my folder/in')).toMatchObject({ start: 5, query: 'my folder/in' })
    expect(at('read #"my notes.txt" then $go')).toMatchObject({ kind: '$', query: 'go' })
  })
})

describe('people', () => {
  const crew = [{ id: 'a', name: 'Ada' }, { id: 'al', name: 'Ada Lovelace' }, { id: 'b', name: 'Bea' }, { id: 'm', name: '小明' }]

  it('offer names that start with the query, then ones that hold it', () => {
    expect(personChoices('a', crew).map((c) => c.key)).toEqual(['a', 'al', 'b'])
    expect(personChoices('b', crew)[0]).toMatchObject({ name: 'Bea', text: '@Bea ' })
  })

  it('read who a message mentions, in order, the longest name first', () => {
    expect(mentionedPeople('@Bea 和 @Ada Lovelace 先說，@Ada 再說', crew)).toEqual(['b', 'al', 'a'])
    expect(mentionedPeople('@小明你看呢', crew)).toEqual(['m'])
    expect(mentionedPeople('@Adam 和 me@Bea 不算', crew)).toEqual([])
    expect(mentionedPeople('@Bea，@Bea', crew)).toEqual(['b'])
  })
})

describe('choices', () => {
  const skills = [
    { name: 'review', description: 'read code for go' },
    { name: 'pogo', description: '' },
    { name: 'Go', description: '' },
    { name: 'tdd', description: '' },
  ]

  it('rank skills by name start, name, then description', () => {
    expect(skillChoices('go', skills).map((c) => c.name)).toEqual(['Go', 'pogo', 'review'])
    expect(skillChoices('', skills)).toHaveLength(4)
    expect(skillChoices('zzz', skills)).toEqual([])
  })

  it('put in "$" and the name, ready for the next word', () => {
    const text = '用 $t 看看'
    expect(acceptMention(text, mentionAt(text, 4)!, skillChoices('t', skills)[0])).toEqual({ text: '用 $tdd  看看', cursor: 7 })
  })

  it('end a mention at a file, quoted if it must be, and stay in a folder', () => {
    const [file, spaced, folder] = fileChoices([
      { path: 'src/a.ts', dir: false }, { path: 'my notes.txt', dir: false }, { path: 'my folder', dir: true },
    ])
    expect(file).toMatchObject({ name: 'a.ts', hint: 'src/', text: '#src/a.ts ' })
    expect(spaced.text).toBe('#"my notes.txt" ')
    expect(folder).toMatchObject({ name: 'my folder/', text: '#"my folder/' })
    expect(at(folder.text)).toMatchObject({ query: 'my folder/' })
    expect(at(spaced.text)).toBeNull()
  })
})

describe('saidParts', () => {
  const people = [{ id: 'a', name: 'Ada' }, { id: 'b', name: '小貝' }]
  const marked = (text: string, signs?: string) => saidParts(text, people, signs).filter((p) => p.kind).map((p) => p.text)

  it('marks people, files and skills, and keeps the text whole', () => {
    const text = '@Ada 看 #src/a.ts，用 $commit 和 #"my file.md" 跟@小貝說'
    expect(marked(text)).toEqual(['@Ada', '#src/a.ts', '$commit', '#"my file.md"', '@小貝'])
    expect(saidParts(text, people).map((p) => p.text).join('')).toBe(text)
  })

  it('leaves prices, words running into a sign and unknown names alone', () => {
    expect(marked('花了 $100，a#b x$y @Bob a@Ada.com')).toEqual([])
  })

  it('looks only for the signs asked for', () => {
    expect(marked('@Ada 看 #12 要 $3 或 $commit', '@')).toEqual(['@Ada'])
  })
  it('says what each names: who, which file or folder, which skill', () => {
    const named = saidParts('@小貝 看 #docs/ 和 #"my notes.txt" 再用 $tdd', people).filter((p) => p.kind)
      .map(({ kind, id, path, dir, skill }) => ({ kind, id, path, dir, skill }))
    expect(named).toEqual([
      { kind: '@', id: 'b', path: undefined, dir: undefined, skill: undefined },
      { kind: '#', id: undefined, path: 'docs', dir: true, skill: undefined },
      { kind: '#', id: undefined, path: 'my notes.txt', dir: false, skill: undefined },
      { kind: '$', id: undefined, path: undefined, dir: undefined, skill: 'tdd' },
    ])
  })
})

describe('withAll', () => {
  it('makes @All everyone in the meeting, others mentioned after the guests and the chair last', () => {
    expect(withAll([ALL.id], ['b', 'c'], 'a')).toEqual(['b', 'c', 'a'])
    expect(withAll(['a', ALL.id, 'd'], ['b', 'c'], 'a')).toEqual(['b', 'c', 'd', 'a'])
    expect(withAll(['c'], ['b', 'c'], 'a')).toEqual(['c'])
    expect(mentionedPeople('@All 你們呢', [ALL, { id: 'a', name: 'Ada' }])).toEqual([ALL.id])
  })
})

describe('answerMentions', () => {
  it('sends an answer with no mention to the one who asked', () => {
    expect(answerMentions([], 'r1')).toEqual(['r1'])
  })
  it('keeps the mentions the user typed', () => {
    expect(answerMentions(['r2'], 'r1')).toEqual(['r2'])
  })
  it('leaves a message with no question for everyone', () => {
    expect(answerMentions([], undefined)).toEqual([])
  })
})
