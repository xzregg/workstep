import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import GitWorkspace from '../src/pages/GitWorkspace'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import { useGatewaySessionStore } from '../src/stores/gatewaySessionStore'
import { useProjectStore } from '../src/stores/projectStore'
import { installDomEnvironment } from './helpers/domEnv'

test('standalone Git uses project-scoped reads and independently hides local, remote and configuration actions', async () => {
  const { window } = installDomEnvironment()
  window.happyDOM.setURL('http://d-device.localhost:8700/')
  useLocaleStore.setState({ locale: 'zh-CN' })
  const originalFetch = globalThis.fetch, projectState = useProjectStore.getState()
  useProjectStore.setState({ projects: [{ id: 'host', name: 'Demo', path: '/demo', steps: {}, workflows: [] }] })
  const setPermissions = (permissions: string[]) => useGatewaySessionStore.setState({ session: {
    device_id: 'device', device_name: 'PC', username: 'Alice', gateway_url: 'http://localhost:8700',
    project_id: 'platform', host_project_id: 'host', access_level: 'edit', task_create: true,
    share_create: false, can_manage_project_access: false, permissions,
  } })
  setPermissions(['git.read'])
  const calls: string[] = []
  globalThis.fetch = async input => {
    const url = new URL(String(input), window.location.href); calls.push(url.pathname + url.search)
    assert.equal(url.searchParams.get('project_id'), 'host')
    if (url.pathname.endsWith('/repositories')) return Response.json({ projects: [{ id: 'host', name: 'Demo', path: '/demo' }], repositories: [{ id: 'r', name: 'Demo', common_dir: '/demo/.git', projects: [{ id: 'host', relative_path: '.' }], worktrees: [{ id: 'w', path: '/demo', branch: 'dev', head: 'sha', main: true, available: true }] }], errors: [], depth: 5 })
    if (url.pathname.endsWith('/branches')) return Response.json({ branches: [] })
    if (url.pathname.endsWith('/status')) return Response.json({ id: 'w', path: '/demo', branch: 'dev', head: 'sha', files: [], snapshot: 's', operation: null, active: false, ahead: 0, behind: 0, upstream: null })
    if (url.pathname.endsWith('/identity')) return Response.json({ name: 'Demo', email: 'demo@example.com' })
    throw new Error(`unexpected endpoint: ${url.pathname}`)
  }
  const element = document.body.appendChild(document.createElement('div')), root = createRoot(element)
  try {
    await act(async () => root.render(<I18nProvider><MemoryRouter initialEntries={['/git?project_id=host']}><GitWorkspace /></MemoryRouter></I18nProvider>))
    assert.ok(calls.some(path => path.includes('/git/projects/host/repositories')))
    assert.ok(element.querySelector('.git-workspace'))
    assert.equal(element.querySelector('.git-settings-toggle'), null)
    assert.equal(element.querySelector('.git-branch-popover'), null)
    assert.equal(element.querySelector('.git-commit-form'), null)
    assert.equal(element.querySelectorAll('.git-remote-actions button').length, 0)
    await act(async () => setPermissions(['git.read', 'git.remote']))
    assert.ok(element.querySelector('.git-remote-actions button'))
    assert.equal(element.querySelector('.git-branch-popover'), null)
    await act(async () => setPermissions(['git.read', 'git.config']))
    const config = element.querySelector<HTMLButtonElement>('.git-settings-toggle')!
    assert.ok(config)
    await act(async () => config.click())
    assert.ok(element.querySelector('[name="gitIdentityName"]'))
    assert.equal(element.querySelector('[name="gitAuthToken"]'), null)
    assert.doesNotMatch(element.textContent ?? '', /保存全局|认证令牌/)
    await act(async () => setPermissions(['git.read']))
    assert.equal(element.querySelector('[name="gitIdentityName"]'), null)
  } finally {
    await act(async () => root.unmount()); globalThis.fetch = originalFetch
    useGatewaySessionStore.setState({ session: null }); useProjectStore.setState(projectState); await window.happyDOM.close()
  }
})
