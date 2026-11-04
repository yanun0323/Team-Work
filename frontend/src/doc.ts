// What an employee handed on. `outputFile` reads which file a handoff line names. `docOf` is for the simulator
// only: it has no real files, so each is written from what the sub-task knows, and always reads the same.

import type { SubTask, Task } from './core/domain/types'

export type Doc = { lang: 'md' | 'code'; text: string }

/** The file a handoff line names, as in "docs/spec.md — the spec". Null when the line is not about one file. */
export function outputFile(line: string): string | null {
  const head = line.split(/\s[—–-]\s|[：（]|:\s|\s\(/)[0].trim().replace(/^`|`$/g, '')
  return /^[^\s、，,]+$/.test(head) && /[./]/.test(head) ? head : null
}

export function docOf(task: Task, step: string, sub: SubTask, path: string): Doc {
  const h = sub.handoff
  const name = path.split('/').pop() ?? path
  if (!/\.mdx?$/.test(path)) return { lang: 'code', text: name.includes('.test.') ? testFile(task, name) : codeFile(task, name) }
  const list = (xs: string[]) => xs.map((x) => `- ${x}`).join('\n')
  const parts = [
    `# ${step}：${task.title}`,
    h ? h.human.headline : '',
    task.description && `## 需求\n${task.description}`,
    h?.human.did.length ? `## 做了什麼\n${list(h.human.did)}` : '',
    h?.agent.decisions.length ? `## 決定\n${list(h.agent.decisions)}` : '',
    h?.agent.open.length ? `## 還沒確定\n${list(h.agent.open)}` : '',
    `## 交給下一步\n${h?.agent.next?.reason ?? '照任務藍圖交給下一步。'}`,
  ]
  return { lang: 'md', text: parts.filter(Boolean).join('\n\n') }
}

const component = (name: string) => name.replace(/\..*$/, '')

function codeFile(task: Task, name: string) {
  const c = component(name)
  return `// #${task.number} ${task.title}
import { useState } from 'react'

export function ${c}({ items }: { items: string[] }) {
  const [open, setOpen] = useState(false)
  return (
    <nav className="${c.toLowerCase()}">
      <button onClick={() => setOpen(!open)} aria-expanded={open}>選單</button>
      {open && (
        <ul>
          {items.map((x) => <li key={x}>{x}</li>)}
        </ul>
      )}
    </nav>
  )
}
`
}

function testFile(task: Task, name: string) {
  const c = component(name)
  return `// #${task.number} ${task.title}
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ${c} } from './${c}'

test('opens and closes', async () => {
  render(<${c} items={['首頁', '商品']} />)
  await userEvent.click(screen.getByRole('button', { name: '選單' }))
  expect(screen.getByText('商品')).toBeVisible()
})
`
}
