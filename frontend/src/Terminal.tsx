// A real shell in the company's folder, drawn by xterm.js; `terminalSessions` keeps it. The company file keeps this
// mounted while another tab shows.

import { tr } from './core/i18n'
import { useEffect, useRef, useState } from 'react'
import { endTerminal, focusTerminal, showTerminal } from './terminalSessions'

export default function Terminal({ teamId, focusRequest, onLeave }: {
  teamId: string
  /** Each new value moves the keyboard into the terminal. */
  focusRequest: number
  /** The way out for the keyboard, as the terminal takes Tab and Esc for the shell. */
  onLeave: () => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const leave = useRef(onLeave)
  leave.current = onLeave
  const [run, setRun] = useState(0)
  const [ended, setEnded] = useState(false)

  useEffect(() => {
    if (!host.current) return
    return showTerminal(teamId, host.current, { ended: setEnded, leave: () => leave.current() })
  }, [teamId, run])

  useEffect(() => {
    if (focusRequest) focusTerminal(teamId)
  }, [teamId, focusRequest, run])

  return (
    <div className="fx-terminal">
      {ended && (
        <div className="fx-terminal-ended">
          <span>{tr('終端機已結束')}</span>
          <button type="button" className="fx-hit" onClick={() => { endTerminal(teamId); setRun((n) => n + 1) }}>{tr('重新開啟')}</button>
        </div>
      )}
      <div ref={host} className="fx-terminal-screen" title={tr('按 F6 離開終端機')} />
    </div>
  )
}
