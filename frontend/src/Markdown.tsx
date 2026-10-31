// Text people and models write, as Markdown. Raw HTML stays text and pictures from elsewhere don't load, as what a
// model wrote shouldn't reach out on its own. Only full web and mail addresses are links: anything relative would
// take the app itself away from where it is.

import ReactMarkdown, { type Components } from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'

const isWebLink = (href?: string) => !!href && /^(https?:|mailto:)/i.test(href)

const COMPONENTS: Components = {
  a: ({ href, children }) => isWebLink(href)
    ? <a href={href} target="_blank" rel="noreferrer">{children}</a>
    : <>{children}</>,
  img: ({ src, alt }) => typeof src === 'string' && isWebLink(src)
    ? <a href={src} target="_blank" rel="noreferrer">{alt || src}</a>
    : <>{alt}</>,
  // a wide table scrolls on its own, not the sheet
  table: ({ children }) => <div className="fx-md-table"><table>{children}</table></div>,
}

/** Written text, where a line break is one. */
const WRITTEN = [remarkGfm, remarkBreaks]
/** A file, where lines may be wrapped by hand and only a blank line ends a paragraph. */
const FILE = [remarkGfm]

export function Markdown({ text, file }: { text: string; file?: boolean }) {
  return (
    <div className="fx-md">
      <ReactMarkdown remarkPlugins={file ? FILE : WRITTEN} components={COMPONENTS}>{text}</ReactMarkdown>
    </div>
  )
}

const INLINE = ['strong', 'em', 'del', 'code', 'a']

/** One line of text among other things: its marks only, with no blocks. `noLinks` is for inside a button. */
export function MarkdownLine({ text, noLinks }: { text: string; noLinks?: boolean }) {
  return (
    <ReactMarkdown remarkPlugins={FILE} components={COMPONENTS} unwrapDisallowed
      allowedElements={noLinks ? INLINE.filter((x) => x !== 'a') : INLINE}>
      {text}
    </ReactMarkdown>
  )
}
