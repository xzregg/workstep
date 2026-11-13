import './helpers/domEnv.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import ArtifactPreview from '../src/components/ArtifactPreview'
import FilePreviewPage from '../src/pages/FilePreviewPage'
import { MarkdownAssetUrlProvider } from '../src/contexts/MarkdownAssetUrlContext'
import { I18nProvider } from '../src/i18n'
import { installDomEnvironment } from './helpers/domEnv'

const preview = { type: 'audio' as const, content_type: 'audio/wav', content: '', file_size: 2542504, extension: '.wav' }
for (const prefix of ['', '/workspace/device-one']) {
  for (const shared of [false, true]) {
    test(`Android opens ${shared ? 'shared' : 'project'} audio preview in the existing WebView at ${prefix || '/'}`, async () => {
      const { window, document } = installDomEnvironment()
      window.happyDOM.setURL(`https://workstep.test${prefix}/chat`)
      window.WorkStepAndroid = { postMessage() {} }
      let destination = ''
      let popups = 0
      window.location.assign = url => { destination = String(url) }
      window.open = () => { popups++; return null }
      const root = createRoot(document.body.appendChild(document.createElement('div')))
      const path = 'outputs/月光替我回答.wav'
      const shareUrl = `${prefix}/share/token?preview=1&path=${encodeURIComponent(path)}&name=audio.wav`
      try {
        await act(async () => root.render(<I18nProvider>
          <MarkdownAssetUrlProvider filePreview={{ load: async () => preview, rawUrl: () => '/audio',
            ...(shared ? { windowUrl: () => shareUrl } : {}) }}>
            <ArtifactPreview path={path} projectId={shared ? undefined : 'project-one'} />
          </MarkdownAssetUrlProvider>
        </I18nProvider>))
        const button = Array.from(document.querySelectorAll('button')).find(button => /在新窗口打开|Open in new window/.test(button.textContent || ''))
        assert.ok(button)
        await act(async () => button.click())
        assert.equal(popups, 0, 'Android preview must not create an intermediate popup')
        const target = new URL(destination)
        assert.equal(target.origin, 'https://workstep.test')
        assert.equal(target.pathname, shared ? `${prefix}/share/token` : `${prefix}/file-preview`)
        assert.equal(target.searchParams.get('path'), path)
        assert.equal(target.searchParams.get('preview_return'), '1')
        if (shared) assert.equal(target.searchParams.get('preview'), '1')
        else assert.equal(target.searchParams.get('project_id'), 'project-one')
      } finally {
        await act(async () => root.unmount())
        await window.happyDOM.close()
      }
    })
  }
}

for (const returning of [false, true]) {
  test(`Android standalone preview ${returning ? 'returns to the original page' : 'does not go back from a direct link'}`, async () => {
    const { window, document } = installDomEnvironment()
    const url = '/file-preview?path=song.wav' + (returning ? '&preview_return=1' : '')
    window.happyDOM.setURL('https://workstep.test' + url)
    window.WorkStepAndroid = { postMessage() {} }
    let backs = 0
    let closes = 0
    window.history.back = () => { backs++ }
    window.close = () => { closes++ }
    const root = createRoot(document.body.appendChild(document.createElement('div')))
    try {
      await act(async () => root.render(<I18nProvider><MemoryRouter initialEntries={[url]}>
        <MarkdownAssetUrlProvider filePreview={{ load: async () => preview, rawUrl: () => '/audio' }}>
          <FilePreviewPage />
        </MarkdownAssetUrlProvider>
      </MemoryRouter></I18nProvider>))
      const close = Array.from(document.querySelectorAll('button')).find(button => /^(关闭|Close)$/.test(button.textContent || ''))
      assert.ok(close)
      await act(async () => close.click())
      assert.equal(backs, returning ? 1 : 0)
      assert.equal(closes, returning ? 0 : 1)
    } finally {
      await act(async () => root.unmount())
      await window.happyDOM.close()
    }
  })
}
