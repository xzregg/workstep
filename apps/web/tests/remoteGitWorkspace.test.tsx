import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import GitWorkspace from '../src/pages/GitWorkspace'
import { I18nProvider } from '../src/i18n'
import { useProjectStore } from '../src/stores/projectStore'
import { useGitStore } from '../src/stores/gitStore'
import { useUserSettingsStore } from '../src/stores/userSettingsStore'

test('remote Git page loads only its project repositories and scopes worktree reads and settings', async () => {
  const { window } = installDomEnvironment()
  const projectId = 'remote:p'
  const originalFetch = globalThis.fetch
  const projectState = useProjectStore.getState()
  const gitState = useGitStore.getState()
  const settingsState = useUserSettingsStore.getState()
  let globalScans = 0, settingsLoads = 0
  useProjectStore.setState({ projects: [{ id: projectId, name: 'Remote', path: '/remote', type: 'remote', steps: {}, workflows: [] }] })
  useGitStore.setState({ data: null, scan: async () => { globalScans++ } })
  useUserSettingsStore.setState({ loaded: true, load: async () => { settingsLoads++ } })
  const calls: string[] = []
  globalThis.fetch = async input => {
    const url = new URL(String(input), window.location.href)
    calls.push(url.pathname)
    assert.equal(url.searchParams.get('project_id'), projectId)
    if (url.pathname.endsWith('/repositories')) return Response.json({ projects: [{ id: 'host', name: 'Remote', path: '/remote' }], repositories: [{ id: 'r', name: 'Remote', common_dir: '/remote/.git', projects: [{ id: 'host', relative_path: '.' }], worktrees: [{ id: 'w', path: '/remote', branch: 'dev', head: 'sha', main: true, available: true }] }], errors: [], depth: 5 })
    if (url.pathname.endsWith('/branches')) return Response.json({ branches: [] })
    if (url.pathname.endsWith('/status')) return Response.json({ id: 'w', path: '/remote', branch: 'dev', head: 'sha', files: [], snapshot: 's', operation: null, active: false, ahead: 0, behind: 0, upstream: null })
    if (url.pathname.endsWith('/identity')) return Response.json({ name: 'Demo', email: 'demo@example.com' })
    throw new Error(`unexpected endpoint: ${url.pathname}`)
  }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><MemoryRouter initialEntries={['/git?project_id=remote%3Ap']}><GitWorkspace /></MemoryRouter></I18nProvider>))
    assert.ok(calls.includes('/api/git/projects/remote%3Ap/repositories'))
    assert.ok(container.querySelector('.git-workspace'))
    assert.equal(globalScans, 0)
    assert.equal(settingsLoads, 0)
    await act(async () => container.querySelector<HTMLButtonElement>('.git-settings-toggle')!.click())
    assert.ok(container.querySelector('[name="gitIdentityName"]'))
    assert.equal(container.querySelector('[name="gitAuthToken"]'), null)
    assert.equal(container.querySelector('.git-scan-settings'), null)
    assert.ok(calls.every(path => !path.includes('/credentials')))
  } finally {
    await act(async () => root.unmount())
    globalThis.fetch = originalFetch
    useProjectStore.setState(projectState)
    useGitStore.setState(gitState)
    useUserSettingsStore.setState(settingsState)
    container.remove()
    await window.happyDOM.close()
  }
})


test('failed project repository scan does not claim no repository or offer initialization', async () => {
  const { window } = installDomEnvironment()
  const previousFetch = globalThis.fetch
  const previousProjects = useProjectStore.getState()
  const previousGit = useGitStore.getState()
  useProjectStore.setState({ projects: [{ id: 'remote:p', name: 'Remote', path: '/remote', type: 'remote', steps: {}, workflows: [] }] })
  useGitStore.setState({ data: null, scan: async () => {} })
  let failed = true
  globalThis.fetch = async () => failed
    ? Response.json({ detail: 'File is outside the allowed preview directory' }, { status: 403 })
    : Response.json({ projects: [], repositories: [], errors: [], depth: 5 })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><MemoryRouter initialEntries={['/git?project_id=remote%3Ap']}><GitWorkspace /></MemoryRouter></I18nProvider>))
    assert.match(container.textContent || '', /File is outside/)
    assert.doesNotMatch(container.textContent || '', /尚未发现 Git 仓库|检查扫描层级/)
    assert.equal(container.querySelector('.git-empty-actions'), null)
    failed = false
    await act(async () => container.querySelector<HTMLButtonElement>('.git-error button')!.click())
    assert.equal(container.querySelector('.git-error'), null)
    assert.match(container.textContent || '', /尚未发现 Git 仓库/)
  } finally {
    await act(async () => root.unmount())
    globalThis.fetch = previousFetch
    useProjectStore.setState(previousProjects)
    useGitStore.setState(previousGit)
    container.remove()
    await window.happyDOM.close()
  }
})
