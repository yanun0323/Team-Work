// Under `make dev-mock` there is no computer to run a shell on: this stands in for the terminal's connection, echoing
// what is typed and answering a few commands from the sample project, so the tab can be shown and tried.

import { projectTree } from './core/domain/sim'

/** What a terminal session needs of its connection: a WebSocket, or this. */
export interface ShellSocket {
  readonly readyState: number
  binaryType: BinaryType
  onopen: ((e: Event) => void) | null
  onmessage: ((m: MessageEvent) => void) | null
  onclose: ((e: CloseEvent) => void) | null
  send(data: string | Uint8Array<ArrayBuffer>): void
  close(): void
}

/** The shell's answer to a command line, or null for one it does not know; `home` is the airport's, at ~. */
export function answer(line: string, home = false): string | null {
  const cmd = line.trim().replace(/\s+/g, ' ')
  if (cmd === '') return ''
  if (home && cmd === 'pwd') return '~'
  if (home && cmd === 'ls') return 'Desktop  Documents  Downloads  code'
  if (home && cmd.startsWith('git ')) return 'fatal: not a git repository (or any of the parent directories): .git'
  if (cmd === 'pwd') return '~/code/acme-shop'
  if (cmd === 'ls') return projectTree('').entries.filter((e) => !e.name.startsWith('.')).map((e) => e.name).join('  ')
  if (cmd === 'git status') return 'On branch main\r\nYour branch is up to date with \'origin/main\'.\r\n\r\nnothing to commit, working tree clean'
  if (cmd === 'git branch') return '* main\r\n  task/1\r\n  task/3'
  if (cmd.startsWith('git log')) return 'a41c9e2 (HEAD -> main) feat: search products by keyword\r\n7d03b1f fix: keep the cart count after a reload\r\n2f8e6c0 feat: seasonal banner on the home page'
  if (cmd.startsWith('echo ')) return cmd.slice(5)
  return null
}

export function mockShell(home = false): ShellSocket {
  const PROMPT = `\x1b[1mme@mac\x1b[0m ${home ? '~' : 'acme-shop'} % `
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let line = ''
  let open = true
  const s: ShellSocket = {
    readyState: WebSocket.OPEN,
    binaryType: 'arraybuffer',
    onopen: null,
    onmessage: null,
    onclose: null,
    send(data) {
      // a string is the terminal's new size
      if (!open || typeof data === 'string') return
      let out = ''
      for (const c of decoder.decode(data)) {
        if (c === '\r') {
          const said = answer(line, home)
          out += '\r\n'
          if (said === null) out += `zsh: command not found: ${line.trim().split(' ')[0]}\r\n`
          else if (said) out += `${said}\r\n`
          out += PROMPT
          line = ''
        } else if (c === '\x7f') {
          if (line) {
            line = line.slice(0, -1)
            out += '\b \b'
          }
        } else if (c >= ' ') {
          line += c
          out += c
        }
      }
      write(out)
    },
    close() {
      open = false
    },
  }
  const write = (text: string) => {
    if (text) setTimeout(() => s.onmessage?.(new MessageEvent('message', { data: encoder.encode(text).buffer })))
  }
  setTimeout(() => {
    s.onopen?.(new Event('open'))
    write(PROMPT)
  })
  return s
}
