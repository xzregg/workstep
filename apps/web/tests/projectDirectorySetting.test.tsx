import './helpers/domEnv.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import ProjectDirectorySetting from '../src/components/ProjectDirectorySetting.tsx'
import { useUserSettingsStore } from '../src/stores/userSettingsStore.ts'
import { I18nProvider } from '../src/i18n/index.tsx'
import { installDomEnvironment } from './helpers/domEnv.ts'

test('shows the file boundary explanation and saves the switch with the directory', async () => {
  const { window, document } = installDomEnvironment()
  const originalFetch = globalThis.fetch
  const bodies: unknown[] = []
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(String(options?.body))
    bodies.push(body)
    return Response.json(body)
  }
  useUserSettingsStore.setState({ loaded: true, error: '', defaultProjectDirectory: '/projects', restrictFileAccessRoot: true })
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    await act(async () => root.render(<I18nProvider><ProjectDirectorySetting /></I18nProvider>))
    const toggle = document.querySelector<HTMLButtonElement>('[role="switch"]')!
    assert.ok(toggle)
    assert.equal(toggle.getAttribute('aria-checked'), 'true')
    assert.match(document.querySelector('#file-access-root-hint')?.textContent || '', /预览|preview/i)
    await act(async () => toggle.click())
    const save = document.querySelector<HTMLButtonElement>('.project-directory-setting-save')!
    assert.equal(save.disabled, false)
    await act(async () => save.click())
    assert.deepEqual(bodies, [{ default_project_directory: '/projects', restrict_file_access_root: false }])
    assert.equal(useUserSettingsStore.getState().restrictFileAccessRoot, false)
    assert.ok(document.querySelector('[role="status"]'))
  } finally {
    await act(async () => root.unmount())
    globalThis.fetch = originalFetch
    window.happyDOM.abort()
  }
})

test('does not report a saved switch when an old daemon ignores the new field', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => Response.json({ default_project_directory: '/projects' })
  useUserSettingsStore.setState({ restrictFileAccessRoot: true })
  try {
    await assert.rejects(useUserSettingsStore.getState().saveDefaultProjectDirectory('/projects', false), /后台|保存/)
    assert.equal(useUserSettingsStore.getState().restrictFileAccessRoot, true)
  } finally { globalThis.fetch = originalFetch }
})
