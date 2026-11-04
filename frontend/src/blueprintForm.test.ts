import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { blueprintToYaml } from './blueprintYaml'
import { clashesOf, takenOf, takes, takesAll, toggleSkill, toggleSource } from './blueprintForm'
import type { SkillPack, Source, SourceItem } from './core/domain/types'

const item = (category: string, name: string): SourceItem => ({ name, description: '', path: category ? `${category}/${name}` : name, category })
const eng = [item('eng', 'tdd'), item('eng', 'review')]
const top = [item('', 'handoff')]
const all = [...top, ...eng]

describe('ticking a source\'s skills', () => {
  it('ticks a whole source: every skill on, and those added later too', () => {
    const packs = toggleSource([], 's')
    expect(packs).toEqual([{ sourceId: 's', include: null, exclude: [] }])
    expect(takesAll(packs, 's')).toBe(true)
    expect(all.every((it) => takes(packs, 's', it))).toBe(true)
    expect(takes(packs, 's', item('eng', 'later'))).toBe(true)
  })

  it('keeps a skill switched off in a whole source as left out, still taking what is added later', () => {
    const packs = toggleSkill(toggleSource([], 's'), 's', eng[0], all)
    expect(packs).toEqual([{ sourceId: 's', include: null, exclude: ['tdd'] }])
    expect(takesAll(packs, 's')).toBe(true)
    expect(takes(packs, 's', item('eng', 'later'))).toBe(true)
    expect(toggleSkill(packs, 's', eng[0], all)).toEqual([{ sourceId: 's', include: null, exclude: [] }])
  })

  it('takes only the skills switched on in a source not ticked, and nothing added later', () => {
    const packs = toggleSkill(toggleSkill([], 's', eng[0], all), 's', top[0], all)
    expect(packs).toEqual([{ sourceId: 's', include: ['tdd', 'handoff'], exclude: [] }])
    expect(takesAll(packs, 's')).toBe(false)
    expect(takes(packs, 's', item('eng', 'later'))).toBe(false)
    expect(toggleSkill(toggleSkill(packs, 's', eng[0], all), 's', top[0], all)).toEqual([])
  })

  it('turns every skill on when the source is ticked, and off when unticked', () => {
    const whole = toggleSource(toggleSkill([], 's', eng[0], all), 's')
    expect(whole).toEqual([{ sourceId: 's', include: null, exclude: [] }])
    expect(toggleSource(whole, 's')).toEqual([])
  })

  it('switches skills of a folder taken whole, from before, into skills taken alone', () => {
    const packs: SkillPack[] = [{ sourceId: 's', path: 'eng', include: null, exclude: [] }]
    expect(takesAll(packs, 's')).toBe(false)
    expect(toggleSkill(packs, 's', top[0], all)).toEqual([{ sourceId: 's', include: ['tdd', 'review', 'handoff'], exclude: [] }])
  })

  it('leaves the other sources as they are', () => {
    const other: SkillPack = { sourceId: 'o', include: ['x'], exclude: [] }
    expect(toggleSource([other], 's')).toEqual([other, { sourceId: 's', include: null, exclude: [] }])
    expect(toggleSkill([other], 's', eng[0], all)).toEqual([other, { sourceId: 's', include: ['tdd'], exclude: [] }])
  })
})

describe('skills of one name', () => {
  const items = { a: [item('', 'tdd')], b: eng }

  it('clash when taken from two sources', () => {
    const packs = toggleSource(toggleSkill([], 'a', items.a[0], items.a), 'b')
    const found = clashesOf(takenOf(packs, items))
    expect([...found.keys()]).toEqual(['tdd'])
    expect(found.get('tdd')!.map((t) => t.sourceId)).toEqual(['a', 'b'])
    expect(clashesOf(takenOf(toggleSkill(packs, 'b', eng[0], eng), items)).size).toBe(0)
  })

  it('in one source are not a clash', () => {
    const one = { s: [item('eng', 'tdd'), item('misc', 'tdd')] }
    expect(clashesOf(takenOf(toggleSource([], 's'), one)).size).toBe(0)
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

  it('writes a pack of a source kept apart as the place it is', () => {
    const sources: Record<string, Source> = {
      g: { id: 'g', kind: 'git', repo: 'https://github.com/a/b', ref: 'main', upstream: true, autoApply: false },
      l: { id: 'l', kind: 'local', path: '~/.agents/', upstream: true, autoApply: false },
    }
    const skills: SkillPack[] = [
      { sourceId: 'g', path: 'eng', include: null, exclude: ['tdd'] },
      { sourceId: 'l', path: 'skills', include: ['x'], exclude: [] },
    ]
    expect(parse(blueprintToYaml({ name: 'A', prompt: '', comment: '', skills, tools: [] }, sources)).skills).toEqual([
      { repo: 'a/b', ref: 'main', path: 'eng', exclude: ['tdd'] },
      { path: '~/.agents/skills', include: ['x'] },
    ])
  })
})
