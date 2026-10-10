import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import ProjectSettingsPanel from '../src/components/ProjectSettingsPanel'
import GatewayTaskShareLink from '../src/components/GatewayTaskShareLink'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import { useGatewaySessionStore } from '../src/stores/gatewaySessionStore'

for (const canInvite of [false, true]) test(`remote settings expose sharing with owner invitation permission: ${canInvite}`, async () => {
  const { window } = installDomEnvironment()
  useLocaleStore.setState({ locale: 'zh-CN' })
  window.happyDOM.setURL('http://d-device-1.localhost:8700/')
  const oldFetch = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = async input => {
    calls.push(String(input))
    assert.equal(String(input), '/api/remote/project-grants')
    return Response.json({ can_invite: canInvite, grants: [{ subject_type: 'group', subject_id: 'group-1',
      subject_name: 'Backend', access_level: 'read' }] })
  }
  useGatewaySessionStore.setState({ session: {
    device_id: 'device-1', device_name: 'PC', username: 'Alice', gateway_url: 'http://localhost:8700/devices',
    project_id: 'platform-1', host_project_id: 'host-1', access_level: 'edit',
    task_create: false, share_create: true, can_manage_project_access: false,
  } })
  const element = document.body.appendChild(document.createElement('div'))
  const root = createRoot(element)
  try {
    await act(async () => root.render(<I18nProvider>
      <ProjectSettingsPanel project={{ id: 'host-1', name: 'Visible', path: '', workflows: [], steps: {} }} onClose={() => {}} />
      <GatewayTaskShareLink taskId="task-1" projectId="host-1" />
    </I18nProvider>))
    assert.equal(calls.length, 0)
    const shareTab = [...element.querySelectorAll('button')].find(button => button.textContent === '分享')
    assert.ok(shareTab)
    await act(async () => shareTab.click())
    assert.match(element.textContent ?? '', /用户组 · Backend · 只读/)
    assert.deepEqual(calls, ['/api/remote/project-grants'])
    assert.equal([...element.querySelectorAll('a')].some(link => link.getAttribute('href') ===
      'http://localhost:8700/project-invitations?project_id=platform-1'), canInvite)
    assert.equal(element.querySelector('.task-detail-share-button')?.tagName, 'BUTTON')
    assert.equal(element.querySelector('.task-detail-share-button')?.getAttribute('href'), null)
    await act(async () => useGatewaySessionStore.setState(state => ({
      session: { ...state.session!, share_create: false, can_manage_project_access: true },
    })))
    assert.equal(element.querySelector('.task-detail-share-button'), null)
  } finally {
    await act(async () => root.unmount())
    element.remove()
    globalThis.fetch = oldFetch
    useGatewaySessionStore.setState({ session: null, loading: false, error: '' })
    await window.happyDOM.close()
  }
})

test("device-wide gateway session resolves the task project before showing share", async () => {
  const { window } = installDomEnvironment()
  window.happyDOM.setURL("http://d-device-1.localhost:8700/")
  const oldFetch = globalThis.fetch
  const calls: string[] = []
  useGatewaySessionStore.setState({ session: {
    device_id: "device-1", device_name: "PC", username: "Alice", gateway_url: "http://localhost:8700/devices",
    project_id: null, host_project_id: null, access_level: null,
    task_create: false, share_create: false, can_manage_project_access: false,
  } })
  globalThis.fetch = async (input, init) => {
    calls.push(String(input))
    if (String(input).endsWith('/revoke')) return new Response(null, { status: 204 })
    if (String(input) === '/api/remote/task-shares' && init?.method === 'POST') {
      assert.equal(JSON.parse(String(init.body)).project_id, 'platform-2')
      return Response.json({ id: 'share-2', url: 'http://localhost:8700/share/new-token', status: 'active', mode: 'interactive', title: '' })
    }
    if (String(input).includes('/remote/task-shares?')) return Response.json({ shares: [] })
    return Response.json({ ...useGatewaySessionStore.getState().session,
      project_id: "platform-2", host_project_id: "host-2", share_create: true })
  }
  const element = document.body.appendChild(document.createElement("div"))
  const root = createRoot(element)
  try {
    await act(async () => root.render(<I18nProvider><GatewayTaskShareLink taskId="task-2" projectId="host-2" /></I18nProvider>))
    assert.deepEqual(calls, ["/api/remote/session?project_id=host-2"])
    const shareButton = element.querySelector<HTMLButtonElement>('.task-detail-share-button')
    assert.ok(shareButton)
    await act(async () => shareButton.click())
    assert.ok(document.body.textContent?.includes('访问密码'))
    assert.ok(document.body.textContent?.includes('只读'))
    assert.ok(document.body.textContent?.includes('过期时间'))
    assert.equal(window.location.pathname, '/')
    assert.ok(calls.includes('/api/remote/task-shares?project_id=platform-2&task_id=task-2'))
    const modeButton = [...document.body.querySelectorAll('button')].find(button => button.textContent === '可交互')
    assert.ok(modeButton)
    await act(async () => modeButton.click())
    const closeButton = document.querySelector<HTMLButtonElement>('[role="dialog"] button[aria-label="关闭"]')
    assert.ok(closeButton)
    await act(async () => closeButton.click())
    assert.ok(document.body.textContent?.includes('放弃分享配置？'))
    const cancelButton = [...document.querySelectorAll('button')].find(button => button.textContent === '取消')
    assert.ok(cancelButton)
    await act(async () => cancelButton.click())
    const createButton = [...document.body.querySelectorAll('button')].find(button => button.textContent === '生成分享链接')
    assert.ok(createButton)
    await act(async () => createButton.click())
    assert.equal(document.querySelector<HTMLInputElement>('[role="dialog"] input[readonly]')?.value, 'http://localhost:8700/share/new-token')
    assert.equal(window.location.pathname, '/')
    assert.equal(useGatewaySessionStore.getState().session?.project_id, null)
  } finally {
    await act(async () => root.unmount())
    globalThis.fetch = oldFetch
    useGatewaySessionStore.setState({ session: null })
    await window.happyDOM.close()
  }
})
