import { describe, expect, it } from 'vitest'
import { outputFile } from './doc'

describe('outputFile', () => {
  it('finds the path in front of a description', () => {
    expect(outputFile('docs/spec/01-規格.md — 正式規格 v1.0（API/錯誤/session/DB 契約）；下游依據')).toBe('docs/spec/01-規格.md')
    expect(outputFile('src/a.ts: the form')).toBe('src/a.ts')
    expect(outputFile('src/a.ts（表單）')).toBe('src/a.ts')
    expect(outputFile('`src/a.ts` - the form')).toBe('src/a.ts')
    expect(outputFile('README.md')).toBe('README.md')
  })
  it('leaves other lines alone', () => {
    expect(outputFile('commit abc123 @ task/1')).toBeNull()
    expect(outputFile('測試全部通過')).toBeNull()
    expect(outputFile('a.ts、b.ts')).toBeNull()
  })
})
