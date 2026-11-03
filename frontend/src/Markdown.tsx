// Text people and models write, as Markdown. Raw HTML stays text and pictures from elsewhere don't load, as what a
// model wrote shouldn't reach out on its own. Only full web and mail addresses are links: anything relative would
// take the app itself away from where it is.

import ReactMarkdown, { type Components } from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import { saidParts, type Person, type SaidPart } from './mentions'
import { SaidChip } from './Said'

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
  // a mention, marked by remarkSaid
  span: ({ node: _node, children, ...rest }) => {
    const said = (rest as Record<string, unknown>)['data-said']
    return typeof said === 'string' ? <SaidChip part={JSON.parse(said) as SaidPart} /> : <span {...rest}>{children}</span>
  },
}

/** Written text, where a line break is one. */
const WRITTEN = [remarkGfm, remarkBreaks]
/** A file, where lines may be wrapped by hand and only a blank line ends a paragraph. */
const FILE = [remarkGfm]

interface MdNode { type: string; value?: string; children?: MdNode[]; data?: object }

/** Marks where the text, outside code and links, mentions one of people, a file or a skill, by the signs given. */
function remarkSaid({ people, signs }: { people: Person[]; signs: string }) {
  const walk = (node: MdNode) => {
    if (!node.children || node.type === 'link' || node.type === 'linkReference') return
    node.children = node.children.flatMap((child): MdNode[] => {
      if (child.type !== 'text' || !child.value) {
        walk(child)
        return [child]
      }
      return saidParts(child.value, people, signs).map((p) => p.kind
        ? { type: 'said', data: { hName: 'span', hProperties: { 'data-said': JSON.stringify(p) } }, children: [{ type: 'text', value: p.text }] }
        : { type: 'text', value: p.text })
    })
  }
  return (tree: MdNode) => walk(tree)
}

/**
 * `people` are who "@" can name, to show where the text mentions them as buttons. `signs` are the mentions to look
 * for: a reply's own "#" or "$" is as likely a number or a price, so it looks for "@" only, and a message the user
 * sent, written with the "#" and "$" menus, for all three.
 */
export function Markdown({ text, file, people = [], signs = '@' }: { text: string; file?: boolean; people?: Person[]; signs?: string }) {
  const plugins = file ? FILE : WRITTEN
  const looks = people.length > 0 || /[#$]/.test(signs)
  return (
    <div className="fx-md">
      <ReactMarkdown remarkPlugins={looks ? [...plugins, [remarkSaid, { people, signs }]] : plugins} components={COMPONENTS}>{text}</ReactMarkdown>
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
