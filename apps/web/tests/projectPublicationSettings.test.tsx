import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { projectApi } from '../src/api/client'
import ProjectPublicationSettings from '../src/components/ProjectPublicationSettings'
import ProjectSettingsPanel from '../src/components/ProjectSettingsPanel'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import { useManagedModeStore } from '../src/stores/managedModeStore'
import { useGatewayConnectionStore } from '../src/stores/gatewayConnectionStore'

test('managed local project settings shows grants and safely changes publication', async () => {
  installDomEnvironment()
  useLocaleStore.setState({ locale: 'zh-CN' })
  const originalStatus = projectApi.publication
  const originalSet = projectApi.setPublication
  let published = true
  const changes: boolean[] = []
  projectApi.publication = async () => ({
    project_id: published ? 'platform-1' : null,
    status: published ? 'published' : 'unpublished',
    grants: published ? [
      { subject_type: 'group', subject_id: 'group-1', subject_name: 'Backend', access_level: 'read' },
      { subject_type: 'user', subject_id: 'user-1', subject_name: 'Alice', access_level: 'edit' },
    ] : [],
    can_manage: true, can_publish: true, can_invite: true, gateway_url: 'https://gateway.test',
  })
  projectApi.setPublication = async (_projectId, next) => {
    changes.push(next)
    published = next
    return { status: next ? 'published' : 'unpublished', project_id: 'platform-1' }
  }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider>
      <ProjectPublicationSettings projectId="host-1" />
    </I18nProvider>))
    assert.match(container.textContent ?? '', /用户组 · Backend · 只读/)
    assert.match(container.textContent ?? '', /用户 · Alice · 可编辑/)
    assert.equal(container.querySelector('a')?.getAttribute('href'), 'https://gateway.test/admin/projects')
    const invite = [...container.querySelectorAll('a')].find(link => link.textContent === '分享项目（网关邀请）')
    assert.equal(invite?.getAttribute('href'), 'https://gateway.test/project-invitations?project_id=platform-1')
    const unpublish = [...container.querySelectorAll('button')].find(button => button.textContent === '取消发布')
    assert.ok(unpublish)
    await act(async () => unpublish.click())
    assert.equal(changes.length, 0)
    const confirm = [...container.querySelectorAll('button')].find(button => button.textContent === '确认取消发布')
    assert.ok(confirm)
    await act(async () => confirm.click())
    assert.deepEqual(changes, [false])
    assert.match(container.textContent ?? '', /尚未发布/)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    projectApi.publication = originalStatus
    projectApi.setPublication = originalSet
  }
})

for (const url of ['', 'https://gateway.test']) test(`share contains access authorization only with a Gateway address: ${url}`, async () => {
  installDomEnvironment()
  useLocaleStore.setState({ locale: 'zh-CN' })
  useManagedModeStore.setState({ managed: false, loading: false })
  const originalRefresh = useGatewayConnectionStore.getState().refresh
  const status = { url, enabled: false, authenticated: false, online: false, pending_device: false, package_locked: false }
  useGatewayConnectionStore.setState({ status, refresh: async () => status })
  const originalSettings = projectApi.settings
  const originalStatus = projectApi.publication
  projectApi.settings = async () => ({
    name: 'Project', path: '/tmp/project', chat_system_prompt: '', quick_buttons: [],
    concurrency: { global: { max_tasks: 0, max_chats: 0, schedule_exempt: false },
      project: { max_tasks: null, max_chats: null, schedule_exempt: null },
      effective: { max_tasks: 0, max_chats: 0, schedule_exempt: false } },
  })
  projectApi.publication = async () => ({ project_id: null, status: 'unpublished',
    grants: [], can_manage: false, can_publish: false, gateway_url: 'https://gateway.test' })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><ProjectSettingsPanel
      project={{ id: 'host-1', name: 'Project', path: '/tmp/project', steps: [], workflows: [], type: 'local' }}
      onClose={() => {}} /></I18nProvider>))
    assert.equal([...container.querySelectorAll('button')].some(button => button.textContent === '访问授权'), false)
    const share = [...container.querySelectorAll('button')].find(button => button.textContent === '分享')!
    await act(async () => share.click())
    const tab = container.querySelector<HTMLButtonElement>('[role="tab"][data-share-tab="gateway"]')
    assert.equal(Boolean(tab), Boolean(url))
    if (tab) {
      await act(async () => tab.click())
      assert.match(container.textContent ?? '', /尚未发布到 Gateway/)
    }
  } finally {
    await act(async () => root.unmount())
    container.remove()
    projectApi.settings = originalSettings
    projectApi.publication = originalStatus
    useManagedModeStore.setState({ managed: null })
    useGatewayConnectionStore.setState({ status: null, refresh: originalRefresh })
  }
})
