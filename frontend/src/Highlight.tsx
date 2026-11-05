// Code in colour: a code file shown as it is, and code blocks in Markdown, both by highlight.js's common languages.
// It colours as it draws, so nothing flashes uncoloured first; a language it does not know stays plain.

import { toJsxRuntime } from 'hast-util-to-jsx-runtime'
import { common, createLowlight } from 'lowlight'
import { useMemo, type ChangeEvent, type RefObject } from 'react'
import { Fragment, jsx, jsxs } from 'react/jsx-runtime'

export const LANGUAGES = common
const lowlight = createLowlight(LANGUAGES)

/** Past this many characters a file is shown plain: colouring it would hold the page up. */
const MAX_COLOURED = 200_000
/** Less for a file being typed in, as it is coloured again at each key. */
const MAX_COLOURED_TYPING = 50_000

/** Files known by their whole name, not an extension. */
const NAMES: Record<string, string> = {
  makefile: 'makefile', gnumakefile: 'makefile', '.zshrc': 'bash', '.bashrc': 'bash', '.bash_profile': 'bash', '.profile': 'bash',
  '.gitignore': 'bash', '.env': 'ini', '.editorconfig': 'ini', '.npmrc': 'ini', 'go.mod': 'go', 'go.sum': 'plaintext',
}

/** The language a file's name says it is in, if highlight.js knows it. */
export function languageOf(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  if (NAMES[name]) return NAMES[name]
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return undefined
  const ext = name.slice(dot + 1)
  return lowlight.registered(ext) ? ext : undefined
}

/** text coloured as lang, or as it is with no lang or past max characters. */
const coloured = (lang: string | undefined, text: string, max: number) => lang && text.length <= max
  ? toJsxRuntime(lowlight.highlight(lang, text), { Fragment, jsx, jsxs })
  : text

/** A code file, coloured by its name's language when there is one. */
export function CodeFile({ path, text }: { path: string; text: string }) {
  const lang = languageOf(path)
  return <pre className="fx-doc-code fx-doc-raw"><code className={lang ? `hljs language-${lang}` : undefined}>{coloured(lang, text, MAX_COLOURED)}</code></pre>
}

/**
 * A code file being typed in, dark and coloured as it is shown: the text box is see-through, laid over the same text
 * coloured, both wrapping alike, so only its caret and selection show.
 */
export function CodeEditor({ path, value, onChange, box, label }: {
  path: string; value: string; onChange: (e: ChangeEvent<HTMLTextAreaElement>) => void
  box: RefObject<HTMLTextAreaElement | null>; label: string
}) {
  const lang = languageOf(path)
  const view = useMemo(() => coloured(lang, value, MAX_COLOURED_TYPING), [lang, value])
  return (
    <div className="fx-code-edit">
      {/* a last line break is drawn only with something after it, and the box would show that empty line */}
      <pre className="fx-code-edit-view" aria-hidden="true"><code className={lang ? `hljs language-${lang}` : undefined}>{view}{'\n'}</code></pre>
      <textarea ref={box} className="fx-code-edit-box" value={value} spellCheck={false} autoCapitalize="off" autoCorrect="off"
        aria-label={label} onChange={onChange} />
    </div>
  )
}
