import './helpers/domEnv.ts'

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import ArtifactPreview from '../src/components/ArtifactPreview.tsx'
import { I18nProvider } from '../src/i18n/index.tsx'
import { installDomEnvironment } from './helpers/domEnv.ts'

test('file preview puts a direct download action before copy', async () => {
  const { window, document } = installDomEnvironment()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({
    type: 'text',
    content_type: 'text/plain',
    content: 'preview content',
    file_size: 15,
    extension: '.txt',
    relative_path: 'docs/notes.txt',
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
  const root = createRoot(document.body.appendChild(document.createElement('div')))

  try {
    await act(async () => {
      root.render(
        <I18nProvider>
          <ArtifactPreview path="docs/notes.txt" projectId="project:one" />
        </I18nProvider>,
      )
    })
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })

    const download = document.querySelector<HTMLAnchorElement>('a[download]')
    const copy = document.querySelector<HTMLButtonElement>('button[aria-label*="Copy"], button[aria-label*="复制"]')
    assert.ok(download)
    assert.ok(copy)
    assert.equal(download.getAttribute('href'), '/api/fs/project-raw/project%3Aone/docs/notes.txt?project_id=project%3Aone')
    assert.equal(download.getAttribute('download'), 'notes.txt')
    assert.ok(download.classList.contains('btn-ghost'))
    assert.ok(!download.classList.contains('btn-primary'))
    assert.ok(download.classList.contains('artifact-toolbar-icon-button'))
    assert.ok(copy.classList.contains('artifact-toolbar-icon-button'))
    assert.doesNotMatch(copy.getAttribute('style') || '', /(?:width|height|padding|min-width)/)
    assert.ok(download.compareDocumentPosition(copy) & window.Node.DOCUMENT_POSITION_FOLLOWING)
  } finally {
    await act(async () => root.unmount())
    globalThis.fetch = originalFetch
    await window.happyDOM.close()
  }
})

test('desktop file preview toolbar icon buttons use the 32px control size', () => {
  const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')
  assert.match(css, /\.artifact-toolbar-icon-button\s*{[^}]*width:\s*32px;[^}]*height:\s*32px;[^}]*min-width:\s*32px;/s)
})
