import { describe, expect, it } from 'vitest'
import { acceptMention, fileChoices, mentionAt, skillChoices } from './mentions'

const at = (text: string) => mentionAt(text, text.length)

describe('the word at the cursor', () => {
  it('counts "$" and "@" only at the start of a word', () => {
    expect(at('$go')).toMatchObject({ kind: '$', start: 0, query: 'go' })
    expect(at('用\n@src/a')).toMatchObject({ kind: '@', start: 2, query: 'src/a' })
    expect(at('a$go')).toBeNull()
    expect(at('me@x.com')).toBeNull()
    expect(at('/help')).toBeNull()
    expect(at('$go ')).toBeNull()
  })

  it('reads up to the cursor, not past it', () => {
    expect(mentionAt('$go more', 2)).toMatchObject({ token: '$g', query: 'g' })
  })

  it('keeps spaces inside an open quote, and ends at the closing one', () => {
    expect(at('read @"my folder/in')).toMatchObject({ start: 5, query: 'my folder/in' })
    expect(at('read @"my notes.txt" then $go')).toMatchObject({ kind: '$', query: 'go' })
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
    expect(file).toMatchObject({ name: 'a.ts', hint: 'src/', text: '@src/a.ts ' })
    expect(spaced.text).toBe('@"my notes.txt" ')
    expect(folder).toMatchObject({ name: 'my folder/', text: '@"my folder/' })
    expect(at(folder.text)).toMatchObject({ query: 'my folder/' })
    expect(at(spaced.text)).toBeNull()
  })
})
