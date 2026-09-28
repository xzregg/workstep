import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { fsApi } from '../src/api/client'
import { gitApi, type GitDiscovery } from '../src/api/git'
import { I18nProvider } from '../src/i18n'
import GitWorkspace from '../src/pages/GitWorkspace'
import { useGitStore } from '../src/stores/gitStore'
import { useProjectStore } from '../src/stores/projectStore'
import { useUserSettingsStore } from '../src/stores/userSettingsStore'
import { installDomEnvironment } from './helpers/domEnv'

function SourcePage() {
  const location = useLocation()
  return <output>{location.pathname + location.search + location.hash}</output>
}

test('Git page opens the selected worktree, including one outside the project root', async () => {
  const { window } = installDomEnvironment()
  const originalOpen = fsApi.openDirectory
  const originalOpeners = fsApi.directoryOpeners
  const originalStatus = gitApi.status
  const originalBranches = gitApi.branches
  const gitState = useGitStore.getState()
  const projectState = useProjectStore.getState()
  const settingsState = useUserSettingsStore.getState()
  const opened: string[] = []
  fsApi.directoryOpeners = async () => ({ openers: [{ id: 'file_manager', label: 'file_manager', available: true }] })
  fsApi.openDirectory = async path => { opened.push(path); return { path } }
  gitApi.status = async id => ({ id, path: '/elsewhere/tree', branch: 'dev', head: 'sha', files: [], snapshot: 's', operation: null, active: false, ahead: 0, behind: 0, upstream: null })
  gitApi.branches = async () => ({ branches: [], remote_branches: [] })
  const data = { projects: [{ id: 'p', name: 'Project', path: '/project' }], repositories: [{ id: 'r', name: 'Project', common_dir: '/project/.git', projects: [{ id: 'p', relative_path: '.' }], worktrees: [{ id: 'w', path: '/elsewhere/tree', branch: 'dev', head: 'sha', main: false, available: true, locked: false, prunable: false }, { id: 'w2', path: '/project/other', branch: 'feature', head: 'sha', main: false, available: true, locked: false, prunable: false }] }], depth: 5, scanned_at: 1, errors: [] } as GitDiscovery
  useGitStore.setState({ data, scan: async () => {} })
  useProjectStore.setState({ projects: [{ id: 'p', name: 'Project', path: '/project', steps: [], workflows: [] }] })
  useUserSettingsStore.setState({ loaded: true, load: async () => {} })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><MemoryRouter initialEntries={[{ pathname: '/git', search: '?project_id=p&worktree=w', state: { returnTo: '/chat?project=Project&session=s1#message' } }]}><Routes><Route path="/git" element={<GitWorkspace />} /><Route path="/chat" element={<SourcePage />} /></Routes></MemoryRouter></I18nProvider>))
    await act(async () => container.querySelector<HTMLButtonElement>('.git-open-location button')!.click())
    assert.deepEqual(opened, ['/elsewhere/tree'])
    await act(async () => container.querySelectorAll<HTMLButtonElement>('.git-tree-item')[1].click())
    await act(async () => container.querySelector<HTMLButtonElement>('.git-back-button')!.click())
    assert.equal(container.querySelector('output')?.textContent, '/chat?project=Project&session=s1#message')
  } finally {
    await act(async () => root.unmount())
    fsApi.openDirectory = originalOpen
    fsApi.directoryOpeners = originalOpeners
    gitApi.status = originalStatus
    gitApi.branches = originalBranches
    useGitStore.setState(gitState)
    useProjectStore.setState(projectState)
    useUserSettingsStore.setState(settingsState)
    container.remove()
    await window.happyDOM.close()
  }
})
