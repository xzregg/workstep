import assert from 'node:assert/strict'
import { test, afterEach } from 'node:test'
import { JSDOM } from 'jsdom'
import { MemoryRouter } from 'react-router-dom'
import { AdminUserTable } from '../src/AdminUserTable'
import { AdminAuditPage } from '../src/AdminAuditPage'
const dom = new JSDOM('<html><body></body></html>', { url: 'https://gateway.test' })
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle, SVGElement: dom.window.SVGElement, Element: dom.window.Element, ShadowRoot: dom.window.ShadowRoot })
dom.window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false }, media: '', onchange: null })
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
const { render, screen, cleanup } = await import('@testing-library/react')
const oldFetch = globalThis.fetch
afterEach(() => { cleanup(); globalThis.fetch = oldFetch })
const user = { id: 'user-id', display_name: '张三', username: 'alice', status: 'active' as const, registration_source: 'local', must_change_password: false, created_at: '2026-10-01T00:00:00Z', last_login_at: '2026-10-14T02:00:00Z' }
test('user table exposes last login and a scoped audit destination only when allowed', () => {
 const view = render(<AdminUserTable users={[user]} csrf="csrf" loading={false} resetKey="" onRefresh={() => {}} canViewAudit />)
 assert.ok(screen.getByRole('columnheader', { name: '上次登录时间' }))
 assert.ok(screen.getByRole('cell', { name: new Date(user.last_login_at).toLocaleString() }))
 assert.equal(screen.getByRole('link', { name: '张三的审计日志' }).getAttribute('href'), '/admin/audit?user_id=user-id')
 view.rerender(<AdminUserTable users={[user]} csrf="csrf" loading={false} resetKey="" onRefresh={() => {}} />)
 assert.equal(screen.queryByRole('link', { name: '张三的审计日志' }), null)
})
test('audit destination immediately searches the linked user and displays request IP', async () => {
 const urls: string[] = []
 globalThis.fetch = async input => { urls.push(String(input)); return Response.json({total: 1, items: [{ id: 'audit', action: 'auth.login', actor_name: '张三', actor_username: 'alice', actor_type: 'user', occurred_at: '2026-10-14T02:00:00Z', result: 'success', request_ip: '198.51.100.42', metadata: {} }]}) }
 render(<MemoryRouter initialEntries={['/admin/audit?user_id=user-id']}><AdminAuditPage /></MemoryRouter>)
 await screen.findByRole('cell', { name: '198.51.100.42' }, { timeout: 5000 })
 assert.ok(urls.every(url => new URL(url, 'https://gateway.test').searchParams.get('user_id') === 'user-id'))
 assert.equal((screen.getByLabelText('用户 ID') as HTMLInputElement).value, 'user-id')
})
