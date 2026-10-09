import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { JSDOM } from 'jsdom'
import { MemoryRouter } from 'react-router-dom'
import { DesktopLoginPage } from '../src/DesktopLoginPage'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://gateway.test/desktop/login' })
Object.assign(globalThis, { window: dom.window, document: dom.window.document,
  HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver, Event: dom.window.Event })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
const { cleanup, fireEvent, render, screen } = await import('@testing-library/react')
const originalFetch = globalThis.fetch
afterEach(() => { cleanup(); globalThis.fetch = originalFetch })

for (const failed of [false, true]) test(`switch account preserves local callback, logout failure=${failed}`, async () => {
  let logouts = 0
  const query = new URLSearchParams({ gateway_id: 'gateway', app_instance_id: 'app',
    state: 's'.repeat(32), nonce: 'n'.repeat(32), code_challenge: 'A'.repeat(43),
    redirect_uri: 'http://127.0.0.1:8765/api/gateway-platform/callback' })
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url === '/api/auth/logout') {
      logouts++
      assert.equal(init?.method, 'POST')
      assert.equal((init?.headers as Record<string, string>)['X-CSRF-Token'], 'csrf-current')
      return new Response('{}', { status: failed ? 500 : 200 })
    }
    if (url === '/api/auth/session') return Response.json({ csrf_token: 'csrf-current' })
    if (url === '/api/auth/registration-policy') return Response.json({ password_login_enabled: true })
    if (url === '/api/auth/identity-sources') return Response.json({ sources: [] })
    throw Error(`Unexpected request: ${url}`)
  }
  render(<MemoryRouter initialEntries={['/desktop/login?' + query]}><DesktopLoginPage /></MemoryRouter>)
  fireEvent.click(await screen.findByRole('button', { name: '登出并切换账号' }))
  if (failed) {
    assert.match((await screen.findByRole('alert')).textContent!, /登出失败/)
    assert.ok(screen.getByRole('button', { name: '登出并切换账号' }))
  } else {
    assert.ok(await screen.findByRole('button', { name: '登录并继续' }))
  }
  assert.equal(logouts, 1)
  assert.equal(screen.getByRole('link', { name: '返回本地工作台' }).getAttribute('href'),
    'http://127.0.0.1:8765/?gateway_auth=cancelled')
})
