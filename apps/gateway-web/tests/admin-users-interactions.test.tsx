import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { JSDOM } from 'jsdom'
import { MemoryRouter } from 'react-router-dom'
import { AdminCreateUserDialog } from '../src/AdminCreateUserDialog'
import { AdminUsersPage } from '../src/AdminUsersPage'

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
