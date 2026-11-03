import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { TagAlerts } from './World'

it('puts a dot on the airport tag when the app has found an update', () => {
  expect(renderToStaticMarkup(<TagAlerts unreadChats={0} waitingTasks={0} />)).toBe('')
  const html = renderToStaticMarkup(<TagAlerts unreadChats={0} waitingTasks={0} update />)
  expect(html).toContain('fx-tag-alert-update')
  expect(html).toContain('有新版本')
})
