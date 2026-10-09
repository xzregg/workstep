import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { remoteProjectApi, type RemoteDevice } from '../src/api/client'
import RemoteDeviceAccessList from '../src/components/RemoteDeviceAccessList'
import { I18nProvider, useLocaleStore } from '../src/i18n'

test('revoked share devices disappear immediately and stay hidden after loading', async () => {
  installDomEnvironment()
  useLocaleStore.setState({ locale: 'zh-CN' })
  const device = (id: string, overrides: Partial<RemoteDevice> = {}): RemoteDevice => ({
    project_id: 'project-1', device_id: id, device_name: id, user_name: id,
    connected: false, revoked: false, status: 'active', expires_at: null,
    authorized_at: 0, last_seen_at: 0, ...overrides,
  })
  const originalRevoke = remoteProjectApi.revokeDevice
  const calls: string[] = []
  remoteProjectApi.revokeDevice = async (_projectId, deviceId) => {
    calls.push(deviceId)
    return { revoked: true }
  }
  function Harness() {
    const [devices, setDevices] = useState([
      device('status-revoked', { status: 'revoked' }),
      device('legacy-revoked', { revoked: true }),
      device('active-device'),
    ])
    return <RemoteDeviceAccessList devices={devices} onError={() => {}}
      onDeviceChange={next => setDevices(current => current.map(item => item.device_id === next.device_id ? next : item))} />
  }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><Harness /></I18nProvider>))
    assert.doesNotMatch(container.textContent ?? '', /status-revoked|legacy-revoked|已撤销/)
    assert.match(container.textContent ?? '', /active-device/)
    await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === '撤销')!.click())
    assert.deepEqual(calls, [])
    await act(async () => [...document.querySelectorAll('button')].filter(button => button.textContent === '撤销').at(-1)!.click())
    assert.deepEqual(calls, ['active-device'])
    assert.doesNotMatch(container.textContent ?? '', /active-device|已撤销/)
    assert.match(container.textContent ?? '', /暂无已授权的远端设备/)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    remoteProjectApi.revokeDevice = originalRevoke
  }
})
