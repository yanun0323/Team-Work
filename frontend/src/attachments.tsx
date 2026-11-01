import type { Attachment } from './core/domain/types'

export const MAX_ATTACHMENTS = 6
const MAX_BYTES = (5 << 20) / 4 * 3
export const isImage = (a: Attachment) => /^data:image\/(png|jpeg|gif|webp);base64,/.test(a.url)
export const attachable = (files: File[], room: number) => {
  const fit = files.filter((f) => f.size <= MAX_BYTES).slice(0, Math.max(room, 0))
  return { fit, refused: fit.length < files.length }
}
export const splitAttachments = (attachments: Attachment[]) => ({
  images: attachments.filter(isImage), files: attachments.filter((a) => !isImage(a)),
})
export const readAttachments = (files: Iterable<File>): Promise<Attachment[]> =>
  Promise.all([...files].map((f) => new Promise<Attachment>((done, fail) => {
    const r = new FileReader()
    r.onload = () => done({ name: f.name || 'attachment', url: String(r.result) })
    r.onerror = () => fail(r.error)
    r.onabort = () => fail(new Error('File read aborted'))
    r.readAsDataURL(f)
  })))

export function FileAttachment({ file }: { file: Attachment }) {
  return <a className="fx-file" href={file.url} download={file.name}><span aria-hidden="true">↓</span> {file.name}</a>
}
