// Text people and models write, as Markdown. Raw HTML stays text and pictures from elsewhere don't load, as what a
// model wrote shouldn't reach out on its own. Only full web and mail addresses are links: anything relative would
// take the app itself away from where it is. A file opened from a folder (a project's, a handoff's, the airport's) is
// the exception: its HTML is drawn, cleaned of scripts and styles, and its own pictures load from beside it.

import { useEffect, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import type { Pluggable } from 'unified'
import { tr } from './core/i18n'
import { LANGUAGES } from './Highlight'
import { ID_WORD, saidParts, type IdLookup, type Person, type SaidPart } from './mentions'
import { SaidChip } from './Said'

const isWebLink = (href?: string) => !!href && /^(https?:|mailto:)/i.test(href)

/** A picture from elsewhere, as a link to it; any other, as its words. */
function Picture({ src, alt }: { src?: unknown; alt?: string }) {
  return typeof src === 'string' && isWebLink(src)
    ? <a href={src} target="_blank" rel="noreferrer">{alt || src}</a>
    : <>{alt}</>
}

/** A code block, with a button in its corner on hover to copy what it says, showing a tick for a moment after. */
function CodeBlock({ children }: { children?: ReactNode }) {
  const pre = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  const copy = () => {
    // what it says, without the colours: its text as shown, less the line end Markdown leaves on the last line
    const text = (pre.current?.textContent ?? '').replace(/\n$/, '')
    navigator.clipboard.writeText(text).then(() => setCopied(true), () => {})
  }
  const label = copied ? tr('已複製') : tr('複製程式碼')
  return (
    <div className="fx-md-code">
      <pre ref={pre}>{children}</pre>
      <button type="button" className="fx-md-copy fx-hit" aria-label={label} title={label} onClick={copy}>
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
          {copied
            ? <path d="M3 8.5l3 3 7-7" />
            : <>
              <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
              <path d="M10.5 3.5V3a1 1 0 0 0-1-1H3.5a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h.5" />
            </>}
        </svg>
      </button>
    </div>
  )
}

const COMPONENTS: Components = {
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
  a: ({ href, children }) => isWebLink(href)
    ? <a href={href} target="_blank" rel="noreferrer">{children}</a>
    : <>{children}</>,
  img: ({ src, alt }) => <Picture src={src} alt={alt} />,
  // a wide table scrolls on its own, not the sheet
  table: ({ children }) => <div className="fx-md-table"><table>{children}</table></div>,
  // a mention, marked by remarkSaid
  span: ({ node: _node, children, ...rest }) => {
    const said = (rest as Record<string, unknown>)['data-said']
    return typeof said === 'string' ? <SaidChip part={JSON.parse(said) as SaidPart} /> : <span {...rest}>{children}</span>
  },
}

/** Where a file's relative pictures are: the folder it is in ("" at the top), and the address a path there loads from. */
export interface InProject { dir: string; imageUrl: (path: string) => string }

/** A relative address seen from dir, as a path in the project; null for one with a scheme, or one leaving the project. */
export function projectPath(dir: string, src: string): string | null {
  if (/^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(src)) return null
  const at = src.split(/[?#]/)[0]
  const parts = at.startsWith('/') ? [] : dir.split('/').filter(Boolean)
  let decoded: string
  try { decoded = decodeURIComponent(at) } catch { return null }
  for (const part of decoded.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') { if (!parts.length) return null; parts.pop() } else parts.push(part)
  }
  return parts.length ? parts.join('/') : null
}

/** The components for a file from a folder: its own pictures load from beside it, at the size it gives them. */
function projectComponents({ dir, imageUrl }: InProject): Components {
  return {
    ...COMPONENTS,
    img: ({ src, alt, width, height }) => {
      const path = typeof src === 'string' ? projectPath(dir, src) : null
      return path
        ? <img className="fx-md-img" src={imageUrl(path)} alt={alt ?? ''} width={width} height={height} />
        : <Picture src={src} alt={alt} />
    },
  }
}

interface MdNode { type: string; value?: string; url?: string; children?: MdNode[]; data?: object; position?: { start: { offset?: number } } }

/** CJK characters and full-width punctuation, which GFM would take into a bare address up to the next space. */
const WIDE = /[⺀-鿿豈-﫿︰-﹏＀-￯]/

/** Drops what GFM drops from the end of a bare address: closing marks, and a ")" without its "(". */
function trimAddress(url: string) {
  for (;;) {
    const c = url.at(-1)
    if (!c || !'!"\'),.:;?_~*]'.includes(c)) return url
    if (c === ')' && url.split('(').length >= url.split(')').length) return url
    url = url.slice(0, -1)
  }
}

/**
 * Ends a bare web address at the first CJK character or full-width mark, as in "看 https://x.dev/a。", and leaves the
 * rest as text. Addresses written as [text](url) or <url> are taken as written.
 */
function remarkWideEnd() {
  const cut = (link: MdNode, source: string): MdNode[] => {
    const text = link.children?.length === 1 && link.children[0].type === 'text' ? link.children[0].value ?? '' : ''
    const prefix = link.url === text ? '' : link.url === `http://${text}` ? 'http://' : null
    const at = link.position?.start.offset
    const i = text.search(WIDE)
    if (prefix === null || i < 0 || (at !== undefined && !source.startsWith(text, at))) return [link]
    const kept = trimAddress(text.slice(0, i))
    const rest = { type: 'text', value: text.slice(kept.length) }
    if (!/^(https?:\/\/|www\.)[^/]*\.[^./]/i.test(kept)) return [{ type: 'text', value: text }]
    return [{ ...link, url: prefix + kept, children: [{ type: 'text', value: kept }] }, rest]
  }
  const walk = (node: MdNode, source: string) => {
    if (!node.children) return
    node.children = node.children.flatMap((child) => {
      if (child.type === 'link') return cut(child, source)
      walk(child, source)
      return [child]
    })
  }
  return (tree: MdNode, file: { value?: unknown }) => walk(tree, String(file.value ?? ''))
}

/** Code blocks coloured by the language they name; one naming none, or one not known, stays plain. */
const HIGHLIGHT: Pluggable = [rehypeHighlight, { languages: LANGUAGES }]
/** A file's HTML drawn, then cleaned of scripts and styles, then its code coloured (cleaning would drop the colours). */
const FILE_HTML: Pluggable[] = [rehypeRaw, rehypeSanitize, HIGHLIGHT]

/** Written text, where a line break is one. */
const WRITTEN = [remarkGfm, remarkWideEnd, remarkBreaks]
/** A file, where lines may be wrapped by hand and only a blank line ends a paragraph. */
const FILE = [remarkGfm, remarkWideEnd]

/**
 * Marks where the text, outside code and links, mentions one of people, a file or a skill, by the signs given; and
 * where it names an employee or a run by an id `ids` knows, in code written inline too.
 */
function remarkSaid({ people, signs, ids }: { people: Person[]; signs: string; ids?: IdLookup }) {
  const said = (p: SaidPart): MdNode => ({ type: 'said', data: { hName: 'span', hProperties: { 'data-said': JSON.stringify(p) } }, children: [{ type: 'text', value: p.text }] })
  const walk = (node: MdNode) => {
    if (!node.children || node.type === 'link' || node.type === 'linkReference') return
    node.children = node.children.flatMap((child): MdNode[] => {
      if (child.type === 'inlineCode' && ids && child.value) {
        // an id in code stands alone as a name; what is around it stays code
        return saidParts(child.value, [], '', ids).flatMap((p) => (p.kind ? [said(p)] : p.text.trim() ? [{ type: 'inlineCode', value: p.text }] : []))
      }
      if (child.type !== 'text' || !child.value) {
        walk(child)
        return [child]
      }
      return saidParts(child.value, people, signs, ids).map((p) => (p.kind ? said(p) : { type: 'text', value: p.text }))
    })
  }
  return (tree: MdNode) => walk(tree)
}

/**
 * `people` are who "@" can name, to show where the text mentions them as buttons. `signs` are the mentions to look
 * for: a reply's own "#" or "$" is as likely a number or a price, so it looks for "@" only, and a message the user
 * sent, written with the "#" and "$" menus, for all three.
 */
export function Markdown({ text, file, people = [], signs = '@', ids, project }: {
  text: string; file?: boolean; people?: Person[]; signs?: string
  /** What the ids of employees and runs in the text name, to show them as their names. */
  ids?: IdLookup
  /** A file opened from a folder: its HTML is drawn and its pictures load from beside it. */
  project?: InProject
}) {
  const plugins = file || project ? FILE : WRITTEN
  const looks = people.length > 0 || /[#$]/.test(signs) || (!!ids && hasId(text))
  return (
    <div className="fx-md">
      <ReactMarkdown remarkPlugins={looks ? [...plugins, [remarkSaid, { people, signs, ids }]] : plugins}
        rehypePlugins={project ? FILE_HTML : [HIGHLIGHT]}
        components={project ? projectComponents(project) : COMPONENTS}>{text}</ReactMarkdown>
    </div>
  )
}

const hasId = (text: string) => text.search(ID_WORD) >= 0

const INLINE = ['strong', 'em', 'del', 'code', 'a']

/**
 * One line of text among other things: its marks only, with no blocks. `noLinks` is for inside a button; `ids`, as for
 * Markdown, is not, as a name it shows is a button.
 */
export function MarkdownLine({ text, noLinks, ids }: { text: string; noLinks?: boolean; ids?: IdLookup }) {
  const named = !!ids && hasId(text)
  const allowed = noLinks ? INLINE.filter((x) => x !== 'a') : INLINE
  return (
    <ReactMarkdown remarkPlugins={named ? [...FILE, [remarkSaid, { people: [], signs: '', ids }]] : FILE} components={COMPONENTS} unwrapDisallowed
      allowedElements={named ? [...allowed, 'span'] : allowed}>
      {text}
    </ReactMarkdown>
  )
}
