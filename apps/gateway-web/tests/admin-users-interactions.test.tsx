import { AdminEditUserDialog } from '../src/AdminEditUserDialog'
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { JSDOM } from 'jsdom'
import { MemoryRouter } from 'react-router-dom'
import { AdminCreateUserDialog } from '../src/AdminCreateUserDialog'
import { AdminUsersPage } from '../src/AdminUsersPage'
import { DeviceAdminPage, deviceDisplayName } from '../src/DeviceAdminPage'
import { AdminGrantRoleDialog, AdminRevokeRoleDialog } from '../src/AdminRoleDialogs'
import { AdminRolesPage } from '../src/AdminRolesPage'
import type { AdminRole } from '../src/AdminRolesPage'
import { AdminOverviewPage } from '../src/AdminOverviewPage'
import { App } from '../src/App'
import { AdminOrgPage } from '../src/AdminOrgPage'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://gateway.test/admin/users' })
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  MutationObserver: dom.window.MutationObserver,
  Event: dom.window.Event,
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
  fireEvent.change(screen.getByLabelText('初始密码（至少 8 位）'), { target: { value: 'strong-password-123' } })
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
  assert.equal((screen.getByLabelText('设备状态') as HTMLSelectElement).value, '')
  assert.ok(requests.filter(url => url.startsWith('/api/admin/devices?')).every(url => !new URLSearchParams(url.split('?')[1]).has('status')))
  assert.ok(screen.getByText('离线'))
  fireEvent.change(screen.getByLabelText('搜索设备'), { target: { value: 'Alice' } })
  fireEvent.click(screen.getByRole('button', { name: '搜索' }))
  await waitFor(() => assert.ok(requests.some(url => url.includes('q=Alice'))))
  fireEvent.click(screen.getByRole('button', { name: '下一页' }))
  await waitFor(() => assert.ok(requests.some(url => url.includes('page=2'))))
})

test('disabled device can be reenabled through an administrator confirmation', async () => {
  let status = 'disabled'
  globalThis.fetch = async input => {
    const url = String(input)
    if (url === '/api/auth/session') return Response.json({ csrf_token: 'csrf' })
    if (url.startsWith('/api/admin/devices?')) return Response.json({ devices: [
      { id: 'device-1', name: 'Alice PC', version: '1', status, online: false },
    ], total: 1 })
    if (url === '/api/auth/step-up') return new Response(null, { status: 200 })
    if (url === '/api/admin/devices/device-1/approve') {
      status = 'active'; return new Response(null, { status: 204 })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  }
  render(<DeviceAdminPage />)
  fireEvent.click(await screen.findByRole('button', { name: '重新启用' }))
  const dialog = screen.getByRole('dialog', { name: '重新启用设备' })
  fireEvent.change(within(dialog).getByLabelText('输入管理员密码确认'), { target: { value: 'test-admin-password' } })
  fireEvent.click(within(dialog).getByRole('button', { name: '确认重新启用' }))
  await screen.findByRole('button', { name: '停用' })
  assert.equal(status, 'active')
})

test('revoked device offers a name edit and explains why reenable is unavailable', async () => {
  globalThis.fetch = async input => {
    const url = String(input)
    if (url === '/api/auth/session') return Response.json({ csrf_token: 'csrf' })
    if (url.startsWith('/api/admin/devices?')) return Response.json({ devices: [
      { id: 'device-1', name: 'Container PC', version: '1', status: 'revoked', online: false },
    ], total: 1 })
    throw new Error(`Unexpected fetch: ${url}`)
  }
  render(<DeviceAdminPage />)
  fireEvent.click(await screen.findByRole('button', { name: '修改名称' }))
  assert.ok(screen.getByRole('dialog', { name: '修改设备名称' }))
  assert.equal((screen.getByLabelText('设备名称') as HTMLInputElement).value, 'Container PC')
  assert.equal(screen.queryByRole('button', { name: '重新启用' }), null)
  assert.ok(screen.getByText(/该设备身份已撤销，不能直接重新启用。/))
})

test('permanent deletion is available for revoked devices and refreshes the list after confirmation', async () => {
  let deleted = false
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url === '/api/auth/session') return Response.json({ csrf_token: 'csrf' })
    if (url.startsWith('/api/admin/devices?')) return Response.json({ devices: deleted ? [] : [
      { id: 'device-1', name: 'Container PC', version: '1', status: 'revoked', online: false },
    ], total: deleted ? 0 : 1 })
    if (url === '/api/auth/step-up') return new Response(null, { status: 200 })
    assert.equal(url, '/api/admin/devices/device-1')
    assert.equal(init?.method, 'DELETE')
    deleted = true; return new Response(null, { status: 204 })
  }
  render(<DeviceAdminPage />)
  fireEvent.click(await screen.findByRole('button', { name: '彻底删除' }))
  const dialog = screen.getByRole('dialog', { name: '彻底删除设备' })
  assert.match(dialog.textContent ?? '', /本机项目和文件保留/)
  assert.match(dialog.textContent ?? '', /重新登记/)
  const confirm = within(dialog).getByRole('button', { name: '确认彻底删除' }) as HTMLButtonElement
  assert.equal(confirm.disabled, true)
  fireEvent.change(within(dialog).getByLabelText('输入管理员密码确认'), { target: { value: 'test-password' } })
  fireEvent.click(confirm)
  await screen.findByText('当前筛选下没有设备。')
  assert.equal(deleted, true)
})

test('device page distinguishes outdated and unknown client versions', async () => {
  globalThis.fetch = async input => {
    const url = String(input)
    if (url === '/api/auth/session') return Response.json({ csrf_token: 'csrf' })
    if (url.startsWith('/api/admin/devices?')) return Response.json({ devices: [
      { id: 'old', name: 'Old PC', version: '1.2.0', status: 'active', online: true,
        connection_ip: '2001:db8::7', daemon_health: true, latest_version: '1.10.0', update_available: true },
      { id: 'legacy', name: 'Legacy PC', version: '1.0.0', status: 'active', online: false,
        daemon_health: null, latest_version: null, update_available: null },
    ], total: 2 })
    throw new Error(`Unexpected fetch: ${url}`)
  }
  render(<DeviceAdminPage />)
  fireEvent.change(await screen.findByLabelText('设备状态'), { target: { value: 'active' } })
  const old = (await screen.findByText('Old PC')).closest('tr')!
  const legacy = screen.getByText('Legacy PC').closest('tr')!
  assert.match(old.textContent ?? '', /连接 IP：2001:db8::7/)
  assert.match(legacy.textContent ?? '', /离线，暂无连接 IP/)
  assert.match(old.textContent ?? '', /有新版本 1\.10\.0/)
  assert.match(legacy.textContent ?? '', /版本状态未知/)
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
  fireEvent.change(screen.getByLabelText('搜索管理范围'), { target: { value: 'Research' } })
  fireEvent.click(screen.getByRole('button', { name: '查找范围' }))
  await screen.findByRole('option', { name: /Research/ })
  fireEvent.change(screen.getByLabelText('选择管理范围'), { target: { value: 'dept-1' } })
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

test('overview distinguishes control connectivity from daemon health and recovers from load errors', async () => {
  let calls = 0
  globalThis.fetch = async input => {
    assert.equal(String(input), '/api/admin/overview')
    calls++
    if (calls === 1) return new Response(null, { status: 503 })
    return Response.json({ roles: ['super_admin'], users: { total: 4, pending: 1 },
      devices: { total: 2, online: 1, offline: 1, pending: 0,
        daemon_healthy: 0, daemon_unhealthy: 1, daemon_unknown: 0 },
      projects: { published: 2, shared: 1, host_offline: 1 },
      tasks: { running: null, unknown_projects: 1 },
      recent_actions: [] })
  }
  render(<MemoryRouter><AdminOverviewPage /></MemoryRouter>)
  await screen.findByRole('alert')
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  await screen.findByText(/daemon 健康：0 台正常/)
  assert.match(document.body.textContent ?? '', /1 台控制连接在线/)
  assert.match(document.body.textContent ?? '', /1 台异常/)
  assert.match(document.body.textContent ?? '', /运行状态尚未全部上报/)
  assert.match(document.body.textContent ?? '', /1 个项目状态未知/)
  assert.equal(calls, 2)
  assert.ok(screen.queryByRole('navigation', { name: '管理模块' }) === null, 'overview should use the shared sidebar navigation')
  assert.ok(screen.queryByRole('link', { name: '返回工作台' }) === null, 'workbench navigation belongs to the shared layout')
})

test('normal users cannot see or directly enter management routes', async () => {
  globalThis.fetch = async input => {
    const url = String(input)
    if (url === '/api/auth/admin-access') return Response.json({ roles: [], must_change_password: false })
    if (url === '/api/auth/session') return Response.json({ user: { username: 'alice' }, csrf_token: 'csrf' })
    if (url === '/api/projects') return Response.json({ projects: [] })
    throw new Error(`Unexpected fetch: ${url}`)
  }
  render(<MemoryRouter initialEntries={['/admin/users']}><App /></MemoryRouter>)
  await screen.findByText('当前账号没有访问该管理页面的权限。')
  assert.equal(screen.queryByRole('link', { name: '管理后台' }), null)
  assert.equal(screen.queryByRole('heading', { name: '用户管理' }), null)
})

test('management navigation and module routes respect current roles', async () => {
  globalThis.fetch = async input => {
    const url = String(input)
    if (url === '/api/auth/admin-access') return Response.json({ roles: ['identity_admin'], must_change_password: false })
    if (url === '/api/auth/session') return Response.json({ user: { username: 'alice' }, csrf_token: 'csrf' })
    if (url.startsWith('/api/admin/users?')) return Response.json({ users: [], total: 0 })
    if (url === '/api/projects') return Response.json({ projects: [] })
    throw new Error(`Unexpected fetch: ${url}`)
  }
  render(<MemoryRouter initialEntries={['/admin/users']}><App /></MemoryRouter>)
  await screen.findByRole('heading', { name: '用户管理' })
  assert.ok(screen.getByRole('navigation', { name: '管理菜单' }))
  cleanup()
  render(<MemoryRouter initialEntries={['/admin/admins']}><App /></MemoryRouter>)
  await screen.findByText('当前账号没有访问该管理页面的权限。')
  assert.equal(screen.queryByRole('heading', { name: '管理员权限' }), null)
  cleanup()
  render(<MemoryRouter initialEntries={['/admin/device-operations']}><App /></MemoryRouter>)
  await screen.findByText('当前账号没有访问该管理页面的权限。')
  assert.equal(screen.queryByRole('heading', { name: '设备批量作业' }), null)
  cleanup()
  render(<MemoryRouter initialEntries={['/admin/projects']}><App /></MemoryRouter>)
  await screen.findByText('当前账号没有访问该管理页面的权限。')
  assert.equal(screen.queryByRole('heading', { name: '项目管理' }), null)
  cleanup()
  render(<MemoryRouter initialEntries={['/admin/audit']}><App /></MemoryRouter>)
  await screen.findByText('当前账号没有访问该管理页面的权限。')
  assert.equal(screen.queryByRole('heading', { name: '审计记录' }), null)
  cleanup()
  render(<MemoryRouter initialEntries={['/admin/settings']}><App /></MemoryRouter>)
  await screen.findByText('当前账号没有访问该管理页面的权限。')
  assert.equal(screen.queryByRole('heading', { name: '平台设置' }), null)
})

test('audit administrator can enter scoped ledger workbenches without broader admin modules', async () => {
  globalThis.fetch = async input => {
    const url = String(input)
    if (url === '/api/auth/admin-access') return Response.json({ roles: ['audit_admin'], must_change_password: false })
    if (url.startsWith('/api/admin/audit?')) return Response.json({ items: [], total: 0 })
    if (url === '/api/admin/overview') return Response.json({ roles: ['audit_admin'], users: null,
      devices: null, projects: null, tasks: { running: null }, recent_actions: [] })
    throw new Error(`Unexpected fetch: ${url}`)
  }
  render(<MemoryRouter initialEntries={['/admin/audit']}><App /></MemoryRouter>)
  await screen.findByRole('heading', { name: '审计记录' })
  cleanup()
  render(<MemoryRouter initialEntries={['/admin']}><App /></MemoryRouter>)
  await screen.findByRole('heading', { name: '管理概览' })
  within(screen.getByRole('navigation', { name: '管理菜单' })).getByText('统计与审计').closest('details')!.open = true
  assert.ok(screen.getByRole('link', { name: '审计记录' }))
  assert.ok(screen.getByRole('link', { name: '用量与对账' }))
  assert.equal(screen.queryByRole('link', { name: '平台设置' }), null)
})

test('Skill administrator enters only the Skill management module', async () => {
  globalThis.fetch = async input => {
    const url = String(input)
    if (url === '/api/auth/admin-access') return Response.json({
      roles: ['skill_admin'], must_change_password: false,
    })
    if (url === '/api/auth/session') return Response.json({ csrf_token: 'csrf' })
    if (url === '/api/admin/skills') return Response.json({ skills: [] })
    if (url === '/api/admin/groups') return Response.json({ groups: [] })
    if (url === '/api/admin/skills/applications') return Response.json({ projects: [] })
    if (url === '/api/admin/overview') return Response.json({ roles: ['skill_admin'],
      users: null, devices: null, projects: null, tasks: { running: null }, recent_actions: [] })
    if (url === '/api/projects') return Response.json({ projects: [] })
    throw new Error(`Unexpected fetch: ${url}`)
  }
  render(<MemoryRouter initialEntries={['/admin/skills']}><App /></MemoryRouter>)
  await screen.findByRole('heading', { name: '平台 Skill 管理' })
  cleanup()
  render(<MemoryRouter initialEntries={['/admin']}><App /></MemoryRouter>)
  await screen.findByRole('heading', { name: '管理概览' })
  within(screen.getByRole('navigation', { name: '管理菜单' })).getByText('资源管理').closest('details')!.open = true
  assert.ok(screen.getByRole('link', { name: 'Skills 管理' }))
  assert.equal(screen.queryByRole('link', { name: '用户管理' }), null)
  cleanup()
  render(<MemoryRouter initialEntries={['/admin/users']}><App /></MemoryRouter>)
  await screen.findByText('当前账号没有访问该管理页面的权限。')
  cleanup()
  render(<MemoryRouter initialEntries={['/admin/groups']}><App /></MemoryRouter>)
  await screen.findByText('当前账号没有访问该管理页面的权限。')
})

test('management tab appears after signing in on the workbench', async () => {
  let signedIn = false
  globalThis.fetch = async input => {
    const url = String(input)
    if (url === '/api/platform/status') return Response.json({ initialized: true })
    if (url === '/api/auth/registration-policy') return Response.json({ mode: 'open', password_login_enabled: true })
    if (url === '/api/auth/admin-access') return signedIn
      ? Response.json({ roles: ['super_admin'], must_change_password: false })
      : new Response(null, { status: 401 })
    if (url === '/api/auth/session') return signedIn
      ? Response.json({ user: { username: 'owner' }, csrf_token: 'csrf' })
      : new Response(null, { status: 401 })
    if (url === '/api/auth/login') { signedIn = true; return Response.json({ csrf_token: 'csrf' }) }
    if (url === '/api/projects') return Response.json({ projects: [] })
    throw new Error(`Unexpected fetch: ${url}`)
  }
  render(<MemoryRouter initialEntries={['/']}><App /></MemoryRouter>)
  await screen.findByRole('button', { name: '登录' })
  assert.equal(screen.queryByRole('link', { name: '管理后台' }), null)
  fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'owner' } })
  fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'password' } })
  fireEvent.click(screen.getByRole('button', { name: '登录' }))
  await screen.findByRole('link', { name: '管理后台' })
})

test('management access check can be retried after a transient failure', async () => {
  let calls = 0
  globalThis.fetch = async input => {
    const url = String(input)
    if (url === '/api/auth/admin-access') {
      calls++
      return calls === 1 ? new Response(null, { status: 503 })
        : Response.json({ roles: ['super_admin'], must_change_password: false })
    }
    if (url === '/api/admin/overview') return Response.json({ roles: ['super_admin'], users: null,
      devices: null, projects: null, tasks: { running: null }, recent_actions: [] })
    throw new Error(`Unexpected fetch: ${url}`)
  }
  render(<MemoryRouter initialEntries={['/admin']}><App /></MemoryRouter>)
  await screen.findByRole('alert')
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  await screen.findByRole('heading', { name: '管理概览' })
  assert.equal(calls, 2)
})

test('organization page browses a source, its departments and direct members', async () => {
  const requests: string[] = []
  globalThis.fetch = async input => {
    const url = String(input)
    requests.push(url)
    if (url === '/api/auth/session') return Response.json({ csrf_token: 'csrf' })
    if (url.startsWith('/api/admin/identity-sources?')) return Response.json({ sources: [
      { id: 'source-1', provider: 'wecom', tenant_id: 'tenant-a', client_id: 'app', enabled: true,
        callback_configured: true, created_at: '2026-01-01', pending_callbacks: 2,
        oldest_pending_at: '2026-01-01T00:00:00Z', sync_state: {
          last_attempt_at: '2026-01-02T00:00:00Z', last_success_at: '2026-01-01T00:00:00Z',
          last_error_code: 'provider_unavailable', cursor: 'cursor-1',
          changes: { people_added: 1, departments_added: 1 },
        } }], total: 1 })
    if (url.includes('parent_id=dept-1')) return Response.json({ departments: [
      { id: 'dept-2', source_id: 'source-1', provider: 'wecom', tenant_id: 'tenant-a',
        external_id: 'platform', display_name: 'Platform', parent_external_id: 'engineering',
        active: true, direct_members: 0, child_count: 0 }], total: 1 })
    if (url.startsWith('/api/admin/org/departments?')) return Response.json({ departments: [
      { id: 'dept-1', source_id: 'source-1', provider: 'wecom', tenant_id: 'tenant-a',
        external_id: 'engineering', display_name: 'Engineering', parent_external_id: null,
        active: true, direct_members: 1, child_count: 1 }], total: 1 })
    if (url.startsWith('/api/admin/org/departments/dept-1/members?')) return Response.json({ members: [
      { id: 'person-1', user_id: 'user-1', subject: 'person-a', display_name: 'Alice',
        username: 'alice', user_status: 'active' }], total: 1 })
    if (url === '/api/admin/identity-sources/source-1/reconcile') return Response.json({ departments: 1, people: 1 })
    throw new Error(`Unexpected fetch: ${url}`)
  }
  render(<MemoryRouter><AdminOrgPage roles={['super_admin']} /></MemoryRouter>)
  await screen.findByText(/企业微信 · tenant-a/)
  assert.match(document.body.textContent ?? '', /最近错误：身份源不可用/)
  assert.match(document.body.textContent ?? '', /同步游标：cursor-1 · 待处理回调：2/)
  fireEvent.click(screen.getByText('最近同步变更'))
  assert.match(document.body.textContent ?? '', /新增成员：1/)
  fireEvent.click(screen.getByRole('button', { name: '查看目录' }))
  await waitFor(() => assert.ok(requests.some(url => url.includes('source_id=source-1'))))
  assert.ok(requests.some(url => url.includes('roots_only=true')))
  fireEvent.click(screen.getByRole('button', { name: '展开 Engineering 子部门' }))
  await screen.findByRole('button', { name: /Platform/ })
  assert.ok(requests.some(url => url.includes('parent_id=dept-1')))
  fireEvent.click(screen.getByText('Engineering').closest('button')!)
  await screen.findByText('Alice')
  fireEvent.click(screen.getByRole('button', { name: '手动对账' }))
  fireEvent.click(within(screen.getByRole('dialog', { name: '手动对账' })).getByRole('button', { name: '开始对账' }))
  await waitFor(() => assert.ok(requests.includes('/api/admin/identity-sources/source-1/reconcile')))
})

test('department admin browses organization without loading source administration', async () => {
  const requests: string[] = []
  globalThis.fetch = async input => {
    const url = String(input)
    requests.push(url)
    if (url.startsWith('/api/admin/org/departments?')) return Response.json({ departments: [], total: 0 })
    throw new Error(`Unexpected fetch: ${url}`)
  }
  render(<MemoryRouter><AdminOrgPage roles={['identity_admin']} /></MemoryRouter>)
  await screen.findByText('当前条件下没有部门。')
  assert.ok(requests.every(url => !url.startsWith('/api/admin/identity-sources')))
})


for (const [role, scopeType, endpoint, result] of [
  ['org_admin', 'organization', 'identity-sources', { sources: [{ id: 'scope-1', provider: 'wecom', tenant_id: 'Org' }] }],
  ['department_admin', 'department', 'departments', { departments: [{ id: 'scope-1', display_name: 'Dept' }] }],
  ['device_admin', 'device_group', 'device-groups', { groups: [{ id: 'scope-1', name: 'PCs' }] }],
] as const) test(`grant ${role} selects a valid scope and sends its identifier`, async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  globalThis.fetch = async (input, init) => {
    const url = String(input); calls.push({ url, init })
    if (url.startsWith('/api/admin/users?')) return Response.json({ users: [{ id: 'user-1', username: 'alice', display_name: 'Alice' }] })
    if (url.startsWith(`/api/admin/${endpoint}?`)) return Response.json(result)
    if (url === '/api/auth/step-up') return Response.json({})
    if (url === '/api/admin/users/user-1/roles') return new Response(null, { status: 201 })
    throw new Error(url)
  }
  let saved = false
  render(<AdminGrantRoleDialog csrf="csrf" onSaved={() => { saved = true }} onClose={() => {}} />)
  fireEvent.change(screen.getByLabelText('搜索用户'), { target: { value: 'alice' } })
  fireEvent.click(screen.getByRole('button', { name: '查找用户' }))
  await screen.findByRole('option', { name: 'Alice（alice）' })
  fireEvent.change(screen.getByLabelText('选择用户'), { target: { value: 'user-1' } })
  fireEvent.change(screen.getByLabelText('管理员角色'), { target: { value: role } })
  if (scopeType !== 'department') fireEvent.change(screen.getByLabelText('管理范围'), { target: { value: scopeType } })
  await waitFor(() => assert.ok(screen.getByRole('option', { name: /Org|Dept|PCs/ })))
  fireEvent.change(screen.getByLabelText('选择管理范围'), { target: { value: 'scope-1' } })
  fireEvent.change(screen.getByLabelText('输入你的密码确认'), { target: { value: 'OwnerPassphrase-2026!' } })
  fireEvent.click(screen.getByRole('button', { name: '授予权限' }))
  await waitFor(() => assert.equal(saved, true))
  const body = JSON.parse(String(calls.find(call => call.url.endsWith('/user-1/roles'))?.init?.body))
  assert.equal(body.role, role); assert.equal(body.scope_type, scopeType); assert.equal(body.scope_id, 'scope-1')
})


test('organization delegation form exposes department roles and scopes only', async () => {
  globalThis.fetch = async input => {
    assert.ok(String(input).startsWith('/api/admin/departments?'))
    return Response.json({ departments: [] })
  }
  render(<AdminGrantRoleDialog delegated csrf="csrf" onSaved={() => {}} onClose={() => {}} />)
  const role = screen.getByLabelText('管理员角色') as HTMLSelectElement
  assert.deepEqual(Array.from(role.options).map(option => option.value).sort(), ['audit_admin', 'department_admin', 'identity_admin'])
  const scope = screen.getByLabelText('管理范围') as HTMLSelectElement
  assert.deepEqual(Array.from(scope.options).map(option => option.value), ['department'])
})


test('refresh reloads both synced users and the organization tree', async () => {
 let synced = false
 let userReads = 0; let groupReads = 0
 globalThis.fetch = async input => {
  const url = String(input)
  if (url === '/api/auth/session') return Response.json({csrf_token:'csrf'})
  if (url === '/api/admin/user-groups/tree') { groupReads++; return Response.json({groups: synced ? [{id:'g1',name:'同步部门',parent_id:null,member_count:1}] : []}) }
  if (url.startsWith('/api/admin/users?')) { userReads++; return Response.json({users: synced ? [{id:'u1',username:'ext_1',display_name:'同步成员',status:'active',registration_source:'directory_sync',created_at:'2026-10-08'}] : [],total:synced ? 1 : 0}) }
  throw Error(url)
 }
 render(<MemoryRouter><AdminUsersPage /></MemoryRouter>)
 await screen.findByText('当前条件下没有用户。')
 await screen.findByText('尚无用户组，可创建或同步组织。')
 synced = true
 fireEvent.click(screen.getByRole('button',{name:'刷新用户与用户组'}))
 await screen.findByText('同步成员')
 await screen.findByRole('button',{name:/同步部门/})
 assert.equal(userReads,2); assert.equal(groupReads,2)
})


test('user recycle bin filters deleted accounts and offers permanent deletion',async()=>{
 globalThis.fetch=async input=>{
  const url=String(input)
  if(url==='/api/auth/session')return Response.json({csrf_token:'csrf',admin_roles:['super_admin']})
  if(url.includes('user-groups/tree'))return Response.json({groups:[]})
  return Response.json({users:url.includes('status=deleted')?[{id:'u1',username:'alice',display_name:'已删用户',status:'deleted',registration_source:'local',created_at:'2026-10-08'}]:[],total:1})
 }
 render(<MemoryRouter><AdminUsersPage /></MemoryRouter>)
 fireEvent.click(screen.getByRole('button',{name:'回收站'}))
 await screen.findByText('已删用户')
 fireEvent.click(screen.getByRole('button',{name:'彻底删除'}))
 assert.ok(screen.getByRole('dialog',{name:'批量彻底删除用户'}))
 assert.match(document.body.textContent??'',/无法恢复/)
})


test('editing user validates passwords, preserves failed edits and protects closing', async () => {
 let saved = 0, closed = 0, fail = true
 const calls: unknown[] = []
 globalThis.fetch = async (input, init) => {
  if (String(input) === '/api/auth/step-up') return Response.json({})
  calls.push(JSON.parse(String(init?.body)))
  if (fail) { fail = false; return new Response(null, {status:503}) }
  return Response.json({display_name:'新名字'})
 }
 render(<AdminEditUserDialog csrf="csrf" user={{id:'test',username:'test',display_name:'Test',status:'active',registration_source:'admin_created',must_change_password:false,created_at:''}} onSaved={()=>saved++} onClose={()=>closed++}/>)
 fireEvent.change(screen.getByLabelText('显示名称'), {target:{value:'新名字'}})
 fireEvent.change(screen.getByLabelText('新密码（可选）'), {target:{value:'Password123'}})
 const submit = screen.getByRole('button',{name:'保存修改'}) as HTMLButtonElement
 assert.equal(submit.disabled,true)
 fireEvent.change(screen.getByLabelText('确认新密码'), {target:{value:'Password123'}})
 fireEvent.change(screen.getByLabelText('输入你的密码确认'), {target:{value:'AdminPassword123'}})
 fireEvent.click(submit)
 await screen.findByText('保存失败，请重试。')
 assert.equal((screen.getByLabelText('显示名称') as HTMLInputElement).value,'新名字')
 fireEvent.click(screen.getByRole('button',{name:'取消'}))
 assert.ok(screen.getByRole('dialog',{name:'放弃修改'}))
 assert.equal(closed,0)
 fireEvent.click(within(screen.getByRole('dialog',{name:'放弃修改'})).getByRole('button',{name:'取消'}))
 fireEvent.click(submit)
 await waitFor(()=>assert.equal(saved,1))
 assert.deepEqual(calls.at(-1),{display_name:'新名字',new_password:'Password123'})
})

test('enterprise user edit has no local password field', () => {
 render(<AdminEditUserDialog csrf="csrf" user={{id:'enterprise',username:'ext_123',login_username:null,display_name:'企业员工',status:'active',registration_source:'directory_sync',must_change_password:false,created_at:''}} onSaved={()=>{}} onClose={()=>{}}/>)
 assert.equal(screen.queryByLabelText('新密码（可选）'),null)
 assert.ok(screen.getByLabelText('显示名称'))
})


test('device display preserves readable names and uses IP only as fallback', () => {
 assert.equal(deviceDisplayName({name:'917c2dbe1b82',connection_ip:'192.168.52.156'}),'192.168.52.156')
 assert.equal(deviceDisplayName({name:'沙箱 1',connection_ip:'192.168.52.156'}),'沙箱 1')
 assert.equal(deviceDisplayName({name:'',connection_ip:'192.168.52.156'}),'192.168.52.156')
 assert.equal(deviceDisplayName({name:'沙箱 1',connection_ip:null}),'沙箱 1')
})
