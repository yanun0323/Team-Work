import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'
import { ImageProviderField } from './Settings'
import { useStore } from './core/store'
import { type Prefs, usePrefs } from './prefs'

it('selects a particular provider and image model, never its chat-only models', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}')))
  const { world } = useStore.getState(), prefs = usePrefs.getState()
  const local = { id: 'a', name: 'Local A', kind: 'compatible' as const, auth: { kind: 'apiKey' as const, keyHint: '' }, baseUrl: '', models: ['sushi'], imageModels: ['image-sushi'] }
  const set = vi.fn((patch: Partial<Prefs>) => usePrefs.setState(patch))
  const box = document.createElement('div'), root = createRoot(box)
  document.body.append(box)
  try {
    useStore.setState({ world: { ...world, providers: { a: local, b: { ...local, id: 'b', name: 'Local B' } } } })
    usePrefs.setState({ imageProvider: '', imageModel: '', set })
    await act(async () => root.render(<ImageProviderField />))
    const button = box.querySelector('button')!
    await userEvent.click(button)
    const options = [...box.querySelectorAll<HTMLElement>('[role="option"]')]
    expect(options).toHaveLength(3)
    await userEvent.click(options.find(o => o.textContent?.includes('Local B · image-sushi'))!)
    expect(set).toHaveBeenCalledWith({ imageProvider: 'b', imageModel: 'image-sushi' })
    expect(button.textContent).toContain('Local B · image-sushi')
  } finally {
    await act(async () => root.unmount()); box.remove()
    useStore.setState({ world }); usePrefs.setState(prefs); vi.unstubAllGlobals()
  }
})
