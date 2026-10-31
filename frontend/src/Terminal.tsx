// A real shell in the company's folder, drawn by xterm.js. It lives as long as this component: the company file
// keeps it mounted while another tab shows, and it ends when the file closes.

import { FitAddon } from '@xterm/addon-fit'
import { Terminal as XTerm } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef, useState } from 'react'

export default function Terminal({ teamId, focusRequest, onLeave }: {
  teamId: string
  /** Each new value moves the keyboard into the terminal. */
  focusRequest: number
  /** The way out for the keyboard, as the terminal takes Tab and Esc for the shell. */
  onLeave: () => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const term = useRef<XTerm | null>(null)
  const leave = useRef(onLeave)
  leave.current = onLeave
  const [run, setRun] = useState(0)
  const [ended, setEnded] = useState(false)

  useEffect(() => {
    const el = host.current
    if (!el) return
    const t = new XTerm({
      cursorBlink: true, fontSize: 13, scrollback: 5000,
      fontFamily: 'ui-monospace, "SF Mono", Menlo, "PingFang TC", monospace',
      theme: { background: '#18181b', foreground: '#e8e6df', cursor: '#e8e6df', red: '#ff6b6b' },
    })
    const fit = new FitAddon()
    t.loadAddon(fit)
    t.open(el)
    fit.fit()
    term.current = t
    t.attachCustomKeyEventHandler((e) => {
      if (e.key !== 'F6') return true
      if (e.type === 'keydown') leave.current()
      return false
    })

    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/v1/teams/${teamId}/terminal?cols=${t.cols}&rows=${t.rows}`)
    socket.binaryType = 'arraybuffer'
    socket.onmessage = (m) => t.write(new Uint8Array(m.data as ArrayBuffer))
    socket.onclose = () => setEnded(true)
    const send = (data: string | Uint8Array<ArrayBuffer>) => { if (socket.readyState === WebSocket.OPEN) socket.send(data) }
    const encoder = new TextEncoder()
    t.onData((d) => send(encoder.encode(d)))
    t.onBinary((d) => send(Uint8Array.from(d, (c) => c.charCodeAt(0))))
    t.onResize(({ cols, rows }) => send(JSON.stringify({ cols, rows })))
    // a hidden tab has no size to fit to
    const size = new ResizeObserver(() => { if (el.clientWidth > 0) fit.fit() })
    size.observe(el)
    return () => {
      size.disconnect()
      socket.onclose = null
      socket.close()
      t.dispose()
      term.current = null
    }
  }, [teamId, run])

  useEffect(() => {
    if (focusRequest) term.current?.focus()
  }, [focusRequest, run])

  return (
    <div className="fx-terminal">
      <div ref={host} className="fx-terminal-screen" title="按 F6 離開終端機" />
      {ended && (
        <div className="fx-terminal-ended">
          <span>終端機已結束</span>
          <button type="button" className="fx-hit" onClick={() => { setEnded(false); setRun((n) => n + 1) }}>重新開啟</button>
        </div>
      )}
    </div>
  )
}

