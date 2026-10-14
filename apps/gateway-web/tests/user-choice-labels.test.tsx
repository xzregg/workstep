import assert from 'node:assert/strict'
import { test, afterEach } from 'node:test'
import { JSDOM } from 'jsdom'
import { AdminProviderAssignments } from '../src/AdminProviderAssignments'
import { AdminDeviceOwnerDialog } from '../src/AdminDeviceOwnerDialog'
const dom = new JSDOM('<html><body></body></html>', { url: 'https://gateway.test' })
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
const { render, screen, fireEvent, cleanup } = await import('@testing-library/react')
const oldFetch = globalThis.fetch
afterEach(() => { cleanup(); globalThis.fetch = oldFetch })
for (const kind of ['provider', 'owner']) test(`${kind} choices show enterprise names without exposing generated login identifiers`, async () => {
 globalThis.fetch = async input => String(input).includes('/users?') ? Response.json({ users: [
  { id: 'external', display_name: '张三', username: 'ext_abcdef123', login_username: null, status: 'active' },
  { id: 'local', display_name: '李四', username: 'lisi', login_username: 'lisi', status: 'active' },
 ], total: 2 }) : Response.json({ assignments: [], total: 0 })
 if (kind === 'provider') {
  render(<AdminProviderAssignments providerId="provider" enabled csrf="csrf" onChanged={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: '新增分配' }))
 } else render(<AdminDeviceOwnerDialog device={{ id: 'device', name: 'PC', status: 'active', online: true, version: '1', app_instance_id: null }} csrf="csrf" onClose={() => {}} onComplete={() => {}} />)
 await screen.findByRole('option', { name: '张三（企业扫码用户）' })
 assert.ok(screen.getByRole('option', { name: '李四（lisi）' }))
 assert.equal(document.body.textContent?.includes('ext_abcdef123'), false)
})
