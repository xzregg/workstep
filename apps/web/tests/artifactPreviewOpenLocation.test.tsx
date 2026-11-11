import './helpers/domEnv.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import ArtifactPreview from '../src/components/ArtifactPreview.tsx'
import { fsApi, type Project } from '../src/api/client.ts'
import { useProjectStore } from '../src/stores/projectStore.ts'
import { I18nProvider } from '../src/i18n/index.tsx'
import { installDomEnvironment } from './helpers/domEnv.ts'

for (const scenario of [
  { name: 'local relative file', path: 'docs/sample.mp3', parent: '/project/docs' },
  { name: 'absolute file', path: '/project/uploads/sample.mp3', parent: '/project/uploads' },
  { name: 'root file', path: '/sample.mp3', parent: '/' },
  { name: 'desktop Windows file', path: 'C:\\project\\sample.mp3', parent: 'C:/project', desktop: true },
  { name: 'remote project', path: 'sample.mp3', hidden: true, remote: true },
  { name: 'remote browser', path: 'sample.mp3', hidden: true, url: 'https://example.com/' },
  { name: 'share page', path: 'sample.mp3', hidden: true, url: 'http://localhost/share/token' },
  { name: 'gateway workspace', path: 'sample.mp3', hidden: true, url: 'http://localhost/workspace/device/' },
]) {
  test(`preview directory action: ${scenario.name}`, async () => {
    const { window, document } = installDomEnvironment()
    if (scenario.url) window.location.href = scenario.url
    const previous = { preview: fsApi.preview, openers: fsApi.directoryOpeners, open: fsApi.openDirectory }
    const opened: string[] = []
    fsApi.preview = async () => ({ type: 'binary', content_type: 'audio/mpeg', content: '', file_size: 10 })
    fsApi.directoryOpeners = async () => ({ openers: [{ id: 'file_manager', label: 'Finder', available: true }] })
    fsApi.openDirectory = async (path) => { opened.push(path); return { path } as any }
    if (scenario.desktop) Object.assign(window, { workstepDesktop: { directories: {
      openers: fsApi.directoryOpeners,
      open: async (path: string) => { opened.push(path); return { path } },
    } } })
    useProjectStore.setState({ projects: [{ id: 'project', path: '/project', name: 'Demo', type: scenario.remote ? 'remote' : 'local' } as Project], activeProject: null })
    const root = createRoot(document.body.appendChild(document.createElement('div')))
    try {
      await act(async () => { root.render(<I18nProvider><ArtifactPreview path={scenario.path} projectId="project" /></I18nProvider>) })
      const button = [...document.querySelectorAll('button')].find(item => /打开目录|Open location|Open directory/i.test(item.getAttribute('aria-label') || ''))
      if (scenario.hidden) assert.equal(button, undefined)
      else {
        assert.ok(button)
        await act(async () => button.click())
        assert.deepEqual(opened, [scenario.parent])
      }
    } finally {
      await act(async () => root.unmount())
      fsApi.preview = previous.preview
      fsApi.directoryOpeners = previous.openers
      fsApi.openDirectory = previous.open
      useProjectStore.setState({ projects: [], activeProject: null })
      await window.happyDOM.close()
    }
  })
}
