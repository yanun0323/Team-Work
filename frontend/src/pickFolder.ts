// Ask the system's file browser for a folder.
//
// A web page is never told where a picked folder is, only its name, so the prototype puts the name under
// the folder already typed (or under ~/code/). The desktop app reads the full path instead.

interface DirectoryPicker {
  showDirectoryPicker?: (options?: { id?: string; mode?: 'read' | 'readwrite' }) => Promise<{ name: string }>
}

/** The name of the folder picked, or null when the browser was closed without one. */
export async function pickFolderName(): Promise<string | null> {
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
    input.addEventListener('change', () => resolve(input.files?.[0]?.webkitRelativePath.split('/')[0] || null), { once: true })
    input.addEventListener('cancel', () => resolve(null), { once: true })
    input.click()
  })
}

/** Where the picked folder goes: beside the folder already typed, else under ~/code/. */
export function pickedPath(typed: string, name: string) {
  const parent = typed.trim().replace(/[/\\]+$/, '').match(/^(.*[/\\])[^/\\]+$/)?.[1]
  return `${parent ?? '~/code/'}${name}`
}
