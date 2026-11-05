import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { MadeCard } from './TaskCard'
import { useStore } from './core/store'

it('shows what an employee created in a chat by its kind and name, and nothing once it is gone', () => {
  const w = useStore.getState().world
  const flow = Object.values(w.workflows)[0]
  // the server render reads the store's initial state
  Object.assign(useStore.getInitialState(), useStore.getState())
  expect(renderToStaticMarkup(<MadeCard made={{ kind: 'workflow', id: flow.id }} />))
    .toContain(`<span class="fx-task-title"><span class="fx-task-no">任務藍圖</span>${flow.name}</span>`)
  expect(renderToStaticMarkup(<MadeCard made={{ kind: 'blueprint', id: 'gone' }} />)).toBe('')
})
