import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { createRef } from 'react'
import { CodeEditor, CodeFile, languageOf } from './Highlight'

describe('languageOf', () => {
  it('knows a file by its extension, or by its whole name', () => {
    expect(['a.go', 'b.ts', 'c.tsx', 'd.py', 'e.sh', 'f.yml', 'g.rs', 'h.html'].map(languageOf)).toEqual(['go', 'ts', 'tsx', 'py', 'sh', 'yml', 'rs', 'html'])
    expect(['Makefile', 'src/go.mod', '.zshrc'].map(languageOf)).toEqual(['makefile', 'go', 'bash'])
  })

  it('leaves a name it cannot tell plain', () => {
    expect(['LICENSE', 'a.unknownext', 'README', '.hidden'].map(languageOf)).toEqual([undefined, undefined, undefined, undefined])
  })
})

describe('CodeFile', () => {
  it('colours a file by its language', () => {
    const html = renderToStaticMarkup(<CodeFile path="main.go" text={'package main\n// hi\nvar s = "x"'} />)
    expect(html).toContain('class="hljs language-go"')
    expect(html).toContain('<span class="hljs-keyword">package</span>')
    expect(html).toContain('<span class="hljs-comment">// hi</span>')
    expect(html).toContain('<span class="hljs-string">&quot;x&quot;</span>')
  })

  it('shows a file it cannot tell, or one too long, as it is', () => {
    expect(renderToStaticMarkup(<CodeFile path="LICENSE" text="MIT <b>" />)).toBe('<pre class="fx-doc-code fx-doc-raw"><code>MIT &lt;b&gt;</code></pre>')
    expect(renderToStaticMarkup(<CodeFile path="big.js" text={'var x;'.repeat(40_000)} />)).not.toContain('hljs-keyword')
  })
})

describe('CodeEditor', () => {
  const editor = (path: string, value: string) => renderToStaticMarkup(
    <CodeEditor path={path} value={value} label={path} box={createRef()} onChange={() => {}} />)

  it('lays a see-through box over the same text coloured, ending in the line break the box shows', () => {
    const html = editor('main.go', 'package main\n')
    expect(html).toMatch(/^<div class="fx-code-edit"><pre class="fx-code-edit-view" aria-hidden="true"><code class="hljs language-go">/)
    expect(html).toContain('<span class="hljs-keyword">package</span> main\n\n</code></pre>')
    expect(html).toContain('<textarea class="fx-code-edit-box" spellCheck="false"')
    expect(html).toContain('aria-label="main.go">package main\n</textarea>')
  })

  it('shows a file it cannot tell as it is, on the same dark box', () => {
    const html = editor('LICENSE', 'MIT <b>')
    expect(html).toContain('<pre class="fx-code-edit-view" aria-hidden="true"><code>MIT &lt;b&gt;\n</code></pre>')
    expect(html).not.toContain('hljs')
  })
})
