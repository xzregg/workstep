import './helpers/domEnv.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import ArtifactPreview from '../src/components/ArtifactPreview.tsx'
import { MarkdownAssetUrlProvider } from '../src/contexts/MarkdownAssetUrlContext'
import { I18nProvider } from '../src/i18n/index.tsx'
import { installDomEnvironment } from './helpers/domEnv.ts'

for (const kind of ['video', 'audio'] as const) {
  for (const shared of [false, true]) {
    test(`${kind} preview streams from the ${shared ? 'share' : 'project'} file capability`, async () => {
      const { window, document } = installDomEnvironment()
      const originalFetch = globalThis.fetch
      const filename = kind === 'video' ? 'intro.mp4' : '月光替我回答-纯音乐试听.wav'
      const preview = { type: kind, content_type: kind === 'video' ? 'video/mp4' : 'audio/wav', content: '', file_size: 9842309, extension: kind === 'video' ? '.mp4' : '.wav', relative_path: filename }
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
            <ArtifactPreview path={filename} projectId={shared ? undefined : 'p'} />
          </MarkdownAssetUrlProvider></I18nProvider>)
        })
        const media = document.querySelector<HTMLMediaElement>(kind)
        assert.ok(media)
        assert.equal(media.getAttribute('src'), shared ? '/share/video/content' : `/api/fs/project-raw/p/${encodeURIComponent(filename)}?project_id=p`)
        assert.equal(media.controls, true)
        if (kind === 'video') assert.equal(media.hasAttribute('playsinline'), true)
        assert.equal(media.getAttribute('preload'), 'metadata')
        assert.equal(document.querySelector('a[download]')?.getAttribute('href'), media.getAttribute('src'))
        assert.equal(requests, shared ? 0 : 1)
      } finally {
        await act(async () => root.unmount())
        globalThis.fetch = originalFetch
        await window.happyDOM.close()
      }
    })
  }
}
