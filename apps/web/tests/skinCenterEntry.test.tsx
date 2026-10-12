import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import SkinCenterEntry from '../src/components/SkinCenterEntry'
import { I18nProvider } from '../src/i18n'
import { skinsApi } from '../src/api/skins'
import { useGatewaySessionStore } from '../src/stores/gatewaySessionStore'

for (const projectScoped of [false, true]) test(`direct mobile skin entry opens the center for ${projectScoped ? 'project' : 'device'} access with the correct creation boundary`, async () => {
  const { window } = installDomEnvironment()
  Object.defineProperty(globalThis, 'history', { configurable: true, value: window.history })
  window.happyDOM.setURL('http://d-device.localhost:8700/')
  const oldList = skinsApi.list
  skinsApi.list = async () => []
  useGatewaySessionStore.setState({ session: { device_id: 'device', device_name: 'PC', username: 'Tester', gateway_url: 'http://localhost:8700', project_id: projectScoped ? 'platform' : null, host_project_id: projectScoped ? 'project' : null, access_level: projectScoped ? 'read' : null, task_create: false, share_create: false, can_manage_project_access: false } })
  const element = document.body.appendChild(document.createElement('div')), root = createRoot(element)
  try {
    await act(async () => root.render(<MemoryRouter><I18nProvider><SkinCenterEntry /></I18nProvider></MemoryRouter>))
    await act(async () => element.querySelector<HTMLButtonElement>('button')!.click())
    assert.ok(document.querySelector('.skin-center-dialog'))
    assert.ok(document.querySelector('.skin-settings-workspace'))
    const hasCreate = [...document.querySelectorAll('button')].some(button => button.textContent?.includes('聊天制作皮肤'))
    assert.equal(hasCreate, !projectScoped)
    assert.ok(document.querySelector('.skin-settings-preview-stage'))
  } finally {
    await act(async () => root.unmount()); element.remove(); skinsApi.list = oldList
    useGatewaySessionStore.setState({ session: null }); await window.happyDOM.close()
  }
})
