import { describe, expect, it } from 'vitest'
import { projectFile, projectTree } from './core/domain/sim'
import { answer, mockShell } from './mockShell'

describe('the sample project under dev-mock', () => {
  it('lists a folder one level at a time, folders first and then by name, as the backend does', () => {
    expect(projectTree('').entries.map((e) => e.name)).toEqual(['docs', 'node_modules', 'src', '.gitignore', 'my notes.txt', 'package.json', 'README.md'])
    expect(projectTree('').entries.find((e) => e.name === 'node_modules')?.ignored).toBe(true)
    expect(projectTree('src').entries.map((e) => e.path)).toEqual(['src/components', 'src/app.test.ts', 'src/app.ts'])
    expect(() => projectTree('nope')).toThrow()
  })

  it('has something in every file it lists', () => {
    const files = (path: string): string[] => projectTree(path).entries.flatMap((e) => (e.kind === 'dir' ? (e.ignored ? [] : files(e.path)) : [e.path]))
    for (const f of files('')) expect(projectFile(f), f).not.toBe('')
  })
})

describe('the shell under dev-mock', () => {
  it('answers a few commands and not others', () => {
    expect(answer('  git   status ')).toContain('On branch main')
    expect(answer('ls')).toBe('docs  node_modules  src  my notes.txt  package.json  README.md')
    expect(answer('')).toBe('')
    expect(answer('rm -rf /')).toBeNull()
  })

  it('echoes what is typed, runs it on Enter and prompts again', async () => {
    const shell = mockShell()
    let out = ''
    shell.onmessage = (m) => { out += new TextDecoder().decode(m.data as ArrayBuffer) }
    const type = (s: string) => shell.send(new TextEncoder().encode(s) as Uint8Array<ArrayBuffer>)
    type('pwx\x7fd\r')
    type('nope\r')
    shell.send('{"cols":80,"rows":24}')
    await new Promise((r) => setTimeout(r, 10))
    expect(out).toContain('pwx\b \bd\r\n~/code/acme-shop\r\n')
    expect(out).toContain('zsh: command not found: nope')
    expect(out.match(/acme-shop % /g)).toHaveLength(3)
  })
})
