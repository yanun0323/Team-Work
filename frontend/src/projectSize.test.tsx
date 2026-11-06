import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { CompanyTitle } from './Drawer'
import { randomLook } from './layout'
import { fmtBytes } from './projectSize'
import type { Team } from './core/domain/types'

it('writes sizes as Finder does, in steps of 1000 with at most one decimal', () => {
  expect(fmtBytes(0)).toBe('')
  expect(fmtBytes(-5)).toBe('')
  expect(fmtBytes(Number.NaN)).toBe('')
  expect(fmtBytes(512)).toBe('512 B')
  expect(fmtBytes(1000)).toBe('1 KB')
  expect(fmtBytes(1550)).toBe('1.6 KB')
  expect(fmtBytes(182_000_000)).toBe('182 MB')
  expect(fmtBytes(4_000_000_000)).toBe('4 GB')
  // just under a step rounds up into the next unit rather than reading "1000 KB"
  expect(fmtBytes(999_960)).toBe('1 MB')
  expect(fmtBytes(5e15)).toBe('5000 TB')
})

const team = { id: 't1', name: 'Acme', folder: '/p/acme', targetBranch: 'main' } as Team
const title = (bytes?: number) => renderToStaticMarkup(<CompanyTitle team={team} look={randomLook()} bytes={bytes}><h1>Acme</h1></CompanyTitle>)

it('shows the project size after the branch in the company header once it is known', () => {
  expect(title()).not.toContain('fx-size')
  expect(title(0)).not.toContain('fx-size')
  const html = title(182_000_000)
  expect(html).toMatch(/fx-branch.*<span class="fx-size"[^>]*>182 MB<\/span>/)
})
