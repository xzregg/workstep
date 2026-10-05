import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { App } from '../src/App'
import { parseDesktopRequest } from '../src/DesktopLoginPage'

const query = '?gateway_id=gateway-test&app_instance_id=app-instance-12345'
  + '&state=state-0123456789ABCDEFGHIJKLMNOP&nonce=nonce-0123456789ABCDEFGHIJKLMNOP'
  + '&code_challenge=' + 'A'.repeat(43)

test('desktop login route parses only complete PKCE request', () => {
  assert.equal(parseDesktopRequest(query)?.gateway_id, 'gateway-test')
  assert.equal(parseDesktopRequest(query + '&scan_error=expired')?.gateway_id, 'gateway-test')
  assert.equal(parseDesktopRequest(query + '&unexpected=value'), null)
  assert.equal(parseDesktopRequest('?gateway_id=gateway-test'), null)
  assert.equal(parseDesktopRequest(query.replace('A'.repeat(43), 'bad')), null)
  const html = renderToString(<MemoryRouter initialEntries={[`/desktop/login${query}`]}><App /></MemoryRouter>)
  assert.match(html, /WorkStep 平台认证/)
  assert.match(html, /正在检查登录状态/)
})

test('platform login accepts mobile callback entries and rejects malformed redirects', () => {
  for (const origin of ['http://192.168.1.10:8765', 'https://workstep.example.com', 'http://[fd00::1]:8765']) {
    const redirect = origin + '/api/gateway-platform/callback'
    const request = parseDesktopRequest(query + '&redirect_uri=' + encodeURIComponent(redirect))
    assert.equal(request?.redirect_uri, redirect)
  }
  for (const redirect of ['javascript:alert(1)', 'https://user:pass@example.com/api/gateway-platform/callback', 'https://example.com/other', 'https://example.com/api/gateway-platform/callback?x=1', 'https://example.com\\evil/api/gateway-platform/callback']) {
    assert.equal(parseDesktopRequest(query + '&redirect_uri=' + encodeURIComponent(redirect)), null)
  }
  assert.equal(parseDesktopRequest(query + '&redirect_uri=' + encodeURIComponent('https://example.com/api/gateway-platform/callback') + '&redirect_uri=other'), null)
})
