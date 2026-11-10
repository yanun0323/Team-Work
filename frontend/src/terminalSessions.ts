// The shells of the company terminals, and the airport's (teamId ''). A session belongs here rather than to the screen, so that with 保留終端機
// on it runs while nothing shows it, and goes on where it was when its company opens again. Closing the app
// closes the connections, which ends the shells.

import { FitAddon } from '@xterm/addon-fit'
import { Terminal as XTerm } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { MOCK } from './core/mode'
import { useStore } from './core/store'
import { apiBase, socketUrl, useIsland } from './core/island'
import { mockShell, type ShellSocket } from './mockShell'
import { usePrefs } from './prefs'
import { terminalKey } from './terminalKeys'

interface Session {
  term: XTerm
  socket: ShellSocket
  /** What xterm draws into; moved in and out of the page whole. */
  el: HTMLDivElement
  fit: FitAddon
  shown: boolean
  ended: boolean
  onEnded: (ended: boolean) => void
  onLeave: () => void
}

const sessions = new Map<string, Session>()

/** Where a company's shell is asked for; the airport's (teamId '') starts at home and has its own. */
export const terminalPath = (teamId: string) => `${apiBase()}${terminalRoute(teamId)}`
const terminalRoute = (teamId: string) => (teamId ? `/teams/${teamId}/terminal` : '/airport/terminal')

function start(teamId: string, host: HTMLElement): Session {
  const el = document.createElement('div')
  el.className = 'fx-terminal-xterm'
  host.append(el)
  const term = new XTerm({
    cursorBlink: true, fontSize: 13, scrollback: 5000,
    // Option is Alt for the shell and its programs, as they expect, not the Mac's special characters
    macOptionIsMeta: true,
    fontFamily: 'ui-monospace, "SF Mono", Menlo, "PingFang TC", monospace',
    theme: { background: '#18181b', foreground: '#e8e6df', cursor: '#e8e6df', red: '#ff6b6b' },
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.open(el)
  fit.fit()
  const socket: ShellSocket = MOCK
    ? mockShell(!teamId)
    : new WebSocket(socketUrl(`${terminalRoute(teamId)}?cols=${term.cols}&rows=${term.rows}`))
  socket.binaryType = 'arraybuffer'
  const s: Session = { term, socket, el, fit, shown: true, ended: false, onEnded: () => {}, onLeave: () => {} }
  socket.onmessage = (m) => term.write(new Uint8Array(m.data as ArrayBuffer))
  socket.onclose = () => {
    s.ended = true
    s.onEnded(true)
  }
  const send = (data: string | Uint8Array<ArrayBuffer>) => { if (socket.readyState === WebSocket.OPEN) socket.send(data) }
  const encoder = new TextEncoder()
  // As if typed: the shell picks it up once its startup files have run, and stays open afterwards.
  const command = usePrefs.getState().terminalCommand.trim()
  socket.onopen = () => { if (command) send(encoder.encode(`${command}\r`)) }
  term.onData((d) => send(encoder.encode(d)))
  term.onBinary((d) => send(Uint8Array.from(d, (c) => c.charCodeAt(0))))
  term.onResize(({ cols, rows }) => send(JSON.stringify({ cols, rows })))
  term.attachCustomKeyEventHandler((e) => {
    if (e.key === 'F6') {
      if (e.type === 'keydown') s.onLeave()
      return false
    }
    const key = terminalKey(e)
    if (!key) return true
    // Command+Left would otherwise also go back a page in the browser. Every phase is claimed, or the
    // keypress of Shift+Enter would still reach the shell as a plain Enter.
    e.preventDefault()
    if (e.type !== 'keydown') return false
    if ('send' in key) send(encoder.encode(key.send))
    else if (key.run === 'clear') term.clear()
    else if (key.run === 'scrollTop') term.scrollToTop()
    else term.scrollToBottom()
    return false
  })
  return s
}

function close(teamId: string) {
  const s = sessions.get(teamId)
  if (!s) return
  sessions.delete(teamId)
  s.socket.onclose = null
  s.socket.close()
  s.term.dispose()
  s.el.remove()
}

let watching = false

/** What ends a session nobody is looking at: its company closing, or 保留終端機 being turned off. */
function watch() {
  if (watching) return
  watching = true
  useStore.subscribe((state, before) => {
    if (state.world.teams === before.world.teams) return
    // the airport's ('') is no company and stays
    for (const id of [...sessions.keys()]) if (id && !state.world.teams[id]) close(id)
  })
  // leaving an island ends its shells, kept or not: they run on that computer, and its ids are its own
  useIsland.subscribe((state, before) => {
    if (state.island?.id === before.island?.id) return
    for (const id of [...sessions.keys()]) close(id)
  })
  usePrefs.subscribe((prefs) => {
    if (prefs.keepTerminals) return
    for (const [id, s] of [...sessions]) if (!s.shown) close(id)
  })
}

/**
 * Shows a company's terminal in `host`, starting its shell or going back to the one kept for it. The returned
 * function takes it off the page, which ends the shell unless 保留終端機 is on.
 */
export function showTerminal(teamId: string, host: HTMLElement, on: { ended: (ended: boolean) => void; leave: () => void }) {
  watch()
  let s = sessions.get(teamId)
  if (s) host.append(s.el)
  else sessions.set(teamId, s = start(teamId, host))
  const session = s
  session.shown = true
  session.onEnded = on.ended
  session.onLeave = on.leave
  on.ended(session.ended)
  session.fit.fit()
  session.term.scrollToBottom()
  // a hidden tab has no size to fit to
  const size = new ResizeObserver(() => { if (host.clientWidth > 0) session.fit.fit() })
  size.observe(host)
  return () => {
    size.disconnect()
    session.onEnded = () => {}
    session.onLeave = () => {}
    session.shown = false
    session.el.remove()
    if (!usePrefs.getState().keepTerminals) close(teamId)
  }
}

export const focusTerminal = (teamId: string) => sessions.get(teamId)?.term.focus()

/** Ends a company's shell, so that the next `showTerminal` starts a new one. */
export const endTerminal = close
