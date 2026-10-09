import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { JSDOM } from 'jsdom'
import { AdminDeviceOwnerDialog } from '../src/AdminDeviceOwnerDialog'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://gateway.test/admin/devices' })
Object.assign(globalThis, { window: dom.window, document: dom.window.document,
  HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver, Event: dom.window.Event })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
const { cleanup, fireEvent, render, screen, within, waitFor } = await import('@testing-library/react')
const originalFetch = globalThis.fetch
afterEach(() => { cleanup(); globalThis.fetch = originalFetch })

const device = { id: 'pc-1', name: '电脑 A', status: 'active', online: true, version: '1', app_instance_id: null, owner_user_id: 'a', owner_name: '用户 A' }
test('owner transfer validates selection, protects edits, and submits explicit ownership', async () => {
 let saved = 0, closed = 0
 const writes: RequestInit[] = []
 globalThis.fetch = async (input, init) => {
  if (String(input).startsWith('/api/admin/users')) return Response.json({ users: [
   { id: 'a', username: 'alice', status: 'active' }, { id: 'b', username: 'bob', status: 'active' },
   { id: 'disabled', username: 'disabled', status: 'disabled' },
  ] })
  if (String(input) === '/api/auth/step-up') return new Response(null, { status: 200 })
  assert.equal(String(input), '/api/admin/devices/pc-1/owner')
  writes.push(init!); return new Response(null, { status: 204 })
 }
 render(<AdminDeviceOwnerDialog device={device} csrf="csrf" onComplete={() => saved++} onClose={() => closed++} />)
 await screen.findByRole('option', { name: 'bob · bob' })
 assert.equal(screen.queryByRole('option', { name: 'alice · alice' }), null)
 assert.equal(screen.queryByRole('option', { name: 'disabled · disabled' }), null)
 assert.equal((screen.getByRole('button', { name: '确认转移' }) as HTMLButtonElement).disabled, true)
 fireEvent.change(screen.getByLabelText('新所有者（最多显示 25 人，可搜索）'), { target: { value: 'b' } })
 fireEvent.change(screen.getByLabelText('输入管理员密码确认'), { target: { value: 'password' } })
 fireEvent.click(screen.getByRole('button', { name: '取消' }))
 assert.equal(closed, 0)
 fireEvent.click(within(screen.getByRole('dialog', { name: '放弃转移' })).getByRole('button', { name: '取消' }))
 fireEvent.click(screen.getByRole('button', { name: '确认转移' }))
 await waitFor(() => assert.equal(saved, 1))
 assert.deepEqual(JSON.parse(String(writes[0].body)), { user_id: 'b' })
 assert.equal(writes[0].method, 'PUT')
})
