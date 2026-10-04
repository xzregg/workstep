import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { JSDOM } from 'jsdom'
import { MemoryRouter } from 'react-router-dom'
import { AdminPlatformSettingsPage } from '../src/AdminPlatformSettingsPage'
import { AdminRegistrationPolicyDialog } from '../src/AdminRegistrationPolicyDialog'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://gateway.test/admin/settings',
})
Object.assign(globalThis, { window: dom.window, document: dom.window.document,
  HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver,
  Event: dom.window.Event })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
const { cleanup, fireEvent, render, screen } = await import('@testing-library/react')
const originalFetch = globalThis.fetch
afterEach(() => { cleanup(); globalThis.fetch = originalFetch })

test('platform settings retries loading and updates registration after step-up', async () => {
  const calls: Array<{ url: string; method: string }> = []
  let reads = 0
  let mode = 'open'
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    calls.push({ url, method: init?.method ?? 'GET' })
    if (url === '/api/admin/platform-settings') {
      if (reads++ === 0) return new Response(null, { status: 503 })
      return Response.json({ gateway_id: 'gateway-test', public_origin: 'https://gateway.test',
        registration_mode: mode, session_seconds: 86400, protocol_version: 3,
        data_dir: '/srv/workstep', database: { backend: 'postgresql', location: 'db.internal/app',
          healthy: true, migration_version: '0028_group_project_capabilities' } })
    }
    if (url === '/api/auth/session') return Response.json({ csrf_token: 'csrf' })
    if (url === '/api/auth/step-up') return Response.json({ expires_in_seconds: 300 })
    if (url === '/api/admin/registration-policy') {
      mode = JSON.parse(String(init?.body)).mode
      return Response.json({ mode })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  }
  render(<MemoryRouter><AdminPlatformSettingsPage /></MemoryRouter>)
  await screen.findByText(/平台设置加载失败/)
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  await screen.findByText('gateway-test')
  assert.match(document.body.textContent ?? '', /db.internal\/app/)
  fireEvent.click(screen.getByRole('button', { name: '修改注册策略' }))
  fireEvent.change(screen.getByLabelText('注册策略'), { target: { value: 'open_with_approval' } })
  fireEvent.change(screen.getByLabelText('管理员密码'), { target: { value: 'secret-password' } })
  fireEvent.click(screen.getByRole('button', { name: '保存策略' }))
  await screen.findByText(/当前策略：开放注册，管理员审核/)
  assert.equal(screen.queryByRole('dialog'), null)
  assert.ok(calls.some(call => call.url === '/api/auth/step-up' && call.method === 'POST'))
  assert.ok(calls.some(call => call.url === '/api/admin/registration-policy' && call.method === 'PUT'))
})

test('registration dialog protects an edited policy and retains failed submission', async () => {
  let closed = false
  let saved = false
  globalThis.fetch = async input => {
    if (String(input) === '/api/auth/step-up') return new Response(null, { status: 403 })
    throw new Error(`Unexpected fetch: ${input}`)
  }
  render(<AdminRegistrationPolicyDialog mode="open" csrf="csrf"
    onClose={() => { closed = true }} onSaved={() => { saved = true }} />)
  fireEvent.change(screen.getByLabelText('注册策略'), { target: { value: 'closed' } })
  fireEvent.click(screen.getByRole('button', { name: '取消' }))
  assert.equal(closed, false)
  assert.ok(screen.getByRole('dialog', { name: '放弃修改' }))
  fireEvent.click(screen.getByRole('dialog', { name: '放弃修改' }).querySelector('button')!)
  assert.equal(closed, false)
  fireEvent.change(screen.getByLabelText('管理员密码'), { target: { value: 'wrong' } })
  fireEvent.click(screen.getByRole('button', { name: '保存策略' }))
  await screen.findByText('密码验证失败。')
  assert.equal(saved, false)
  assert.equal(closed, false)
})
