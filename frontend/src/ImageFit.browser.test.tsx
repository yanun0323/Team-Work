import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { userEvent } from 'vitest/browser'
import './core/store'
import { FileBody } from './FileSheets'
import './fusion.css'

it('enlarges a small picture to the remaining height, toggles width, and resets for another file', async () => {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const draw = async (path: string) => act(async () => root.render(
    <div className="fx-detail-body" style={{ width: 400, height: 240, padding: 0 }}>
      <header style={{ height: 18 }} />
      <FileBody teamId="t" path={path} state={{ status: 'ready' }} text={'<svg xmlns="http://www.w3.org/2000/svg" width="20" height="5"/>'} />
    </div>,
  ))
  try {
    await draw('first.svg')
    const img = host.querySelector('img')!
    await img.decode()
    expect(img.height).toBe(200)
    expect(img.width).toBe(800)
    await userEvent.click(img)
    expect(img.width).toBe(400)
    expect(img.height).toBe(100)
    await userEvent.click(img)
    expect(img.height).toBe(200)
    host.querySelector('button')!.focus()
    await userEvent.keyboard('{Enter}')
    expect(img.height).toBe(100)
    await userEvent.keyboard('{Enter}')
    expect(img.height).toBe(200)
    await userEvent.click(img)
    await draw('next.svg')
    expect(host.querySelector('img')!.height).toBe(200)
  } finally {
    await act(async () => root.unmount())
    host.remove()
  }
})
