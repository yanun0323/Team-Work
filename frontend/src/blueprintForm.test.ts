import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { blueprintToYaml } from './blueprintYaml'
import { newSkillRow, skillNames, skillPacksOf, skillRowsOf } from './blueprintForm'
import type { SkillPack } from './core/domain/types'

const read = (rows: ReturnType<typeof skillRowsOf>) => skillPacksOf(rows, 5, () => 'abc1234')
const git = (over: object) => ({ ...newSkillRow(), kind: 'git' as const, where: 'a/b', ...over })

describe('the skill rows of a blueprint', () => {
  it('read back what they were read from', () => {
    const skills: SkillPack[] = [
      { source: { kind: 'local', path: '~/.agents/' }, include: null, exclude: ['deploy'] },
      {
        source: { kind: 'git', repo: 'git@github.com:a/b', ref: 'v1', commit: 'abc1234', latestRef: 'v1', latest: 'abc1234', private: false, upstream: true, update: { at: 5, ok: true } },
        include: ['x', 'y'], exclude: [],
      },
    ]
    expect(read(skillRowsOf(skills))).toEqual({ ok: true, skills })
  })

  it('leave out the pack of a repo blueprint, which has no place here', () => {
    expect(skillRowsOf([{ source: null, include: null, exclude: [] }])).toEqual([])
  })

  it('take names split by commas or spaces, once each', () => {
    expect(skillNames(' a, b，c  a\n')).toEqual(['a', 'b', 'c'])
    expect(read([{ ...newSkillRow(), include: '' }])).toMatchObject({ skills: [{ include: null, exclude: [] }] })
  })

  it('take the version out of a pasted address', () => {
    expect(read([git({ where: 'https://github.com/c/d/tree/v2', ref: 'old' })])).toMatchObject({ skills: [{ source: { repo: 'https://github.com/c/d', ref: 'v2' } }] })
  })

  it('read a repo over HTTPS unless an SSH address was typed', () => {
    expect(read([git({ where: 'c/d' })])).toMatchObject({ skills: [{ source: { repo: 'https://github.com/c/d' } }] })
    expect(read([git({ where: 'git@github.com:c/d' })])).toMatchObject({ skills: [{ source: { repo: 'git@github.com:c/d' } }] })
  })

  it('name the row whose repo is not one', () => {
    expect(read([newSkillRow(), git({ where: 'nope' })])).toEqual({ ok: false, row: 1 })
  })
})

describe('a blueprint made on the form, as YAML', () => {
  it('says what the form says', () => {
    const value = {
      name: 'A: b', prompt: '第一行\n第二行', comment: '# 備註',
      skills: [
        { source: { kind: 'local' as const, path: '~/.agents/' }, include: null, exclude: ['deploy'] },
        { source: { kind: 'local' as const, path: '~/x/' }, include: ['a'], exclude: [] },
      ],
      tools: ['readFile' as const, 'runCommand' as const],
    }
    expect(parse(blueprintToYaml(value))).toEqual({
      name: 'A: b', prompt: '第一行\n第二行', comment: '# 備註',
      skills: [{ path: '~/.agents/', exclude: ['deploy'] }, { path: '~/x/', include: ['a'] }],
      tools: ['read_file', 'run_command'],
    })
  })

  it('leaves out what is empty', () => {
    expect(parse(blueprintToYaml({ name: 'A', prompt: '', comment: '', skills: [], tools: [] }))).toEqual({ name: 'A', skills: [], tools: [] })
  })

  it('keeps a repo and its version', () => {
    const made = read([git({ ref: 'v1' })])
    if (!made.ok) throw new Error('row')
    const text = blueprintToYaml({ name: 'A', prompt: '', comment: '', skills: made.skills, tools: [] })
    expect(parse(text).skills).toEqual([{ repo: 'a/b', ref: 'v1' }])
  })
})
