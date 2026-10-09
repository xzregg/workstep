import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { installDomEnvironment } from './helpers/domEnv'
import { I18nProvider } from '../src/i18n/index.tsx'
import GatewayConnectionStatus from '../src/components/GatewayConnectionStatus.tsx'
import GatewayPlatformSettings from '../src/pages/GatewayPlatformSettings.tsx'
import { useGatewayConnectionStore } from '../src/stores/gatewayConnectionStore.ts'

test('header shares gateway status requests and reflects live connection changes', async () => {
  const { window } = installDomEnvironment()
  const original = globalThis.fetch
  let calls = 0; let online = false; let opened = 0
  globalThis.fetch = async () => { calls++; return Response.json({ url:'http://localhost:8700', enabled:true, authenticated:true, online, pending_device:false, package_locked:false }) }
  const container = document.body.appendChild(document.createElement('div')); const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><GatewayConnectionStatus onOpenSettings={() => opened++} /><GatewayPlatformSettings /></I18nProvider>))
    assert.equal(calls, 1)
    assert.match(container.querySelector('.gateway-connection-status')!.textContent!, /连接中/)
    await act(async () => container.querySelector<HTMLButtonElement>('.gateway-connection-status')!.click())
    assert.equal(opened, 1)
    online = true
    await act(async () => useGatewayConnectionStore.getState().refresh())
    assert.match(container.querySelector('.gateway-connection-status')!.textContent!, /已连接/)
    assert.match(container.querySelector('.gateway-platform-settings [role=status]')!.textContent!, /已连接/)
  } finally { await act(async () => root.unmount()); globalThis.fetch = original; container.remove(); await window.happyDOM.close() }
})


test('gateway workspace never requests device gateway settings', async () => {
 const { window } = installDomEnvironment()
 window.history.replaceState({}, '', '/workspace/device-1/chat')
 const original = globalThis.fetch
 let calls = 0
 globalThis.fetch = async () => { calls++; return Response.json({}, { status: 403 }) }
 const container = document.body.appendChild(document.createElement('div'))
 const root = createRoot(container)
 try {
  await act(async () => root.render(<I18nProvider><GatewayPlatformSettings /></I18nProvider>))
  assert.equal(calls, 0)
  assert.equal(container.querySelector<HTMLInputElement>('#gateway-platform-url')?.disabled, true)
  await act(async () => useGatewayConnectionStore.getState().refresh())
  assert.equal(calls, 0)
 } finally {
  await act(async () => root.unmount()); globalThis.fetch = original
  container.remove(); await window.happyDOM.close()
 }
})
