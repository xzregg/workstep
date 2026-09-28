import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { JSDOM } from 'jsdom'
import { MemoryRouter } from 'react-router-dom'
import { AdminCreateUserDialog } from '../src/AdminCreateUserDialog'
import { AdminUsersPage } from '../src/AdminUsersPage'
import { DeviceAdminPage } from '../src/DeviceAdminPage'
import { AdminGrantRoleDialog, AdminRevokeRoleDialog } from '../src/AdminRoleDialogs'
import { AdminRolesPage } from '../src/AdminRolesPage'
import type { AdminRole } from '../src/AdminRolesPage'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://gateway.test/admin/users' })
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  MutationObserver: dom.window.MutationObserver,
})
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
const { cleanup, fireEvent, render, screen, waitFor, within } = await import('@testing-library/react')
const originalFetch = globalThis.fetch

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
})

test('creating a user protects a changed form from accidental closure', () => {
  let closed = 0
  render(<AdminCreateUserDialog csrf="csrf" onSaved={() => {}} onClose={() => { closed++ }} />)
  fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'alice' } })
  const createDialog = screen.getByRole('dialog', { name: '创建用户' })
  fireEvent.click(within(createDialog).getByRole('button', { name: '取消' }))
  assert.equal(closed, 0)
  const confirm = screen.getByRole('dialog', { name: '放弃创建用户' })
  fireEvent.click(within(confirm).getByRole('button', { name: '取消' }))
  assert.equal(closed, 0)
  fireEvent.click(within(createDialog).getByRole('button', { name: '取消' }))
  fireEvent.click(within(screen.getByRole('dialog', { name: '放弃创建用户' }))
    .getByRole('button', { name: '放弃并关闭' }))
  assert.equal(closed, 1)
})

test('create user shows a server conflict and allows a successful retry', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), init })
    return new Response(null, { status: requests.length === 1 ? 409 : 201 })
  }
  let saved = 0
  render(<AdminCreateUserDialog csrf="csrf" onSaved={() => { saved++ }} onClose={() => {}} />)
  fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'alice' } })
  fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: 'Alice' } })
  fireEvent.change(screen.getByLabelText('初始密码（至少 12 位）'), { target: { value: 'strong-password-123' } })
  const submit = screen.getByRole('button', { name: '创建用户' })
  assert.equal((submit as HTMLButtonElement).disabled, false)
  fireEvent.click(submit)
  await screen.findByRole('alert')
  assert.match(screen.getByRole('alert').textContent ?? '', /用户名已存在/)
  fireEvent.click(submit)
  await waitFor(() => assert.equal(saved, 1))
  assert.equal(requests.length, 2)
  assert.equal(requests[0].init?.method, 'POST')
  assert.equal((requests[0].init?.headers as Record<string, string>)['X-CSRF-Token'], 'csrf')
})

test('user page searches server results and refreshes after approval', async () => {
  const requests: string[] = []
  globalThis.fetch = async (input) => {
    const url = String(input)
    requests.push(url)
    if (url === '/api/auth/session') return Response.json({ csrf_token: 'csrf' })
    if (url.startsWith('/api/admin/users?')) return Response.json({
      users: [{ id: 'user-1', username: 'alice', display_name: 'Alice', status: 'pending',
        registration_source: 'local', must_change_password: false, created_at: '2026-01-01' }], total: 1,
    })
    if (url === '/api/admin/users/user-1/approve') return new Response(null, { status: 204 })
    throw new Error(`Unexpected fetch: ${url}`)
  }
  render(<MemoryRouter><AdminUsersPage /></MemoryRouter>)
  await screen.findByText('Alice')
  fireEvent.change(screen.getByLabelText('搜索用户'), { target: { value: 'alice' } })
  fireEvent.click(screen.getByRole('button', { name: '搜索' }))
  await waitFor(() => assert.ok(requests.some(url => url.includes('q=alice'))))
  fireEvent.click(screen.getByRole('button', { name: '批准' }))
  const dialog = screen.getByRole('dialog', { name: '批准用户' })
  fireEvent.click(within(dialog).getByRole('button', { name: '批准' }))
  await waitFor(() => assert.ok(requests.filter(url => url.startsWith('/api/admin/users?')).length >= 3))
  assert.ok(requests.includes('/api/admin/users/user-1/approve'))
})

test('device page retries load errors and pages server results', async () => {
  const requests: string[] = []
  let fail = true
  globalThis.fetch = async input => {
    const url = String(input)
    requests.push(url)
    if (url === '/api/auth/session') return Response.json({ csrf_token: 'csrf' })
    if (url.startsWith('/api/admin/devices?')) {
      if (fail) { fail = false; return new Response(null, { status: 503 }) }
      return Response.json({ devices: [{ id: 'device-1', name: 'Alice PC', version: '1',
        status: 'pending', online: false }], total: 30 })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  }
  render(<DeviceAdminPage />)
  await screen.findByRole('alert')
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  await screen.findByText('Alice PC')
  fireEvent.change(screen.getByLabelText('搜索设备'), { target: { value: 'Alice' } })
  fireEvent.click(screen.getByRole('button', { name: '搜索' }))
  await waitFor(() => assert.ok(requests.some(url => url.includes('q=Alice'))))
  fireEvent.click(screen.getByRole('button', { name: '下一页' }))
  await waitFor(() => assert.ok(requests.some(url => url.includes('page=2'))))
})

test('grant dialog searches users and departments, validates scope, and submits with step-up', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    requests.push({ url, init })
    if (url.startsWith('/api/admin/users?')) return Response.json({ users: [
      { id: 'user-1', username: 'alice', display_name: 'Alice' }], total: 1 })
    if (url.startsWith('/api/admin/departments?')) return Response.json({ departments: [
      { id: 'dept-1', display_name: 'Research', provider: 'wecom', external_id: 'research' }], total: 1 })
    if (url === '/api/auth/step-up') return Response.json({ expires_in_seconds: 300 })
    if (url === '/api/admin/users/user-1/roles') return new Response(null, { status: 201 })
    throw new Error(`Unexpected fetch: ${url}`)
  }
  let saved = 0
  render(<AdminGrantRoleDialog csrf="csrf" onSaved={() => { saved++ }} onClose={() => {}} />)
  fireEvent.change(screen.getByLabelText('搜索用户'), { target: { value: 'alice' } })
  fireEvent.click(screen.getByRole('button', { name: '查找用户' }))
  await screen.findByRole('option', { name: 'Alice（alice）' })
  fireEvent.change(screen.getByLabelText('选择用户'), { target: { value: 'user-1' } })
  fireEvent.change(screen.getByLabelText('管理范围'), { target: { value: 'department' } })
  fireEvent.change(screen.getByLabelText('搜索部门'), { target: { value: 'Research' } })
  fireEvent.click(screen.getByRole('button', { name: '查找部门' }))
  await screen.findByRole('option', { name: /Research/ })
  fireEvent.change(screen.getByLabelText('选择部门'), { target: { value: 'dept-1' } })
  fireEvent.change(screen.getByLabelText('输入你的密码确认'), { target: { value: 'OwnerPassphrase-2026!' } })
  fireEvent.click(screen.getByRole('button', { name: '授予权限' }))
  await waitFor(() => assert.equal(saved, 1))
  const grant = requests.find(request => request.url === '/api/admin/users/user-1/roles')
  assert.deepEqual(JSON.parse(String(grant?.init?.body)), { role: 'identity_admin', scope_type: 'department',
    scope_id: 'dept-1', include_subdepartments: true })
})

test('grant dialog protects changes when closing', () => {
  let closed = 0
  render(<AdminGrantRoleDialog csrf="csrf" onSaved={() => {}} onClose={() => { closed++ }} />)
  fireEvent.change(screen.getByLabelText('搜索用户'), { target: { value: 'alice' } })
  fireEvent.click(within(screen.getByRole('dialog', { name: '授予管理员权限' })).getByRole('button', { name: '取消' }))
  assert.equal(closed, 0)
  fireEvent.click(within(screen.getByRole('dialog', { name: '放弃授权' })).getByRole('button', { name: '放弃并关闭' }))
  assert.equal(closed, 1)
})

test('roles page retries a failed list and refreshes after revoke', async () => {
  const role: AdminRole = { id: 'role-1', user_id: 'user-1', username: 'alice', display_name: 'Alice',
    user_status: 'active', registration_source: 'local', role: 'identity_admin', scope_type: 'platform',
    scope_id: null, include_subdepartments: false, granted_by_user_id: null, created_at: '2026-01-01' }
  const requests: string[] = []
  let failed = true
  globalThis.fetch = async input => {
    const url = String(input)
    requests.push(url)
    if (url === '/api/auth/session') return Response.json({ csrf_token: 'csrf' })
    if (url.startsWith('/api/admin/roles?')) {
      if (failed) { failed = false; return new Response(null, { status: 503 }) }
      return Response.json({ roles: [role], total: 1 })
    }
    if (url === '/api/auth/step-up') return Response.json({ expires_in_seconds: 300 })
    if (url === '/api/admin/roles/role-1') return new Response(null, { status: 204 })
    throw new Error(`Unexpected fetch: ${url}`)
  }
  render(<MemoryRouter><AdminRolesPage /></MemoryRouter>)
  await screen.findByRole('alert')
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  await screen.findByText('Alice')
  fireEvent.click(screen.getByRole('button', { name: '撤销' }))
  fireEvent.change(screen.getByLabelText('输入你的密码确认'), { target: { value: 'password' } })
  fireEvent.click(screen.getByRole('button', { name: '确认撤销' }))
  await waitFor(() => assert.ok(requests.filter(url => url.startsWith('/api/admin/roles?')).length >= 3))
  assert.ok(requests.includes('/api/admin/roles/role-1'))
})

test('revoke role dialog keeps an error available for recovery', async () => {
  const role: AdminRole = { id: 'role-1', user_id: 'user-1', username: 'alice', display_name: 'Alice',
    user_status: 'active', registration_source: 'local', role: 'super_admin', scope_type: 'platform',
    scope_id: null, include_subdepartments: false, granted_by_user_id: null, created_at: '2026-01-01' }
  globalThis.fetch = async input => String(input) === '/api/auth/step-up'
    ? Response.json({ expires_in_seconds: 300 }) : new Response(null, { status: 409 })
  let completed = 0
  render(<AdminRevokeRoleDialog role={role} csrf="csrf" onComplete={() => { completed++ }} onClose={() => {}} />)
  fireEvent.change(screen.getByLabelText('输入你的密码确认'), { target: { value: 'password' } })
  fireEvent.click(screen.getByRole('button', { name: '确认撤销' }))
  await screen.findByRole('alert')
  assert.match(screen.getByRole('alert').textContent ?? '', /最后一名本地超级管理员/)
  assert.equal(completed, 0)
})
