import './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { installDomEnvironment } from './helpers/domEnv'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import ProjectDirectorySetting from '../src/components/ProjectDirectorySetting'
import ProjectConnectionDialog from '../src/components/ProjectConnectionDialog'
import { useUserSettingsStore } from '../src/stores/userSettingsStore'
import { useManagedModeStore } from '../src/stores/managedModeStore'

test('saving the default directory opens project browsing there; clearing restores home', async () => {
  const { document, window } = installDomEnvironment()
  useLocaleStore.setState({ locale: 'zh-CN' })
  const originalFetch = globalThis.fetch
  let savedDirectory = ''
  const browsed: (string | null)[] = []
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/managed/mode') return Response.json({ managed: false })
    if (url.pathname === '/api/system-settings') {
      if (init?.method === 'PUT') savedDirectory = JSON.parse(String(init.body)).default_project_directory
      return Response.json({ user_name: '测试', open_mode: false, default_project_directory: savedDirectory })
    }
    assert.equal(url.pathname, '/api/fs/browse')
    browsed.push(url.searchParams.get('path'))
    return Response.json({ path: url.searchParams.get('path') || '/home/test', parent: '/', entries: [] })
  }
  useUserSettingsStore.setState({ loaded: false, loading: false, defaultProjectDirectory: '', error: '' })
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const renderSettings = async () => act(async () => root.render(<I18nProvider><ProjectDirectorySetting /></I18nProvider>))
  const renderProject = async () => act(async () => root.render(<I18nProvider><ProjectConnectionDialog open onClose={() => {}} onConnected={() => {}} /></I18nProvider>))
  const setDirectory = async (value: string) => {
    const input = document.querySelector('input')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
      input.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    const save = Array.from(document.querySelectorAll('button')).find(button => button.textContent === '保存')!
    assert.equal(save.disabled, false)
    await act(async () => save.click())
  }
  try {
    await renderSettings()
    await setDirectory('/workspace/My Projects')
    assert.equal(savedDirectory, '/workspace/My Projects')
    await renderProject()
    assert.deepEqual(browsed, ['/workspace/My Projects'])
    await renderSettings()
    assert.equal(document.querySelector('input')!.value, '/workspace/My Projects')
    await setDirectory('')
    await renderProject()
    assert.deepEqual(browsed, ['/workspace/My Projects', null])
  } finally {
    await act(async () => root.unmount())
    globalThis.fetch = originalFetch
    await window.happyDOM.close()
  }
})

test('managed project connection omits the legacy share-string mode', async () => {
  const { document, window } = installDomEnvironment()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async input => {
    const path = new URL(String(input), 'http://localhost').pathname
    if (path === '/api/fs/browse') return Response.json({ path: '/home', parent: '/', entries: [] })
    if (path === '/api/system-settings') return Response.json({
      user_name: 'alice', open_mode: false, default_project_directory: '',
    })
    throw new Error(`Unexpected request ${path}`)
  }
  useManagedModeStore.setState({ managed: true, loading: false })
  useUserSettingsStore.setState({ loaded: true, loading: false, defaultProjectDirectory: '' })
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    await act(async () => root.render(<I18nProvider><ProjectConnectionDialog open
      onClose={() => {}} onConnected={() => {}} /></I18nProvider>))
    assert.doesNotMatch(document.body.textContent ?? '', /远程项目/)
    assert.equal(document.querySelector('#remote-share-string'), null)
  } finally {
    await act(async () => root.unmount())
    useManagedModeStore.setState({ managed: null, loading: false })
    globalThis.fetch = originalFetch
    await window.happyDOM.close()
  }
})

test('an unavailable default directory falls back to home and reports the problem', async () => {
  const { document, window } = installDomEnvironment()
  const originalFetch = globalThis.fetch
  const browsed: (string | null)[] = []
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname === '/api/managed/mode') return Response.json({ managed: false })
    browsed.push(url.searchParams.get('path'))
    if (url.searchParams.has('path')) return Response.json({ detail: 'Directory not found' }, { status: 404 })
    return Response.json({ path: '/home/test', parent: '/home', entries: [{ name: 'Projects', path: '/home/test/Projects', type: 'directory' }] })
  }
  useUserSettingsStore.setState({ loaded: true, loading: false, defaultProjectDirectory: '/deleted', error: '' })
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    await act(async () => root.render(<I18nProvider><ProjectConnectionDialog open onClose={() => {}} onConnected={() => {}} /></I18nProvider>))
    assert.deepEqual(browsed, ['/deleted', null])
    assert.match(document.querySelector('[role="alert"]')!.textContent!, /Directory not found/)
    const option = document.querySelector<HTMLElement>('[role="option"]')!
    await act(async () => option.click())
    assert.equal(option.getAttribute('aria-selected'), 'true')
  } finally {
    await act(async () => root.unmount())
    globalThis.fetch = originalFetch
    await window.happyDOM.close()
  }
})
