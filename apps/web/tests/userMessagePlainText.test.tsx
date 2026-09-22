import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'

import MarkdownMessage from '../src/components/MarkdownMessage.tsx'
import { I18nProvider } from '../src/i18n/index.tsx'

function render(content: string, plainText: boolean) {
  return renderToStaticMarkup(
    <I18nProvider>
      <MarkdownMessage
        content={content}
        plainText={plainText}
        className="user-message-markdown"
        projectId="project-1"
      />
    </I18nProvider>,
  )
}

test('plainText keeps typed newlines as literal line breaks without Markdown blocks', () => {
  const content = 'para one\npara two\n- apple\n- banana\n\n1. not a list'
  const html = render(content, true)
  // No block-level Markdown elements are produced — it reads like plain text.
  assert.doesNotMatch(html, /<p>/)
  assert.doesNotMatch(html, /<ul>|<ol>|<li>/)
  // The exact whitespace (single and double newlines, bullet markers) is preserved.
  assert.match(html, /para one\npara two\n- apple\n- banana\n\n1\. not a list/)

  // Contrast: the default Markdown path does emit `<p>`/`<li>` blocks.
  const markdown = render(content, false)
  assert.match(markdown, /<p>/)
  assert.match(markdown, /<li>/)
})

test('plainText still renders uploaded images and file links', () => {
  const html = render('看图 ![shot](.workstep/uploads/a.png) 结束 [报告](docs/report.pdf)', true)
  assert.match(html, /<img/)
  assert.match(html, /class="markdown-inline-image"/)
  assert.match(html, /src="\/api\/fs\/serve\/a\.png\?project_id=project-1"/)
  assert.match(html, /class="markdown-file-link"/)
  assert.match(html, /data-file-preview="true"/)
  assert.match(html, /href="docs\/report\.pdf"/)
})

test('plainText groups consecutive images inline even when markdown contains blank separators', () => {
  const html = render(
    '![one](.workstep/uploads/one.png)\n\n![two](.workstep/uploads/two.png)',
    true,
  )

  assert.equal((html.match(/class="markdown-inline-image"/g) ?? []).length, 2)
  assert.doesNotMatch(html, /<\/span>\n\n<span class="markdown-inline-image">/)
})
