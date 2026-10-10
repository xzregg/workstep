import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { installDomEnvironment } from './helpers/domEnv'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import { useGatewayConnectionStore } from '../src/stores/gatewayConnectionStore'
import { projectApi, remoteProjectApi } from '../src/api/client'
import ProjectShareDialog from '../src/components/ProjectShareDialog'
import ProjectSharingTabs from '../src/components/ProjectSharingTabs'

for (const dialog of [false, true]) for (const url of ['', 'https://gateway.test']) test(`unified project sharing: dialog=${dialog}, gateway=${Boolean(url)}`, async () => {
  const { window } = installDomEnvironment()
  useLocaleStore.setState({ locale: 'zh-CN' })
  const originalRefresh = useGatewayConnectionStore.getState().refresh
  const status = { url, enabled: false, authenticated: false, online: false, pending_device: false, package_locked: false }
  useGatewayConnectionStore.setState({ status, refresh: async () => status })
  const originalPublication = projectApi.publication
  const originalDevices = remoteProjectApi.devices
  const originalCreate = remoteProjectApi.createShare
  let devices = 0
  let duration: 'permanent' | 'week' = 'permanent'
  projectApi.publication = async () => ({ project_id: null, status: 'unpublished', grants: [], can_manage: false, can_publish: false, gateway_url: url })
  remoteProjectApi.devices = async () => { devices++; return { devices: [] } }
  remoteProjectApi.createShare = async (projectId, access, expiresAt) => {
    assert.equal(projectId, 'host-1')
    assert.equal(access, 'internal')
    if (duration === 'permanent') assert.equal(expiresAt, null)
    else assert.ok(expiresAt && Math.abs(expiresAt - (Date.now() / 1000 + 7 * 86400)) < 5)
    return { share_string: 'demo-invitation', endpoint: '', expires_at: 2000000000, access_expires_at: null }
  }
  const element = document.body.appendChild(document.createElement('div'))
  const root = createRoot(element)
  try {
    await act(async () => root.render(<I18nProvider>{dialog
      ? <ProjectShareDialog project={{ id: 'host-1', name: 'Demo', path: '/tmp/demo', workflows: [], steps: [] }} onClose={() => {}} />
      : <ProjectSharingTabs projectId="host-1" />}
    </I18nProvider>))
    const tabs = [...element.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    assert.deepEqual(tabs.map(tab => tab.textContent), url ? ['平台访问', '远程访问'] : ['远程访问'])
    assert.equal(tabs[0].getAttribute('aria-selected'), 'true')
    if (url) {
      assert.equal(devices, 0)
      await act(async () => tabs[1].click())
    }
    assert.equal(devices, 1)
    const generate = [...element.querySelectorAll('button')].find(button => button.textContent === '生成分享字符串')
    assert.ok(generate)
    await act(async () => generate.click())
    assert.equal(element.querySelector<HTMLTextAreaElement>('textarea')?.value, 'demo-invitation')
    assert.ok(element.textContent?.includes('当前在线'))
    if (url) {
      await act(async () => tabs[0].click())
      await act(async () => tabs[1].click())
      assert.equal(element.querySelector<HTMLTextAreaElement>('textarea')?.value, 'demo-invitation')
    }
    const select = element.querySelector<HTMLSelectElement>('select')!
    duration = 'week'
    await act(async () => { select.value = 'week'; select.dispatchEvent(new window.Event('change', { bubbles: true })) })
    await act(async () => generate.click())

  } finally {
    await act(async () => root.unmount())
    projectApi.publication = originalPublication
    remoteProjectApi.devices = originalDevices
    remoteProjectApi.createShare = originalCreate
    useGatewayConnectionStore.setState({ status: null, refresh: originalRefresh })
    await window.happyDOM.close()
  }
})
