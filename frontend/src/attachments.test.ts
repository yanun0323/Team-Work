import { afterEach, describe, expect, it, vi } from 'vitest'
import { readAttachments, splitAttachments } from './attachments'
import { request } from './core/backend'

vi.mock('./core/backend', () => ({ request: vi.fn() }))
vi.mock('./core/mode', () => ({ MOCK: false }))
afterEach(() => vi.resetAllMocks())

describe('stored image attachments', () => {
  it('uploads image bytes once and keeps only the URL and type for preview and resend', async () => {
    const url = `/api/v1/attachments/${'a'.repeat(64)}`
    vi.mocked(request).mockResolvedValue({ url })
    const file = new File(['image bytes'], 'shot.png', { type: 'image/png' })
    const result = await readAttachments([file])
    expect(request).toHaveBeenCalledExactlyOnceWith('POST', '/attachments', file)
    expect(result).toEqual({ refused: false, added: [{ name: 'shot.png', url, mimeType: 'image/png' }] })
    const text = { name: 'notes.txt', url: '/api/v1/attachments/text' }
    const legacy = { name: 'old.png', url: 'data:image/png;base64,AAAA' }
    expect(splitAttachments([...result.added, text, legacy])).toEqual({ images: [...result.added, legacy], files: [text] })
  })

  it('reports an upload failure instead of returning a broken image reference', async () => {
    vi.mocked(request).mockRejectedValue(new Error('upload failed'))
    await expect(readAttachments([new File(['image'], 'shot.png', { type: 'image/png' })])).rejects.toThrow('upload failed')
  })
})
