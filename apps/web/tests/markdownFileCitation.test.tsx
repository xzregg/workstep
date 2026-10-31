import { installDomEnvironment } from './helpers/domEnv.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import MarkdownMessage from '../src/components/MarkdownMessage.tsx'
import { I18nProvider } from '../src/i18n/index.tsx'
import { MarkdownAssetUrlProvider } from '../src/contexts/MarkdownAssetUrlContext.tsx'

const marker = ':codex-file-citation{path="/Users/demo/交接 [确认] (最终)#1.docx" purpose="output"}'

test('clicking a citation opens the common preview through the share capability', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const loaded: string[] = []
  try {
    await act(async () => root.render(
      <I18nProvider>
        <MarkdownAssetUrlProvider filePreview={{
          load: async (path) => {
            loaded.push(path)
            return { type: 'text', content: '交接内容', content_type: 'text/plain', file_size: 12, extension: '.txt', relative_path: null }
          },
          rawUrl: () => '/shared/report.txt',
        }}>
          <MarkdownMessage content={marker} />
        </MarkdownAssetUrlProvider>
      </I18nProvider>,
    ))
    assert.deepEqual(loaded, [])
    const link = container.querySelector<HTMLAnchorElement>('[data-file-preview]')
    assert.ok(link)
    await act(async () => link.click())
    assert.deepEqual(loaded, ['/Users/demo/交接 [确认] (最终)#1.docx'])
    assert.equal(document.querySelector('#file-preview-title')?.textContent, '交接 [确认] (最终)#1.docx')
    assert.match(document.querySelector('.file-preview-dialog-body')?.textContent ?? '', /交接内容/)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

function render(content: string, plainText = false, shared = false) {
  return renderToStaticMarkup(
    <I18nProvider>
      <MarkdownAssetUrlProvider filePreview={shared ? {
        load: async () => { throw new Error('must load only on click') },
        rawUrl: (path) => path,
      } : undefined}>
        <MarkdownMessage content={content} projectId={shared ? undefined : 'project-1'} plainText={plainText} />
      </MarkdownAssetUrlProvider>
    </I18nProvider>,
  )
}

test('renders Codex file citations as named preview links in both message modes and shares', () => {
  for (const plainText of [false, true]) {
    for (const shared of [false, true]) {
      const html = render(`已生成。\n${marker}`, plainText, shared)
      assert.match(html, /data-file-preview="true"/)
      assert.match(html, />交接 \[确认\] \(最终\)#1\.docx</)
      assert.match(html, /href="\/Users\/demo\/%E4%BA%A4%E6%8E%A5%20%5B%E7%A1%AE%E8%AE%A4%5D%20%28%E6%9C%80%E7%BB%88%29%231.docx"/)
      assert.doesNotMatch(html, /codex-file-citation|purpose=/)
    }
  }
})

test('preserves code examples and incomplete or invalid citations', () => {
  for (const content of [
    `\`${marker}\``,
    `\`\`\`text\n${marker}\n\`\`\``,
    `~~~text\n${marker}\n~~~`,
    ':codex-file-citation{path="/tmp/report.docx"',
    ':codex-file-citation{purpose="output"}',
    ':codex-file-citation{path="https://example.com/report.docx"}',
    ':codex-file-citation{path=""}',
  ]) {
    const html = render(content)
    assert.match(html, /codex-file-citation/)
    assert.doesNotMatch(html, /data-file-preview/)
  }
})

test('renders multiple citations with relative and Windows paths', () => {
  const html = render(':codex-file-citation{path="docs/report.pdf"} 和 :codex-file-citation{purpose="output" path="C:\\demo\\report.docx"}')
  assert.equal((html.match(/data-file-preview="true"/g) ?? []).length, 2)
  assert.match(html, /href="docs\/report.pdf"/)
  assert.match(html, /href="file:\/\/\/C:\/demo\/report.docx"/)
})
