import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { Brand, clockText } from './Brand'

it('names the app', () => {
  expect(renderToStaticMarkup(<Brand />)).toContain('<h1>Team Work</h1>')
})

it('shows the time on a 24-hour clock and the date with its weekday', () => {
  const at = new Date(2026, 9, 31, 0, 5)
  expect(clockText(at, 'zh')).toEqual({ time: '00:05', date: '2026/10/31（週六）' })
  expect(clockText(at, 'en').time).toBe('00:05')
})
