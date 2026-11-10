// Ask the system's file browser for a folder.
//
// A web page is never told where a picked folder is, only its name. So the Mac app opens its own dialog and gives
// the full path; in a browser the backend, on the same computer, does. Mock mode has no backend and makes up a
// place for the name instead.

import { request } from './core/backend'
import { MOCK } from './core/mode'
import { remoteIsland } from './core/island'
import { remoteWindowReason } from './core/ops'

interface DirectoryPicker {
  showDirectoryPicker?: (options?: { id?: string; mode?: 'read' | 'readwrite' }) => Promise<{ name: string }>
}

/** The path of the folder picked, or null when the dialog was closed without one. Throws what went wrong. */
export async function pickFolder(typed: string): Promise<string | null> {
  // on another island either dialog picks wrong: the backend's opens on that computer, the app's picks a path here
  if (remoteIsland()) throw new Error(remoteWindowReason())
  const app = (window as unknown as { webkit?: { messageHandlers?: { pickFolder?: { postMessage: (x: null) => Promise<string> } } } }).webkit?.messageHandlers?.pickFolder
  if (app) return (await app.postMessage(null)) || null
  if (!MOCK) return (await request<{ path: string }>('POST', '/folder-picker')).path || null
  const name = await pickFolderName()
  return name && pickedPath(typed, name)
}

/** The name of the folder picked, or null when the browser was closed without one. */
async function pickFolderName(): Promise<string | null> {
  const picker = (window as Window & DirectoryPicker).showDirectoryPicker
  if (picker) {
    try {
      return (await picker({ id: 'project', mode: 'read' })).name
    } catch {
      // closed without picking, or not allowed
      return null
    }
  }
  // Safari and Firefox: a folder upload field, which names the folder in each file's path. An empty
  // folder has no files, so no name.
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.webkitdirectory = true
    input.hidden = true
    // in the page, as a field that isn't can be dropped before it reports the choice
    document.body.append(input)
    const finish = (name: string | null) => {
      input.remove()
      resolve(name)
    }
    input.addEventListener('change', () => finish(input.files?.[0]?.webkitRelativePath.split('/')[0] || null), { once: true })
    input.addEventListener('cancel', () => finish(null), { once: true })
    input.click()
  })
}

/** Where the picked folder goes: beside the folder already typed, else under ~/code/. */
export function pickedPath(typed: string, name: string) {
  const parent = typed.trim().replace(/[/\\]+$/, '').match(/^(.*[/\\])[^/\\]+$/)?.[1]
  return `${parent ?? '~/code/'}${name}`
}
