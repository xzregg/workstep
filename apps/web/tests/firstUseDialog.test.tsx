import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import FirstUseDialog from '../src/components/FirstUseDialog'
import { useUserSettingsStore } from '../src/stores/userSettingsStore'
import { useGatewayConnectionStore } from '../src/stores/gatewayConnectionStore'

test('gateway desktop opens platform authentication without requiring a local name', async () => {
  const { window } = installDomEnvironment()
  Object.defineProperty(window, 'workstepDesktop', { configurable:true, value:{ notify() {} } })
  useUserSettingsStore.setState({ loaded:false, loading:false, userName:'', identitySource:'local', error:'' })
  const original = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = async (input, init) => {
    calls.push(`${init?.method || 'GET'} ${input}`)
    if (String(input).endsWith('/system-settings')) return Response.json({ user_name:'', identity_source:'gateway', open_mode:false })
    if (String(input).endsWith('/settings')) return Response.json({ url:'http://localhost:8700', enabled:true, authenticated:false, online:false, pending_device:false, package_locked:false })
    assert.equal(String(input), '/api/gateway-platform/login')
    assert.deepEqual(JSON.parse(String(init?.body)), { url:'http://localhost:8700' })
    return Response.json({ authorization_url:'http://localhost:8700/desktop/login?state=test' })
  }
  const container = document.body.appendChild(document.createElement('div')); const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><FirstUseDialog /></I18nProvider>))
    assert.equal(container.querySelector('#first-use-name'), null)
    assert.equal(calls.filter(call => call === 'POST /api/gateway-platform/login').length, 1)
    assert.equal(window.location.pathname, '/desktop/login')
    assert.equal(calls.some(call => call.startsWith('PUT ')), false)
  } finally { await act(async () => root.unmount()); globalThis.fetch=original; container.remove(); await window.happyDOM.close() }
})

test('gateway restart waits for reconnect and opens authentication only once when required', async () => {
  const { window } = installDomEnvironment()
  Object.defineProperty(window, 'workstepDesktop', { configurable:true, value:{ notify() {} } })
  useUserSettingsStore.setState({ loaded:true, loading:false, userName:'', identitySource:'gateway', error:'' })
  const original = globalThis.fetch
  let reconnecting = true; let logins = 0
  globalThis.fetch = async (input) => {
    if (String(input).endsWith('/settings')) return Response.json({ url:'http://localhost:8700', enabled:true, authenticated:false, online:false, pending_device:false, package_locked:false, reconnecting })
    logins++; return new Response(null, { status:502 })
  }
  const container = document.body.appendChild(document.createElement('div')); const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><FirstUseDialog /></I18nProvider>))
    assert.equal(logins, 0)
    assert.equal(container.querySelector('#first-use-name'), null)
    reconnecting = false
    await act(async () => useGatewayConnectionStore.getState().refresh())
    assert.equal(logins, 1)
    assert.match(container.querySelector('[role=alert]')?.textContent || '', /无法连接平台/)
    await act(async () => useGatewayConnectionStore.getState().refresh())
    assert.equal(logins, 1)
    await act(async () => container.querySelector<HTMLButtonElement>('button')!.click())
    assert.equal(logins, 2)
  } finally { await act(async () => root.unmount()); globalThis.fetch=original; container.remove(); await window.happyDOM.close() }
})

test('local mode still saves a name and enters the workspace', async () => {
  const { window } = installDomEnvironment()
  Object.defineProperty(window, 'workstepDesktop', { configurable:true, value:{ notify() {} } })
  useUserSettingsStore.setState({ loaded:true, loading:false, userName:'', identitySource:'local', error:'' })
  const original = globalThis.fetch
  let saves = 0
  globalThis.fetch = async (_input, init) => {
    assert.equal(init?.method, 'PUT'); saves++
    assert.deepEqual(JSON.parse(String(init?.body)), { user_name:'123' })
    return Response.json({ user_name:'123', identity_source:'local', open_mode:false })
  }
  const container = document.body.appendChild(document.createElement('div')); const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><FirstUseDialog /></I18nProvider>))
    const input = container.querySelector<HTMLInputElement>('#first-use-name')!
    await act(async () => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, '123'); input.dispatchEvent(new window.Event('input', { bubbles:true })) })
    await act(async () => container.querySelector<HTMLButtonElement>('.modal-footer button')!.click())
    assert.equal(saves, 1)
    assert.equal(container.querySelector('#first-use-name'), null)
  } finally { await act(async () => root.unmount()); globalThis.fetch=original; container.remove(); await window.happyDOM.close() }
})
