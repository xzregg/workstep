import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { I18nProvider } from '../src/i18n'
import ProjectGitButton from '../src/components/git/ProjectGitButton'
import { useGitStore } from '../src/stores/gitStore'
import { useProjectStore } from '../src/stores/projectStore'
import { useUserSettingsStore } from '../src/stores/userSettingsStore'

function Location() { const location = useLocation(); return <output>{location.pathname + location.search + location.hash}</output> }

for (const compact of [false, true]) test(`Git entry uses ${compact ? 'page navigation on mobile' : 'a resizable window on desktop'}`, async () => {
  const { window } = installDomEnvironment()
  window.innerWidth = compact ? 390 : 1440
  const project = { id: 'p', name: 'Project', path: '/project', steps: [], workflows: [] }
  const gitState = useGitStore.getState(), projectState = useProjectStore.getState(), settingsState = useUserSettingsStore.getState()
  useGitStore.setState({ data: { projects: [{ id: 'p', name: 'Project', path: '/project' }], repositories: [], errors: [], depth: 5, scanned_at: 1 }, scan: async () => {} })
  useProjectStore.setState({ projects: [project] })
  useUserSettingsStore.setState({ loaded: true, load: async () => {} })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const source = '/chat?project=Project&session=s1#message'
  try {
    await act(async () => root.render(<I18nProvider><MemoryRouter initialEntries={[source]}><Location /><ProjectGitButton project={project} /></MemoryRouter></I18nProvider>))
    const entry = container.querySelector<HTMLButtonElement>('button')!
    entry.focus()
    await act(async () => entry.click())
    if (compact) {
      assert.equal(container.querySelector('output')?.textContent, '/git?project_id=p')
      assert.equal(document.querySelector('.git-window'), null)
    } else {
      assert.equal(container.querySelector('output')?.textContent, source)
      const dialog = document.querySelector<HTMLElement>('.git-window')!
      assert.ok(dialog)
      assert.equal(dialog.getAttribute('role'), 'dialog')
      assert.equal(dialog.querySelectorAll('.resizable-panel-handle').length, 8)
      assert.ok(dialog.querySelector('[data-dialog-drag-handle]'))
      await act(async () => dialog.querySelector<HTMLButtonElement>('.git-window-close')!.click())
      assert.equal(document.querySelector('.git-window'), null)
      assert.equal(document.activeElement, entry)
      await act(async () => entry.click())
      await act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
      assert.equal(document.querySelector('.git-window'), null)
      assert.equal(container.querySelector('output')?.textContent, source)
    }
  } finally {
    await act(async () => root.unmount())
    useGitStore.setState(gitState); useProjectStore.setState(projectState); useUserSettingsStore.setState(settingsState)
    container.remove(); await window.happyDOM.close()
  }
})
