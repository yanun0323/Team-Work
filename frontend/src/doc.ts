// What a file an employee handed on says. The prototype has no real files, so each is written from what
// the sub-task knows: the task, the step, the handoff. The same sub-task always reads the same.

import type { SubTask, Task } from './core/domain/types'

export type Doc = { lang: 'md' | 'code'; text: string }

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
    `## 交給下一步\n${h?.agent.next?.reason ?? '照流程交給下一步。'}`,
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
