import { describe, expect, it } from 'vitest'
import { seedWorld } from './core/data/seed'
import spec from '../../blueprint_sample.yaml?raw'
import { parseBlueprintYaml, YAML_TEMPLATE } from './blueprintYaml'

const read = (yaml: string) => parseBlueprintYaml(yaml, 5, () => 'abc1234')

describe('a blueprint written as YAML', () => {
  it('reads the template', () => {
    const r = read(YAML_TEMPLATE)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toMatchObject({ name: 'Reviewer', tools: ['readFile', 'writeFile', 'webSearch', 'runCommand'] })
    expect(r.value.prompt).toContain('程式碼審查者')
    expect(r.value.comment).toContain('建議')
    const repo = {
      kind: 'git', repo: 'git@github.com:anthropics/skills', ref: 'main', commit: 'abc1234', latestRef: 'main', latest: 'abc1234',
      private: false, upstream: true, update: { at: 5, ok: true },
    }
    expect(r.value.skills).toEqual([
      { source: { kind: 'local', path: '~/.agents/' }, include: null, exclude: ['deploy'] },
      { source: repo, include: null, exclude: [] },
      { source: repo, include: ['code-review', 'summarize'], exclude: [] },
    ])
  })

  it('starts from the example in blueprint_sample.yaml at the repo root', () => {
    expect(YAML_TEMPLATE.trim()).toBe(spec.trim())
  })

  it('needs only a name; everything else starts empty', () => {
    expect(read('name: A\n')).toEqual({ ok: true, value: { name: 'A', prompt: '', comment: '', skills: [], tools: [] } })
    expect(read('name: A\nprompt:\nskills:\n')).toMatchObject({ ok: true, value: { prompt: '', skills: [] } })
  })

  it('reads a skill repo with no version as the default branch, and an address with its version', () => {
    const r = read('name: A\nskills:\n  - repo: a/b\n  - repo: https://github.com/c/d/tree/v2\n')
    expect(r.ok && r.value.skills.map((p) => p.source)).toMatchObject([{ repo: 'git@github.com:a/b', ref: '' }, { repo: 'git@github.com:c/d', ref: 'v2' }])
  })

  it('keeps the tools in their usual order, once each', () => {
    const r = read('name: A\ntools: [run_command, read_file, read_file]\n')
    expect(r.ok && r.value.tools).toEqual(['readFile', 'runCommand'])
  })

  it('says what is wrong, and where', () => {
    expect(read('prompt: x\n')).toEqual({ ok: false, error: '缺少 name' })
    expect(read('name: A\nmodel: m\n')).toMatchObject({ ok: false, line: 2, error: expect.stringContaining('不支援 model') })
    expect(read('name: A\ntools:\n  - bash\n')).toMatchObject({ ok: false, line: 3 })
    expect(read('name: A\nskills:\n  - repo: nope\n')).toMatchObject({ ok: false, error: 'repo 要是 owner/repo 或 GitHub 網址', line: 3 })
    expect(read('name: A\nskills:\n  - include: [x]\n')).toMatchObject({ ok: false, error: 'skills 的每一項要有 path 或 repo', line: 3 })
    expect(read('name: A\nskills:\n  - path: ~/a\n    repo: a/b\n')).toMatchObject({ ok: false, error: 'path 和 repo 只能擇一' })
    expect(read('name: A\nskills:\n  - path: ~/a\n    ref: main\n')).toMatchObject({ ok: false, error: 'ref 只用在 repo', line: 4 })
    expect(read('name: A\nskills:\n  - path: ~/a\n    include: x\n')).toMatchObject({ ok: false, line: 4 })
    expect(read('name: [\n')).toMatchObject({ ok: false, error: 'YAML 格式錯誤' })
    expect(read('- a\n')).toMatchObject({ ok: false })
  })

  it('matches what the seed blueprints written as YAML say about themselves', () => {
    const where = (s: unknown) => s && (s as { kind: string }).kind === 'git'
      ? { repo: (s as { repo: string }).repo, ref: (s as { ref: string }).ref } : s
    for (const bp of Object.values(seedWorld().blueprints)) {
      if (bp.source.kind !== 'yaml') continue
      const r = read(bp.source.text)
      expect(r.ok).toBe(true)
      if (!r.ok) continue
      const plain = (x: typeof r.value) => ({ ...x, skills: x.skills.map((p) => ({ ...p, source: where(p.source) })) })
      expect(plain(r.value)).toEqual(plain({ name: bp.name, prompt: bp.prompt, comment: bp.comment, skills: bp.skills, tools: bp.tools }))
    }
  })
})
