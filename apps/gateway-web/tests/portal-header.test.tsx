import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { PortalHeader } from '../src/PortalHeader'

test('portal navigation marks the current page and separates sign-in from workspace destinations', () => {
 const html = renderToString(<MemoryRouter initialEntries={['/devices']}><PortalHeader hasAdminAccess /></MemoryRouter>)
 assert.match(html, /aria-label="工作台导航"/)
 assert.match(html, /aria-current="page"[^>]*href="\/devices"/)
 assert.doesNotMatch(html, /aria-current="page"[^>]*href="\/"/)
 assert.match(html, /管理后台/)
 assert.match(html, /class="gateway-portal-sign-in"/)
})

test('portal navigation omits management access for a regular account', () => {
 const html = renderToString(<MemoryRouter><PortalHeader hasAdminAccess={false} /></MemoryRouter>)
 assert.doesNotMatch(html, /管理后台/)
 assert.match(html, /个人账户/)
 assert.match(html, /登录 \/ 注册/)
})
