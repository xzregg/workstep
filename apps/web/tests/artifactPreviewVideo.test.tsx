import './helpers/domEnv.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import ArtifactPreview from '../src/components/ArtifactPreview.tsx'
import { MarkdownAssetUrlProvider } from '../src/contexts/MarkdownAssetUrlContext'
import { I18nProvider } from '../src/i18n/index.tsx'
import { installDomEnvironment } from './helpers/domEnv.ts'

for (const shared of [false, true]) {
  test(`video preview streams from the ${shared ? 'share' : 'project'} file capability`, async () => {
    const { window, document } = installDomEnvironment()
    const originalFetch = globalThis.fetch
    const preview = { type: 'video' as const, content_type: 'video/mp4', content: '', file_size: 9842309, extension: '.mp4', relative_path: 'intro.mp4' }
    let requests = 0
    globalThis.fetch = async () => {
      requests++
      assert.equal(shared, false, 'share preview must not call host file APIs')
      return new Response(JSON.stringify(preview), { headers: { 'Content-Type': 'application/json' } })
    }
    const capability = shared ? { load: async () => preview, rawUrl: () => '/share/video/content' } : undefined
    const root = createRoot(document.body.appendChild(document.createElement('div')))
    try {
      await act(async () => {
        root.render(<I18nProvider><MarkdownAssetUrlProvider filePreview={capability}>
          <ArtifactPreview path="intro.mp4" projectId={shared ? undefined : 'p'} />
        </MarkdownAssetUrlProvider></I18nProvider>)
      })
      const video = document.querySelector('video')
      assert.ok(video)
      assert.equal(video.getAttribute('src'), shared ? '/share/video/content' : '/api/fs/project-raw/p/intro.mp4?project_id=p')
      assert.equal(video.controls, true)
      assert.equal(video.hasAttribute('playsinline'), true)
      assert.equal(video.getAttribute('preload'), 'metadata')
      assert.equal(document.querySelector('a[download]')?.getAttribute('href'), video.getAttribute('src'))
      assert.equal(requests, shared ? 0 : 1)
    } finally {
      await act(async () => root.unmount())
      globalThis.fetch = originalFetch
      await window.happyDOM.close()
    }
  })
}
