import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { installDomEnvironment } from './helpers/domEnv'
import ArtifactPreview from '../src/components/ArtifactPreview'
import { MarkdownAssetUrlProvider } from '../src/contexts/MarkdownAssetUrlContext'
import { I18nProvider } from '../src/i18n'
import { fsApi } from '../src/api/client'
import { HTML_PREVIEW_SANDBOX } from '../src/utils/htmlPreviewCompat'

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
    assert.ok(frame.getAttribute('srcdoc')?.includes(html.slice(html.indexOf('<html>'))))
    assert.ok(frame.getAttribute('srcdoc')?.includes("connect-src 'none'"))
    assert.equal(frame.getAttribute('src'), null, 'download responses must not be used as iframe documents')
    assert.equal(frame.getAttribute('sandbox'), HTML_PREVIEW_SANDBOX)
    assert.equal(frame.getAttribute('referrerpolicy'), 'no-referrer')
    assert.equal(document.querySelector('a[download]')?.getAttribute('href'), filePreview.rawUrl())
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

for (const projectId of ['local-project', 'remote:abc']) {
  test(`ordinary HTML uses an opaque capability frame: ${projectId}`, async () => {
    const { window } = installDomEnvironment()
    const root = createRoot(document.body.appendChild(document.createElement('div')))
    const original = fsApi.preview
    fsApi.preview = async () => ({ type: 'text', content: '<button>Prototype</button>', content_type: 'text/html', extension: '.html', file_size: 26,
      html_preview: { token: 'resource-ticket', entry: 'UI 设计.html' } })
    try {
      await act(async () => root.render(<I18nProvider><ArtifactPreview path="prototype/UI 设计.html" projectId={projectId} /></I18nProvider>))
      const frame = document.querySelector('iframe')!
      assert.equal(frame.getAttribute('src'), `/api/fs/html-resource/${encodeURIComponent(projectId)}/resource-ticket/UI%20%E8%AE%BE%E8%AE%A1.html`)
      assert.equal(frame.getAttribute('srcdoc'), null)
      assert.equal(frame.getAttribute('sandbox'), HTML_PREVIEW_SANDBOX)
      assert.ok(!frame.getAttribute('sandbox')?.includes('allow-same-origin'))
      assert.ok(document.querySelector('a[download]')?.getAttribute('href')?.includes('/fs/project-raw/'))
    } finally {
      fsApi.preview = original
      await act(async () => root.unmount())
      await window.happyDOM.close()
    }
  })
}

test('older backends without preview tickets fail closed to inline isolated HTML', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const original = fsApi.preview
  fsApi.preview = async () => ({ type: 'text', content: '<button onclick="this.textContent=1">Run</button>', content_type: 'text/html', extension: '.html', file_size: 40 })
  try {
    await act(async () => root.render(<I18nProvider><ArtifactPreview path="demo.html" projectId="project" /></I18nProvider>))
    const frame = document.querySelector('iframe')!
    assert.equal(frame.getAttribute('src'), null)
    assert.ok(frame.getAttribute('srcdoc')?.includes('onclick='))
    assert.ok(frame.getAttribute('srcdoc')?.includes("connect-src 'none'"))
    assert.equal(frame.getAttribute('sandbox'), HTML_PREVIEW_SANDBOX)
  } finally {
    fsApi.preview = original
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
