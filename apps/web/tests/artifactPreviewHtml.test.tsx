import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { installDomEnvironment } from './helpers/domEnv'
import ArtifactPreview from '../src/components/ArtifactPreview'
import { MarkdownAssetUrlProvider } from '../src/contexts/MarkdownAssetUrlContext'
import { I18nProvider } from '../src/i18n'

test('shared HTML uses isolated document content while preserving the file download endpoint', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const html = '<!doctype html><html><body><h1>Shared design</h1><script>document.body.dataset.ready="yes"</script></body></html>'
  const filePreview = { isolatedHtml: true,
    load: async () => ({ type: 'text', content: html, content_type: 'text/html', file_size: html.length, extension: '.html' }),
    rawUrl: () => '/api/public/shares/token/artifacts/id/content',
  }
  try {
    await act(async () => root.render(<I18nProvider><MarkdownAssetUrlProvider filePreview={filePreview}>
      <ArtifactPreview path="design.html" />
    </MarkdownAssetUrlProvider></I18nProvider>))
    const frame = document.querySelector('iframe')!
    assert.ok(frame)
    assert.ok(frame.getAttribute('srcdoc')?.startsWith(html))
    assert.equal(frame.getAttribute('src'), null, 'download responses must not be used as iframe documents')
    assert.equal(frame.getAttribute('sandbox'), 'allow-scripts allow-popups')
    assert.equal(frame.getAttribute('referrerpolicy'), 'no-referrer')
    assert.equal(document.querySelector('a[download]')?.getAttribute('href'), filePreview.rawUrl())
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
