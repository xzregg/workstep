import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import GatewayLogoutButton from '../src/components/GatewayLogoutButton'
import { I18nProvider } from '../src/i18n'

for (const mode of ['local', 'remote', 'failed'] as const) test(`Gateway logout: ${mode}`, async () => {
  installDomEnvironment()
  if (mode === 'remote') window.location.href = 'http://localhost/workspace/device-a/settings'
  const previousFetch = globalThis.fetch
  const calls: string[] = []
  let navigated = ''
  window.location.assign = (url: string | URL) => { navigated = String(url) }
  globalThis.fetch = async (input, options) => {
    calls.push(String(input))
    if (mode === 'failed') return new Response('{}', { status: 500 })
    if (String(input).endsWith('/api/auth/session')) return new Response(JSON.stringify({ csrf_token: 'csrf' }))
    if (String(input).endsWith('/api/auth/logout')) {
      assert.equal(options?.method, 'POST')
      assert.equal((options?.headers as Record<string, string>)['X-CSRF-Token'], 'csrf')
    }
    return new Response('{}')
  }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><GatewayLogoutButton /></I18nProvider>))
    await act(async () => {
      container.querySelector('button')!.click()
      container.querySelector('button')!.click()
    })
    if (mode === 'failed') {
      assert.ok(container.querySelector('[role="alert"]'))
      assert.equal(navigated, '')
      assert.equal(container.querySelector('button')!.disabled, false)
    } else if (mode === 'remote') {
      assert.deepEqual(calls, ['http://localhost/api/auth/session', 'http://localhost/api/auth/logout'])
      assert.equal(navigated, 'http://localhost/auth')
    } else {
      assert.deepEqual(calls, ['/api/gateway-platform/logout'])
      assert.equal(navigated, '/gateway/login')
    }
  } finally {
    await act(async () => root.unmount())
    container.remove(); globalThis.fetch = previousFetch
  }
})
