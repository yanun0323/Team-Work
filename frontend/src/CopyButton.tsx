import { useEffect, useState } from 'react'
import { tr } from './core/i18n'

/** Copies a message's text, showing a tick for a moment after. */
export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  const label = copied ? tr('已複製') : tr('複製這則訊息')
  return (
    <button type="button" className="fx-chat-edit fx-hit" aria-label={label} title={copied ? tr('已複製') : tr('複製')}
      onClick={() => navigator.clipboard.writeText(text).then(() => setCopied(true), () => {})}>
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
        {copied
          ? <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
          : <>
            <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M10.5 3.5V3a1 1 0 0 0-1-1H3.5a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          </>}
      </svg>
    </button>
  )
}
