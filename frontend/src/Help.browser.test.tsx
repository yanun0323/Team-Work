import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import './fonts.css'
import './fusion.css'
import { About } from './About'
import { Help } from './Help'

it('switches between the guide and version history in the same dialog', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  try {
    await act(async () => root.render(<Help leaving={false} onGone={() => {}} />))
    const [guide, notes, about] = host.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    expect(document.activeElement).toBe(guide)
    await act(() => userEvent.keyboard('{ArrowRight}'))
    expect(notes.getAttribute('aria-selected')).toBe('true')
    // Wait for the lazy tab to load and React to render it before picking a version.
    await act(async () => { await import('./ReleaseNotesSheet') })
    expect(host.querySelector('#fx-notes-version')).not.toBeNull()
    const older = host.querySelectorAll<HTMLButtonElement>('[aria-controls="fx-notes-panel"]')[1]
    await act(() => userEvent.click(older))
    expect(host.querySelector('#fx-notes-version')?.textContent).toBe(older.textContent)
    await act(() => userEvent.click(notes))
    await act(() => userEvent.keyboard('{ArrowRight}'))
    expect(document.activeElement).toBe(about)
    expect(about.textContent).toBe('關於')
    expect(host.querySelector('#fx-version')).not.toBeNull()
    expect(host.querySelector('#fx-license')).not.toBeNull()
    await act(() => userEvent.keyboard('{ArrowRight}'))
    expect(document.activeElement).toBe(guide)
    expect(host.querySelector('#fx-help-panel')).not.toBeNull()
  } finally {
    await act(async () => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  }
})

it('keeps the report link at its single-line height on a tall About page', async () => {
  const host = document.body.appendChild(document.createElement('div'))
  host.className = 'fx-help-tabpanel'
  host.style.height = '680px'
  const root = createRoot(host)
  try {
    await act(async () => root.render(<About />))
    const link = host.querySelector<HTMLAnchorElement>('a.fx-save')!
    const style = getComputedStyle(link)
    const height = parseFloat(style.lineHeight) + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
    expect(link.offsetHeight).toBeCloseTo(height, 0)
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})
