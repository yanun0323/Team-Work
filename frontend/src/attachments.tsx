import { request } from './core/backend'
import type { Attachment } from './core/domain/types'
import { MOCK } from './core/mode'

export const MAX_ATTACHMENTS = 6
const MAX_IMAGE_BYTES = (5 << 20) / 4 * 3
const MAX_FILE_BYTES = 25 << 20
const isImageFile = (f: File) => /^image\/(png|jpeg|gif|webp)$/.test(f.type)
export const isImage = (a: Attachment) => /^image\/(png|jpeg|gif|webp)$/.test(a.mimeType ?? '') || /^data:image\/(png|jpeg|gif|webp);base64,/.test(a.url)
// Images over the providers' limit are shrunk when read, so they may start as large as any file.
export const attachable = (files: File[], room: number) => {
  const fit = files.filter((f) => f.size <= MAX_FILE_BYTES).slice(0, Math.max(room, 0))
  return { fit, refused: fit.length < files.length }
}

/** Draws the image at a size and encodes it; the real one uses a canvas, tests pass their own. */
export type Encode = (width: number, height: number, type: 'image/png' | 'image/jpeg', quality?: number) => Promise<Blob | null>

const MAX_SIDE = 2000
const MIN_SIDE = 400
const QUALITIES = [0.9, 0.8, 0.7, 0.6]

/**
 * Finds an encoding under `limit` bytes: the long side at 2000px as PNG (JPEG stays JPEG), then JPEG at falling
 * quality, then smaller and smaller until the long side would drop under 400px. Null when nothing fits.
 */
export async function fitImage(width: number, height: number, jpeg: boolean, encode: Encode, limit = MAX_IMAGE_BYTES): Promise<Blob | null> {
  let scale = Math.min(1, MAX_SIDE / Math.max(width, height))
  const size = () => [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))] as const
  if (!jpeg) {
    const png = await encode(...size(), 'image/png')
    if (png && png.size <= limit) return png
  }
  while (Math.max(width, height) * scale >= MIN_SIDE) {
    for (const q of QUALITIES) {
      const out = await encode(...size(), 'image/jpeg', q)
      if (out && out.size <= limit) return out
    }
    scale *= 0.75
  }
  return null
}

const loadImage = (f: File) => new Promise<HTMLImageElement>((done, fail) => {
  const url = URL.createObjectURL(f)
  const img = new Image()
  img.onload = () => { URL.revokeObjectURL(url); done(img) }
  img.onerror = () => { URL.revokeObjectURL(url); fail(new Error('Image could not be read')) }
  img.src = url
})

/** An image under the limit as is, or shrunk to fit; null when it cannot be. GIFs keep only their first frame. */
async function shrink(f: File): Promise<File | null> {
  if (f.size <= MAX_IMAGE_BYTES) return f
  const img = await loadImage(f)
  const encode: Encode = (width, height, type, quality) => new Promise((done) => {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) return done(null)
    // JPEG has no transparency: let it show white rather than black
    if (type === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height) }
    ctx.drawImage(img, 0, 0, width, height)
    canvas.toBlob(done, type, quality)
  })
  const out = await fitImage(img.naturalWidth, img.naturalHeight, f.type === 'image/jpeg', encode)
  if (!out) return null
  const base = (f.name || 'image').replace(/\.[^.]*$/, '')
  return new File([out], `${base}.${out.type === 'image/jpeg' ? 'jpg' : 'png'}`, { type: out.type })
}
export const splitAttachments = (attachments: Attachment[]) => ({
  images: attachments.filter(isImage), files: attachments.filter((a) => !isImage(a)),
})
const readDataURL = (f: File) => new Promise<string>((done, fail) => {
  const r = new FileReader()
  r.onload = () => done(String(r.result))
  r.onerror = () => fail(r.error)
  r.onabort = () => fail(new Error('File read aborted'))
  r.readAsDataURL(f)
})
// Images are shrunk before upload; history keeps URLs rather than their bytes.
// `refused` says some image could not be made small enough and was left out.
export const readAttachments = async (files: Iterable<File>): Promise<{ added: Attachment[], refused: boolean }> => {
  const read = await Promise.all([...files].map(async (f): Promise<Attachment | null> => {
    const name = f.name || 'attachment'
    if (!isImageFile(f)) return { name, url: MOCK ? await readDataURL(f) : (await request<{ url: string }>('POST', '/attachments', f)).url }
    const fit = await shrink(f)
    return fit && { name: fit.name || name, mimeType: fit.type, url: MOCK ? await readDataURL(fit) : (await request<{ url: string }>('POST', '/attachments', fit)).url }
  }))
  const added = read.filter((a): a is Attachment => a !== null)
  return { added, refused: added.length < read.length }
}

export function FileAttachment({ file }: { file: Attachment }) {
  return <a className="fx-file" href={file.url} download={file.name}><span aria-hidden="true">↓</span> {file.name}</a>
}
