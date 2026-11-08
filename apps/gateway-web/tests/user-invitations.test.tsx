import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { JSDOM } from 'jsdom'
import { MemoryRouter } from 'react-router-dom'
import { UserInvitationButton } from '../src/UserInvitationButton'
import { UserInvitationPage } from '../src/UserInvitationPage'
import { AdminUserTable } from '../src/AdminUserTable'

const dom = new JSDOM('<html><body></body></html>', { url: 'https://gateway.test/admin/users' })
Object.assign(globalThis, { window: dom.window, document: dom.window.document,
  HTMLElement: dom.window.HTMLElement, getComputedStyle: dom.window.getComputedStyle, ShadowRoot: dom.window.ShadowRoot, MutationObserver: dom.window.MutationObserver, Event: dom.window.Event })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
const { render, screen, fireEvent, waitFor, cleanup } = await import('@testing-library/react')
const originalFetch = globalThis.fetch
afterEach(() => { cleanup(); globalThis.fetch = originalFetch })

test('invitation action copies the existing link and shows a floating success message', async () => {
  const copied: string[] = []
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { copied.push(text) } } })
  let requests = 0
  globalThis.fetch = async (url, init) => {
    assert.equal(url, '/api/admin/users/user-1/invitation')
    assert.equal(init?.method, 'POST')
    assert.equal((init?.headers as any)['X-CSRF-Token'], 'csrf')
    requests++; return Response.json({ url: '/auth/invite#token-1' })
  }
  render(<UserInvitationButton userId="user-1" csrf="csrf" disabled={false} />)
  fireEvent.click(screen.getByRole('button', { name: '获取邀请链接' }))
  await waitFor(() => assert.equal(copied.length, 1))
  await screen.findByText('复制成功')
  assert.equal(screen.getByText('复制成功').closest('.gateway-user-invitation'), null)
  fireEvent.click(screen.getByRole('button', { name: '获取邀请链接' }))
  await waitFor(() => assert.equal(copied.length, 2))
  assert.deepEqual(copied, ['https://gateway.test/auth/invite#token-1', 'https://gateway.test/auth/invite#token-1'])
})

test('clipboard failure shows a floating error without adding fields to the table', async () => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw Error('denied') } } })
  globalThis.fetch = async () => Response.json({ url: '/auth/invite#manual-token' })
  render(<UserInvitationButton userId="user-1" csrf="csrf" disabled={false} />)
  fireEvent.click(screen.getByRole('button', { name: '获取邀请链接' }))
  await screen.findByText('复制失败，请允许浏览器访问剪贴板后重试。')
  assert.equal(screen.queryByLabelText('邀请链接'), null)
})

test('activation asks only for credentials, supports conflict retry and consumes on submit', async () => {
  let accepted = 0
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body))
    assert.equal(body.token, 'secret-token')
    if (String(url).endsWith('/inspect')) return Response.json({ display_name: '邀请用户' })
    accepted++
    assert.equal(body.display_name, undefined)
    assert.equal(body.password, 'InvitePassphrase-2026!')
    return accepted === 1 ? new Response(null, { status: 409 }) : Response.json({ status: 'active' })
  }
  render(<MemoryRouter initialEntries={['/auth/invite#secret-token']}><UserInvitationPage /></MemoryRouter>)
  await screen.findByText(/你好，邀请用户/)
  assert.equal(accepted, 0)
  assert.equal(screen.queryByLabelText('显示名称'), null)
  const submit = screen.getByRole('button', { name: '完成设置' }) as HTMLButtonElement
  assert.equal(submit.disabled, true)
  fireEvent.change(screen.getByLabelText('登录名'), { target: { value: 'invitee' } })
  fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'InvitePassphrase-2026!' } })
  fireEvent.change(screen.getByLabelText('确认密码'), { target: { value: 'different' } })
  assert.equal(submit.disabled, true)
  fireEvent.change(screen.getByLabelText('确认密码'), { target: { value: 'InvitePassphrase-2026!' } })
  fireEvent.click(submit)
  await screen.findByText(/登录名已被使用/)
  fireEvent.change(screen.getByLabelText('登录名'), { target: { value: 'newname' } })
  fireEvent.click(submit)
  await screen.findByText('账号设置成功，邀请链接已失效。')
  assert.equal(screen.queryByLabelText('密码'), null)
  assert.equal(screen.getByRole('link', { name: '前往登录' }).getAttribute('href'), '/auth')
})

test('invalid invitations do not show a credentials form', async () => {
  globalThis.fetch = async () => new Response(null, { status: 410 })
  render(<MemoryRouter initialEntries={['/auth/invite#expired-token']}><UserInvitationPage /></MemoryRouter>)
  await screen.findByText(/邀请链接已失效/)
  assert.equal(screen.queryByLabelText('密码'), null)
})

test('existing login name is prefilled and password reset signs the user in', async () => {
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/inspect')) return Response.json({ display_name: '邀请用户', username: 'existing' })
    const body = JSON.parse(String(init?.body))
    assert.equal(body.username, 'existing')
    return Response.json({ status: 'active', signed_in: true })
  }
  render(<MemoryRouter initialEntries={['/auth/invite#reset-token']}><UserInvitationPage /></MemoryRouter>)
  await screen.findByText(/你好，邀请用户/)
  assert.equal((screen.getByLabelText('登录名') as HTMLInputElement).value, 'existing')
  fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'ResetPassphrase-2026!' } })
  fireEvent.change(screen.getByLabelText('确认密码'), { target: { value: 'ResetPassphrase-2026!' } })
  fireEvent.click(screen.getByRole('button', { name: '完成设置' }))
  await screen.findByText('账号设置成功并已登录，邀请链接已失效。')
  assert.equal(screen.getByRole('link', { name: '进入工作台' }).getAttribute('href'), '/')
})

test('user table allows invitation links for existing passwords and pending activation', () => {
  const base = { username: 'internal', display_name: '邀请用户', status: 'active' as const,
    registration_source: 'admin_created', must_change_password: false, created_at: '', login_username: null }
  render(<AdminUserTable users={[
    { ...base, id: 'one', activation_pending: true },
    { ...base, id: 'two', activation_pending: false },
    { ...base, id: 'three', status: 'disabled', activation_pending: true },
  ]} csrf="csrf" loading={false} resetKey="one" onRefresh={() => {}} />)
  assert.equal(screen.getAllByRole('button', { name: '获取邀请链接' }).length, 2)
  assert.equal(screen.getAllByText('待激活').length, 1)
})
