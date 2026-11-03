import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Markdown, MarkdownLine } from './Markdown'
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
})
