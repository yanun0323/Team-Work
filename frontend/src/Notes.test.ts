import { describe, expect, it } from 'vitest'
import { noteLines } from './Notes'

describe('noteLines', () => {
  it('reads each line\'s block off its start and keeps its inline marks', () => {
    const text = '# 本週\n\n- [x] 合併 **登入**\n- [ ] 寫測試\n* 看 [文件](https://example.com)\n1. 第一\n> 引言\n```sh\nmake test\n```\n平常 `碼`'
    expect(noteLines(text, 10)).toEqual([
      { kind: 'heading', text: '本週' },
      { kind: 'done', text: '合併 **登入**' },
      { kind: 'todo', text: '寫測試' },
      { kind: 'item', text: '看 [文件](https://example.com)' },
      { kind: 'number', mark: '1.', text: '第一' },
      { kind: 'quote', text: '引言' },
      { kind: 'code', text: 'make test' },
      { kind: 'text', text: '平常 `碼`' },
    ])
  })

  it('stops at the count, and has nothing for empty notes', () => {
    expect(noteLines('a\nb\nc', 2).map((l) => l.text)).toEqual(['a', 'b'])
    expect(noteLines('  \n\n')).toEqual([])
  })
})
