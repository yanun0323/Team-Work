// The 展開子介面 preference: the detail sheets cover the company file, short of a strip on the right, instead of the
// left half of the window. The drawer under them is covered as a sheet under another is: what is on it is inert, and the
// strip that shows is one button that puts the sheets away.
// The setting lives under the airport's preferences; the corner of every sheet turns it on and off too.

import { tr } from './core/i18n'
import { usePrefs } from './prefs'

/** The class a detail sheet adds while the preference is on. */
export const useWideClass = () => (usePrefs((s) => s.wideSheets) ? ' fx-wide' : '')

/**
 * Whether a drawer lies under wide sheets: `open` is whether it has sheets out, not counting those already fading
 * away, so the cover goes the moment the last one is put away.
 */
export const useUnderWide = (open: boolean) => usePrefs((s) => s.wideSheets) && open

/** Laid over a drawer under wide sheets, as over a covered sheet: it shades on hover, and a click puts the sheets away. */
export function WideCover({ onClick }: { onClick: () => void }) {
  return <button type="button" className="fx-detail-cover fx-wide-cover" aria-label={tr('收起上面那張，回到這張')} onClick={onClick} />
}

/** A sheet's lower right corner: arrows pointing out turn the preference on, pointing in turn it off. */
export function WideTool() {
  const wide = usePrefs((s) => s.wideSheets)
  const set = usePrefs((s) => s.set)
  return (
    <button type="button" className="fx-tool fx-wide-tool fx-hit" aria-pressed={wide} aria-label={tr('展開子介面')} title={tr('展開子介面')}
      onClick={() => set({ wideSheets: !wide })}>
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        {wide
          ? <path d="M2.5 6.5h4v-4M13.5 9.5h-4v4M6.5 6.5 2 2M9.5 9.5 14 14" />
          : <path d="M2.5 6.5v-4h4M13.5 9.5v4h-4M2.5 2.5 7 7M13.5 13.5 9 9" />}
      </svg>
    </button>
  )
}
