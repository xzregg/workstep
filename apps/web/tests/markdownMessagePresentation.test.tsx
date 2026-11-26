import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import MarkdownMessage from '../src/components/MarkdownMessage.tsx'
import { I18nProvider } from '../src/i18n/index.tsx'

function render(content: string, options: { plainText?: boolean; streaming?: boolean } = {}) {
  return renderToStaticMarkup(<I18nProvider><MarkdownMessage content={content} {...options} /></I18nProvider>)
}

const citation = 'citeturn0view0turn1search0turn2view0'

test('Markdown tables retain native table semantics inside a scroll boundary', () => {
  const html = render('|维度|说明|\n|---|---:|\n|事件|`apps/daemon/services/example.py`|')
  assert.match(html, /<div class="markdown-table-scroll"><table>\s*<thead>/)
  assert.match(html, /<th style="text-align:right">说明<\/th>/)
  assert.match(html, /<td style="text-align:right"><code>apps\/daemon\/services\/example\.py<\/code><\/td>/)
})

test('unresolved web citations are hidden from rendered prose and table cells', () => {
  const content = `**结论**${citation}。 [原文](https://example.com)\n\n|说明|\n|---|\n|详情${citation}|`
  for (const streaming of [false, true]) {
    const html = render(content, { streaming })
    assert.doesNotMatch(html, /|turn2view0/)
    assert.match(html, /结论<\/strong>。/)
    assert.match(html, /href="https:\/\/example\.com"/)
    assert.match(html, /<td>详情<\/td>/)
  }
})

test('literal citations in inline code, fenced code and user text stay intact', () => {
  const html = render(`\`${citation}\`\n\n\x60\x60\x60text\n${citation}\n\x60\x60\x60`)
  assert.equal(html.split(citation).length - 1, 2)
  assert.ok(render(citation, { plainText: true }).includes(citation))
  assert.ok(render('citeunknown').includes('citeunknown'))
  assert.ok(render('citeturn2view').includes('citeturn2view'))
})


test('missing Markdown body renders empty without losing normal Markdown', () => {
  for (const content of [undefined, null]) {
    const html = render(content as unknown as string)
    assert.doesNotMatch(html, /undefined|null/)
  }
  assert.match(render('**正常正文**'), /<strong>正常正文<\/strong>/)
})
