import { request } from './core/backend'
import type { Attachment } from './core/domain/types'
import { MOCK } from './core/mode'

export const MAX_ATTACHMENTS = 6
const MAX_IMAGE_BYTES = (5 << 20) / 4 * 3
const MAX_FILE_BYTES = 25 << 20
const isImageFile = (f: File) => /^image\/(png|jpeg|gif|webp)$/.test(f.type)
export const isImage = (a: Attachment) => /^data:image\/(png|jpeg|gif|webp);base64,/.test(a.url)
export const attachable = (files: File[], room: number) => {
  const fit = files.filter((f) => f.size <= (isImageFile(f) ? MAX_IMAGE_BYTES : MAX_FILE_BYTES)).slice(0, Math.max(room, 0))
  return { fit, refused: fit.length < files.length }
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
// Images go to the model inline; other files wait on the backend's disk.
export const readAttachments = (files: Iterable<File>): Promise<Attachment[]> =>
  Promise.all([...files].map(async (f) => ({
    name: f.name || 'attachment',
    url: isImageFile(f) || MOCK ? await readDataURL(f) : (await request<{ url: string }>('POST', '/attachments', f)).url,
  })))

export function FileAttachment({ file }: { file: Attachment }) {
  return <a className="fx-file" href={file.url} download={file.name}><span aria-hidden="true">↓</span> {file.name}</a>
}
