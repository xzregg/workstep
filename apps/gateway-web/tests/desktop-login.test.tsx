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
  assert.match(html, /WorkStep 桌面端登录/)
  assert.match(html, /正在检查登录状态/)
})
