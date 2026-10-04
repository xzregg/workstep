import './helpers/domEnv.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import ProjectDirectoryBrowser from '../src/components/ProjectDirectoryBrowser.tsx'
import { fsApi } from '../src/api/client.ts'
import { I18nProvider } from '../src/i18n/index.tsx'
import { installDomEnvironment } from './helpers/domEnv.ts'

test('upload sits before hidden switch, targets selected directory, refreshes and shows errors', async () => {
  const { window, document } = installDomEnvironment()
  const originalBrowse = fsApi.browse, originalUpload = fsApi.uploadToDirectory
  const uploads: string[] = []
  let browses = 0, fail = false
  fsApi.browse = async (path) => {
    browses++
    return { path: '/demo', name: 'demo', parent: null, relative_path: '', entries: [
      ...(path === 'docs' ? [] : [{ name: 'docs', path: '/demo/docs', relative_path: 'docs', type: 'directory' as const }]),
    ] }
  }
  fsApi.uploadToDirectory = async (_file, _project, _root, parent) => {
    uploads.push(parent)
    if (fail) throw new Error('Entry already exists')
    return { path: 'docs/note.txt', name: 'note.txt', size: 5 }
  }
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const flush = async () => { await act(async () => { await new Promise(resolve => window.setTimeout(resolve, 0)) }) }
  const upload = async () => {
    const input = document.querySelector<HTMLInputElement>('.project-directory-upload input')!
    Object.defineProperty(input, 'files', { configurable: true, value: [new window.File(['hello'], 'note.txt')] })
    await act(async () => input.dispatchEvent(new window.Event('change', { bubbles: true })))
    await flush()
  }
  try {
    await act(async () => root.render(<I18nProvider><ProjectDirectoryBrowser projectId="one" /></I18nProvider>))
    await flush()
    const control = document.querySelector('.project-directory-upload')
    assert.ok(control)
    assert.equal(control.nextElementSibling?.getAttribute('role'), 'switch')
    await upload()
    assert.deepEqual(uploads, [''])
    await act(async () => document.querySelector<HTMLElement>('[title="/demo/docs"]')!.click())
    await flush()
    const before = browses
    await upload()
    assert.equal(uploads[1], 'docs')
    assert.ok(browses > before)
    fail = true
    await upload()
    assert.match(document.querySelector('[role="alert"]')?.textContent || '', /Entry already exists/)
    await act(async () => root.render(<I18nProvider><ProjectDirectoryBrowser projectId="one" readOnly /></I18nProvider>))
    assert.equal(document.querySelector('.project-directory-upload'), null)
  } finally {
    await act(async () => root.unmount())
    fsApi.browse = originalBrowse
    fsApi.uploadToDirectory = originalUpload
    await window.happyDOM.close()
  }
})
