import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { projectImageUrl } from './core/ops'
import { Markdown, MarkdownLine, projectPath } from './Markdown'
import { SaidContext, type SaidActions } from './Said'

const html = (text: string, file?: boolean) => renderToStaticMarkup(<Markdown text={text} file={file} />)
const line = (text: string, noLinks?: boolean) => renderToStaticMarkup(<MarkdownLine text={text} noLinks={noLinks} />)

describe('Markdown', () => {
  it('renders the usual marks, lists, code and tables', () => {
    const out = html('## 標題\n\n**粗** `碼`\n\n- 一\n- [x] 二\n\n```go\nx := 1\n```\n\n| a |\n| - |\n| b |')
    for (const want of ['<h2>標題</h2>', '<strong>粗</strong>', '<code>碼</code>', '<li>一</li>', 'type="checkbox"', 'language-go', '<div class="fx-md-table"><table>', '<td>b</td>']) {
      expect(out).toContain(want)
    }
  })

  it('keeps line breaks in written text but not in files', () => {
    expect(html('一\n二')).toContain('<br/>')
    expect(html('一\n二', true)).not.toContain('<br/>')
  })

  it('leaves raw HTML as text', () => {
    const out = html('<img src=x onerror=alert(1)>\n\n<script>alert(1)</script>')
    expect(out).not.toContain('<img')
    expect(out).not.toContain('<script')
  })

  it('opens web links outside, and has no link for anything else', () => {
    expect(html('[a](https://x.dev)')).toContain('<a href="https://x.dev" target="_blank" rel="noreferrer">a</a>')
    for (const bad of ['javascript:alert(1)', 'docs/spec.md', '/api/v1/world', '#top']) expect(html(`[a](${bad})`)).not.toContain('<a')
  })

  it('ends a bare address at Chinese text or a full-width mark', () => {
    const link = (url: string, text = url) => `<a href="${url}" target="_blank" rel="noreferrer">${text}</a>`
    const cases: [string, string][] = [
      ['看 https://x.dev/a。', `看 ${link('https://x.dev/a')}。`],
      ['看 https://x.dev/a，然後', `看 ${link('https://x.dev/a')}，然後`],
      ['看 https://x.dev。', `看 ${link('https://x.dev')}。`],
      ['「https://x.dev/a」', `「${link('https://x.dev/a')}」`],
      ['www.x.dev/a）', `${link('http://www.x.dev/a', 'www.x.dev/a')}）`],
      ['https://x.dev/a中文 b', `${link('https://x.dev/a')}中文 b`],
      ['https://x.dev/a.。', `${link('https://x.dev/a')}.。`],
      ['https://x.dev/a_(b)。', `${link('https://x.dev/a_(b)')}。`],
      ['https://x.dev/a.', `${link('https://x.dev/a')}.`],
      ['(https://x.dev/a)', `(${link('https://x.dev/a')})`],
    ]
    for (const [text, want] of cases) expect(html(text)).toBe(`<div class="fx-md"><p>${want}</p></div>`)
  })

  it('takes an address written as a link as it is', () => {
    expect(html('[a](https://x.dev/中文)')).toContain('href="https://x.dev/%E4%B8%AD%E6%96%87"')
    expect(html('<https://x.dev/中文>')).toContain('>https://x.dev/中文</a>')
  })

  it('never loads a picture', () => {
    expect(html('![圖](https://x.dev/a.png)')).toContain('<a href="https://x.dev/a.png" target="_blank" rel="noreferrer">圖</a>')
    expect(html('![圖](a.png)')).not.toContain('<a')
    expect(html('![圖](https://x.dev/a.png)')).not.toContain('<img')
  })
})

describe('MarkdownLine', () => {
  it('has marks but no blocks', () => {
    expect(line('# **粗** `碼`')).toBe('<strong>粗</strong> <code>碼</code>')
  })

  it('drops the link inside a button', () => {
    expect(line('[a](https://x.dev)', true)).toBe('a')
  })
})

describe('mentions in a reply', () => {
  it('marks the people it names with "@", but not in code or a link, nor a "#" or "$"', () => {
    const out = renderToStaticMarkup(<Markdown text={'**@Ada** 請看 `@Ada` 和 [@Ada](https://a.b)，#12 要 $3'} people={[{ id: 'a', name: 'Ada' }]} />)
    expect(out).toContain('<strong><span class="fx-said fx-said-person">@Ada</span></strong>')
    expect(out.match(/fx-said-person/g)).toHaveLength(1)
    expect(out).not.toMatch(/fx-said-(file|skill)/)
  })
})

describe('mentions in a message', () => {
  const said = (actions: SaidActions) => renderToStaticMarkup(
    <SaidContext.Provider value={actions}><Markdown text={'@Ada 看 #docs/ 和 #"a b.md" 用 $tdd'} people={[{ id: 'a', name: 'Ada' }]} signs="@#$" /></SaidContext.Provider>,
  )

  it('draws each as a button, a file or folder with its outline in place of the "#"', () => {
    const out = said({ person: () => {}, file: () => {}, folder: () => {}, skill: () => {} })
    expect(out.match(/<button/g)).toHaveLength(4)
    expect(out).toMatch(/fx-said-folder[^>]*><svg[^]*?<\/svg>docs<\/button>/)
    expect(out).toMatch(/fx-said-file[^>]*><svg[^]*?<\/svg>a b\.md<\/button>/)
    expect(out).toContain('>@Ada</button>')
    expect(out).toContain('>$tdd</button>')
    expect(out).not.toContain('#')
  })

  it('leaves as text what there is nothing to open with, such as someone who has left', () => {
    const out = said({ person: () => {}, canPerson: () => false })
    expect(out).not.toContain('<button')
    expect(out).toContain('fx-said-person')
  })
  it('renders the rest of a message as Markdown, and leaves mentions in code alone', () => {
    const out = renderToStaticMarkup(
      <SaidContext.Provider value={{ file: () => {} }}>
        <Markdown text={'**看** #src/a_b_c.ts\n- 一\n- `#not/this`'} signs="@#$" />
      </SaidContext.Provider>,
    )
    expect(out).toContain('<strong>看</strong>')
    expect(out).toMatch(/fx-said-file[^>]*><svg[^]*?<\/svg>src\/a_b_c\.ts<\/button>/)
    expect(out).toContain('<li>')
    expect(out).toContain('<code>#not/this</code>')
  })

  it('draws the HTML of a project file, cleaned, with its own pictures loaded from the project', () => {
    const out = renderToStaticMarkup(<Markdown project={{ dir: 'docs', imageUrl: (p) => projectImageUrl('t', p) }} text={[
      '<p align="center"><a href="."><img height="160" src="./img/logo.png" alt="Logo"></a></p>',
      '<p><img src="https://img.shields.io/badge/x" alt="徽章"><script>alert(1)</script><b onclick="x()">粗</b></p>',
      '',
      '# Title',
    ].join('\n')} />)
    expect(out).toContain('<p align="center">')
    expect(out).toContain(`src="/api/v1/teams/t/image?path=${encodeURIComponent('docs/img/logo.png')}"`)
    expect(out).toContain('height="160"')
    expect(out).toContain('徽章')
    expect(out).toContain('<a href="https://img.shields.io/badge/x" target="_blank" rel="noreferrer">徽章</a>')
    expect(out).not.toMatch(/<img[^>]*shields/)
    expect(out).not.toMatch(/<script|onclick|alert/)
    expect(out).toContain('<b>粗</b>')
    expect(out).toContain('<h1>Title</h1>')
  })

  it('keeps HTML as text in what people and models write', () => {
    expect(html('<b>粗</b>', true)).not.toContain('<b>')
    expect(html('<b>粗</b>')).not.toContain('<b>')
  })

  it('finds a relative address in the project, and nothing outside it', () => {
    expect(projectPath('docs', './a.png')).toBe('docs/a.png')
    expect(projectPath('docs/x', '../a%20b.png?raw=1')).toBe('docs/a b.png')
    expect(projectPath('', '/macos/i.png')).toBe('macos/i.png')
    expect(projectPath('', '../a.png')).toBeNull()
    expect(projectPath('', 'https://x.dev/a.png')).toBeNull()
    expect(projectPath('', '//x.dev/a.png')).toBeNull()
    expect(projectPath('', 'data:image/png;base64,AA')).toBeNull()
    expect(projectPath('', '%E0%A4%A.png')).toBeNull()
  })

  it('colours a code block by the language it names, in messages and files alike', () => {
    const block = '```go\nfunc main() {}\n```'
    for (const out of [html(block), html(block, true), renderToStaticMarkup(<Markdown text={block} project={{ dir: '', imageUrl: (p) => p }} />)]) {
      expect(out).toContain('class="hljs language-go"')
      expect(out).toContain('<span class="hljs-keyword">func</span>')
    }
    expect(html('```\nfunc main() {}\n```')).not.toContain('hljs-keyword')
    expect(html('```nosuchlang\nfunc\n```')).toContain('func')
  })

  it('gives every code block a button to copy it, and nothing else one', () => {
    for (const out of [html('```go\nx := 1\n```'), html('```\nplain\n```', true), renderToStaticMarkup(<Markdown text={'```sh\nls\n```'} project={{ dir: '', imageUrl: (p) => p }} />)]) {
      expect(out).toMatch(/<div class="fx-md-code"><pre><code[^>]*>[^]*<\/code><\/pre><button type="button" class="fx-md-copy fx-hit" aria-label="複製程式碼"/)
    }
    expect(html('平常 `碼` 而已')).not.toContain('fx-md-copy')
  })
})

