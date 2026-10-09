import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import GatewayDesktopAuthentication from '../src/components/GatewayDesktopAuthentication'
import { I18nProvider } from '../src/i18n'

test('cancelled desktop authentication waits for manual retry', async () => {
  installDomEnvironment()
  window.location.href = 'http://127.0.0.1:8766/?gateway_auth=cancelled'
  window.workstepDesktop = {} as typeof window.workstepDesktop
  const previousFetch = globalThis.fetch
  const calls: string[] = []
  let destination = ''
  window.location.assign = value => { destination = String(value) }
  globalThis.fetch = async input => {
    calls.push(String(input))
    return new Response(JSON.stringify(String(input).endsWith('/login')
      ? { authorization_url: 'https://gateway.example/desktop/login' }
      : { url: 'https://gateway.example', enabled: true, authenticated: false,
          package_locked: false, pending_device: false, online: false }))
  }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><GatewayDesktopAuthentication /></I18nProvider>))
    assert.equal(calls.filter(url => url.endsWith('/login')).length, 0)
    assert.equal(destination, '')
    await act(async () => container.querySelector('button')!.click())
    assert.equal(calls.filter(url => url.endsWith('/login')).length, 1)
    assert.equal(destination, 'https://gateway.example/desktop/login')
  } finally {
    await act(async () => root.unmount())
    container.remove()
    globalThis.fetch = previousFetch
  }
})
