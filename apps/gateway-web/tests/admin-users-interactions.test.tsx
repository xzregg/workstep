import { AdminUserTable } from '../src/AdminUserTable'
import { AdminEditUserDialog } from '../src/AdminEditUserDialog'
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { JSDOM } from 'jsdom'
import { MemoryRouter, useNavigate } from 'react-router-dom'
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
  render(<MemoryRouter><DeviceAdminPage /></MemoryRouter>)
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
  render(<MemoryRouter><DeviceAdminPage /></MemoryRouter>)
  fireEvent.click(await screen.findByRole('button',{name:'Alice PC · 更多操作'}))
  fireEvent.click(screen.getByRole('button', { name: '重新启用' }))
  const dialog = screen.getByRole('dialog', { name: '重新启用设备' })
  fireEvent.change(within(dialog).getByLabelText('输入管理员密码确认'), { target: { value: 'test-admin-password' } })
  fireEvent.click(within(dialog).getByRole('button', { name: '确认重新启用' }))
  await waitFor(() => assert.equal(screen.queryByRole('dialog') === null,true))
  await waitFor(() => assert.match(screen.getByText('Alice PC').closest('tr')?.textContent ?? '',/已启用/))
  fireEvent.click(screen.getByRole('button',{name:'Alice PC · 更多操作'}))
  await waitFor(() => assert.equal((screen.getByRole('button',{name:'停用'}) as HTMLButtonElement).disabled,false))
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
  render(<MemoryRouter><DeviceAdminPage /></MemoryRouter>)
  fireEvent.click(await screen.findByRole('button',{name:'Container PC · 更多操作'}))
  assert.equal((screen.getByRole('button',{name:'重新启用'}) as HTMLButtonElement).disabled,true)
  fireEvent.click(screen.getByRole('button', { name: '修改名称' }))
  assert.ok(screen.getByRole('dialog', { name: '修改设备名称' }))
  assert.equal((screen.getByLabelText('设备名称') as HTMLInputElement).value, 'Container PC')
  fireEvent.click(screen.getByRole('button',{name:'取消'}))
  fireEvent.click(screen.getByRole('button',{name:'Container PC · 设备详情'}))
  assert.ok(screen.getByText(/该设备身份已撤销，不能直接重新启用。/))
  assert.ok(screen.getByText('设备离线，暂时无法检测本地服务。'))
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
  render(<MemoryRouter><DeviceAdminPage /></MemoryRouter>)
  fireEvent.click(await screen.findByRole('button',{name:'Container PC · 更多操作'}))
  fireEvent.click(screen.getByRole('button', { name: '彻底删除' }))
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
      { id: 'legacy', name: 'Legacy PC', version: null, status: 'active', online: false,
        daemon_health: null, latest_version: null, update_available: null },
      { id: 'unlisted', name: 'Unlisted PC', version: '1.0.0', status: 'active', online: false,
        daemon_health: null, latest_version: null, update_available: null },
    ], total: 3 })
    throw new Error(`Unexpected fetch: ${url}`)
  }
  render(<MemoryRouter><DeviceAdminPage /></MemoryRouter>)
  fireEvent.change(await screen.findByLabelText('设备状态'), { target: { value: 'active' } })
  const old = (await screen.findByText('Old PC')).closest('tr')!
  const legacy = screen.getByText('Legacy PC').closest('tr')!
  assert.match(old.textContent ?? '', /2001:db8::7/)
  assert.match(old.textContent ?? '', /有新版本 1\.10\.0/)
  assert.match(legacy.textContent ?? '', /未上报/)
  assert.match(legacy.textContent ?? '', /暂无发布版本/)
  const unlisted = screen.getByText('Unlisted PC').closest('tr')!
  assert.match(unlisted.textContent ?? '', /1\.0\.0/)
  assert.match(unlisted.textContent ?? '', /暂无发布版本/)
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
  await waitFor(() => assert.ok(requests.filter(url => url.startsWith('/api/admin/roles?')).length >= 3, JSON.stringify(requests)))
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
  assert.equal(screen.getByRole('link', { name: '待审核用户' }).getAttribute('href'), '/admin/users?status=pending')
  assert.equal(screen.getByRole('link', { name: '异常设备' }).getAttribute('href'), '/admin/devices?health=unhealthy')
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
 fireEvent.change(screen.getByLabelText('新密码（可选）'), {target:{value:'UniquePassphrase-2026!'}})
 const submit = screen.getByRole('button',{name:'保存修改'}) as HTMLButtonElement
 assert.equal(submit.disabled,true)
 fireEvent.change(screen.getByLabelText('确认新密码'), {target:{value:'UniquePassphrase-2026!'}})
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
 assert.deepEqual(calls.at(-1),{display_name:'新名字',new_password:'UniquePassphrase-2026!'})
})

test('enterprise user edit supports a platform username and password', async () => {
 render(<AdminEditUserDialog csrf="csrf" user={{id:'enterprise',username:'ext_123',login_username:null,display_name:'企业员工',status:'active',registration_source:'directory_sync',must_change_password:false,created_at:''}} onSaved={()=>{}} onClose={()=>{}}/>)
 assert.ok(screen.getByLabelText('新密码（可选）'))
 const submit=screen.getByRole('button',{name:'保存修改'}) as HTMLButtonElement
 fireEvent.change(screen.getByLabelText('登录用户名'),{target:{value:'enterprise_user'}})
 assert.equal(submit.disabled,true)
 fireEvent.change(screen.getByLabelText('新密码（可选）'),{target:{value:'UniquePassphrase-2026!'}})
 fireEvent.change(screen.getByLabelText('确认新密码'),{target:{value:'UniquePassphrase-2026!'}})
 fireEvent.change(screen.getByLabelText('输入你的密码确认'),{target:{value:'AdminPassword123'}})
 await waitFor(()=>assert.equal(submit.disabled,false))
 let body:unknown
 globalThis.fetch=async(input,init)=>{if(init?.method==='PATCH')body=JSON.parse(String(init.body));return Response.json({})}
 fireEvent.click(submit)
 await waitFor(()=>assert.deepEqual(body,{display_name:'企业员工',username:'enterprise_user',new_password:'UniquePassphrase-2026!'}))
})


test('device display preserves readable names and uses IP only as fallback', () => {
 assert.equal(deviceDisplayName({name:'917c2dbe1b82',connection_ip:'192.168.52.156'}),'192.168.52.156')
 assert.equal(deviceDisplayName({name:'沙箱 1',connection_ip:'192.168.52.156'}),'沙箱 1')
 assert.equal(deviceDisplayName({name:'',connection_ip:'192.168.52.156'}),'192.168.52.156')
 assert.equal(deviceDisplayName({name:'沙箱 1',connection_ip:null}),'沙箱 1')
})


test('creating a user keeps the applied search and current list page', async () => {
  const urls: string[] = []
  globalThis.fetch = async (input, init) => {
    const url = String(input); urls.push(url)
    if (url === '/api/auth/session') return Response.json({csrf_token:'csrf'})
    if (url === '/api/admin/user-groups/tree') return Response.json({groups:[]})
    if (url === '/api/admin/users' && init?.method === 'POST') return Response.json({id:'new'})
    if (url.startsWith('/api/admin/users?')) return Response.json({total:101,users:[{id:'alice',
      username:'alice',display_name:'Alice',status:'active',registration_source:'local',created_at:'2026-01-01'}]})
    throw new Error(`Unexpected fetch: ${url}`)
  }
  render(<MemoryRouter><AdminUsersPage/></MemoryRouter>)
  await screen.findByRole('cell',{name:'Alice'})
  fireEvent.change(screen.getByLabelText('搜索用户'),{target:{value:'alice'}})
  fireEvent.click(screen.getByRole('button',{name:'搜索'}))
  await waitFor(() => assert.ok(urls.some(url => url.includes('q=alice'))))
  await waitFor(() => assert.equal((screen.getByRole('button',{name:'下一页'}) as HTMLButtonElement).disabled,false))
  fireEvent.click(screen.getByRole('button',{name:'下一页'}))
  await waitFor(() => assert.ok(urls.some(url => url.includes('page=2'))))
  fireEvent.click(screen.getByRole('button',{name:'创建用户'}))
  const dialog = screen.getByRole('dialog',{name:'创建用户'})
  fireEvent.change(within(dialog).getByLabelText('用户名'),{target:{value:'new-user'}})
  fireEvent.change(within(dialog).getByLabelText('显示名称'),{target:{value:'New User'}})
  fireEvent.change(within(dialog).getByLabelText('初始密码（至少 8 位）'),{target:{value:'strong-password-123'}})
  const before = urls.filter(url => url.startsWith('/api/admin/users?')).length
  fireEvent.click(within(dialog).getByRole('button',{name:'创建用户'}))
  await waitFor(() => assert.equal(urls.filter(url => url.startsWith('/api/admin/users?')).length,before+1))
  const query = new URLSearchParams(urls.filter(url => url.startsWith('/api/admin/users?')).at(-1)!.split('?')[1])
  assert.equal(query.get('page'),'2'); assert.equal(query.get('q'),'alice')
})


test('user editor selects multiple groups, preserves directory groups and retries failed saves', async () => {
 const requests: Record<string, unknown>[] = []
 let saved = 0
 globalThis.fetch = async (_input, init) => {
  if (init?.method === 'PATCH') {
   requests.push(JSON.parse(String(init.body)))
   return new Response(null, {status: requests.length === 1 ? 500 : 200})
  }
  return Response.json({groups: [
   {id:'dev',name:'研发',selected:true,editable:true},
   {id:'sales',name:'销售',selected:false,editable:true},
   {id:'sync',name:'企业部门',selected:true,editable:false,synced:true},
  ]})
 }
 render(<AdminEditUserDialog csrf="csrf" user={{id:'alice',username:'alice',display_name:'Alice',status:'disabled',registration_source:'admin_created',must_change_password:false,created_at:''}} onClose={() => {}} onSaved={() => {saved++}} />)
 const dev = await screen.findByRole('checkbox',{name:'选择用户组研发'}) as HTMLInputElement
 assert.equal(dev.checked,true)
 const synced = screen.getByRole('checkbox',{name:/企业部门/}) as HTMLInputElement
 assert.equal(synced.checked,true)
 assert.equal(synced.disabled,true)
 fireEvent.click(screen.getByRole('checkbox',{name:'选择用户组销售'}))
 fireEvent.click(screen.getByRole('button',{name:'保存修改'}))
 await screen.findByText('保存失败，请重试。')
 assert.deepEqual(requests[0].group_ids,['dev','sales','sync'])
 assert.equal((screen.getByRole('checkbox',{name:'选择用户组销售'}) as HTMLInputElement).checked,true)
 fireEvent.click(screen.getByRole('button',{name:'保存修改'}))
 await waitFor(() => assert.equal(saved,1))
})


test('user group picker searches the shared hierarchy without changing parent or readonly memberships', async () => {
 let loads = 0
 let payload: Record<string, unknown> = {}
 globalThis.fetch = async (_input, init) => {
  if (init?.method === 'PATCH') { payload = JSON.parse(String(init.body)); return Response.json({}) }
  loads++
  return Response.json({groups:[
   {id:'root',name:'总部',parent_id:null,selected:false,editable:true},
   {id:'dev',name:'研发组',parent_id:'root',selected:false,editable:true},
   {id:'sales',name:'销售组',parent_id:'root',selected:false,editable:true},
   {id:'sync',name:'企业部门',parent_id:'root',selected:true,editable:false,synced:true},
  ]})
 }
 render(<AdminEditUserDialog csrf="csrf" user={{id:'alice',username:'alice',display_name:'Alice',status:'active',registration_source:'admin_created',must_change_password:false,created_at:''}} onSaved={() => {}} onClose={() => {}} />)
 const search = await screen.findByRole('textbox',{name:'搜索用户组'})
 const tree = screen.getByRole('tree',{name:'用户组'})
 assert.ok(within(tree).getAllByRole('group').length)
 const branch = tree.querySelector('details')!
 branch.open = false
 fireEvent.change(search,{target:{value:'研发'}})
 assert.equal(tree.querySelector('details')!.open,true)
 assert.equal(screen.queryByRole('checkbox',{name:'选择用户组销售组'}),null)
 assert.ok(screen.getByRole('checkbox',{name:'选择用户组总部'}))
 fireEvent.click(screen.getByRole('button',{name:'勾选搜索结果'}))
 assert.equal((screen.getByRole('checkbox',{name:'选择用户组总部'}) as HTMLInputElement).checked,false)
 fireEvent.change(search,{target:{value:''}})
 assert.equal((screen.getByRole('checkbox',{name:'选择用户组研发组'}) as HTMLInputElement).checked,true)
 assert.equal((screen.getByRole('checkbox',{name:'选择用户组企业部门'}) as HTMLInputElement).disabled,true)
 fireEvent.click(screen.getByRole('checkbox',{name:'全选用户组'}))
 fireEvent.click(screen.getByRole('checkbox',{name:'全选用户组'}))
 assert.equal((screen.getByRole('checkbox',{name:'选择用户组企业部门'}) as HTMLInputElement).checked,true)
 fireEvent.click(screen.getByRole('checkbox',{name:'选择用户组研发组'}))
 fireEvent.click(screen.getByRole('button',{name:'保存修改'}))
 await waitFor(()=>assert.deepEqual(payload.group_ids,['dev','sync']))
 assert.equal(loads,1)
})


test('overview device shortcut applies health filter and explains unhealthy status', async () => {
  const urls: string[] = []
  globalThis.fetch = async input => {
    const url = String(input); urls.push(url)
    if (url === '/api/auth/session') return Response.json({ csrf_token: 'csrf' })
    return Response.json({ total: 1, devices: [{ id: 'pc', name: '异常电脑', status: 'active', online: true, daemon_health: false }] })
  }
  render(<MemoryRouter initialEntries={['/admin/devices?health=unhealthy']}><DeviceAdminPage /></MemoryRouter>)
  fireEvent.click(await screen.findByRole('button', { name: '异常电脑 · 设备详情' }))
  assert.ok(screen.getByText('设备控制连接在线，但本地服务健康检查未通过。'))
  assert.ok(screen.getByText(/未提供具体错误原因/))
  assert.ok(urls.some(url => url.includes('health=unhealthy')))
})

test('device session network failure can retry without asking for credentials', async () => {
  let sessions = 0
  globalThis.fetch = async input => {
    if (String(input) === '/api/auth/session') {
      if (++sessions === 1) throw new Error('offline')
      return Response.json({ csrf_token: 'csrf' })
    }
    return Response.json({ devices: [], total: 0 })
  }
  render(<MemoryRouter><DeviceAdminPage /></MemoryRouter>)
  await screen.findByText('登录状态加载失败，请重试。')
  assert.equal(screen.queryByLabelText('密码'), null)
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  await screen.findByText('当前筛选下没有设备。')
  assert.equal(sessions, 2)
})

test('device permissions failure clears stale device records', async () => {
  let lists = 0
  globalThis.fetch = async input => {
    if (String(input) === '/api/auth/session') return Response.json({ csrf_token: 'csrf' })
    if (++lists > 1) return new Response(null, { status: 403 })
    return Response.json({ devices: [{ id: 'pc', name: '旧设备', online: true, status: 'active' }], total: 1 })
  }
  render(<MemoryRouter><DeviceAdminPage /></MemoryRouter>)
  await screen.findByRole('button', { name: '旧设备 · 设备详情' })
  fireEvent.click(screen.getByRole('button', { name: '刷新设备' }))
  await screen.findByText('当前账号没有设备管理权限。')
  assert.equal(screen.queryByRole('button', { name: '旧设备 · 设备详情' }), null)
})

for (const [name, Page, endpoint] of [
  ['users', AdminUsersPage, '/api/admin/users?'],
  ['roles', AdminRolesPage, '/api/admin/roles?'],
] as const) {
  test(`${name} recovers a failed session without reloading the page`, async () => {
    let sessions = 0
    globalThis.fetch = async input => {
      const url = String(input)
      if (url === '/api/auth/session') {
        if (++sessions === 1) throw new Error('offline')
        return Response.json({ csrf_token: 'csrf' })
      }
      if (url.startsWith(endpoint)) return Response.json({ users: [], roles: [], total: 0 })
      return Response.json({ groups: [], nodes: [] })
    }
    render(<MemoryRouter><Page /></MemoryRouter>)
    await screen.findByRole('alert')
    assert.equal(screen.queryByText('正在检查登录状态…'), null)
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await screen.findByText(name === 'users' ? '当前条件下没有用户。' : '当前条件下没有管理员。')
    assert.equal(sessions, 2)
  })
}

for (const [name, Page, path] of [['users', AdminUsersPage, 'users'], ['devices', DeviceAdminPage, 'devices']] as const) {
 test(`${name} follows changed status links without remounting`, async () => {
  const requests: string[] = []
  globalThis.fetch = async input => {
   const url = String(input); requests.push(url)
   if (url === '/api/auth/session') return Response.json({ csrf_token: 'csrf' })
   return Response.json({ users: [], devices: [], groups: [], nodes: [], total: 0 })
  }
  function Harness() {
   const navigate = useNavigate()
   return <><button onClick={() => navigate(`/admin/${path}?status=disabled`)}>切换状态链接</button><Page /></>
  }
  render(<MemoryRouter initialEntries={[`/admin/${path}?status=pending`]}><Harness /></MemoryRouter>)
  await waitFor(() => assert.ok(requests.some(url => url.startsWith(`/api/admin/${path}?`) && url.includes('status=pending')), JSON.stringify(requests)))
  fireEvent.click(screen.getByRole('button', { name: '切换状态链接' }))
  await waitFor(() => assert.ok(requests.some(url => url.startsWith(`/api/admin/${path}?`) && url.includes('status=disabled')), JSON.stringify(requests)))
 })
}


test('starting another user edit clears the previous save notice', async () => {
  globalThis.fetch = async (_input, init) => init?.method === 'PATCH'
    ? Response.json({}) : Response.json({ groups: [] })
  render(<AdminUserTable users={[{ id: 'alice', username: 'alice', display_name: 'Alice',
    status: 'active', registration_source: 'local', must_change_password: false,
    created_at: '2026-01-01' }]} csrf="csrf" loading={false} resetKey="all" onRefresh={() => {}} />)
  fireEvent.click(screen.getByRole('button', { name: '编辑' }))
  await screen.findByLabelText('搜索用户组')
  fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: 'Alice edited' } })
  fireEvent.click(screen.getByRole('button', { name: '保存修改' }))
  await screen.findByText('用户资料已保存。')
  fireEvent.click(screen.getByRole('button', { name: '编辑' }))
  assert.equal(!!screen.queryByText('用户资料已保存。'), false)
})


test('login time header toggles server sorting, resets pagination and syncs filters', async () => {
  const requests: URLSearchParams[] = []
  globalThis.fetch = async input => {
    const url = String(input)
    if (url === '/api/auth/session') return Response.json({ csrf_token: 'csrf' })
    if (url.startsWith('/api/admin/users?')) {
      requests.push(new URLSearchParams(url.split('?')[1]))
      return Response.json({users: [], total: 201})
    }
    return Response.json({groups: []})
  }
  render(<MemoryRouter><AdminUsersPage /></MemoryRouter>)
  await screen.findByRole('button', { name: '按上次登录时间降序排序' })
  fireEvent.change(screen.getByLabelText('搜索用户'), {target: {value: '张'}})
  fireEvent.click(screen.getByRole('button', {name: '搜索'}))
  await waitFor(() => assert.equal(requests.at(-1)?.get('q'), '张'))
  await waitFor(() => assert.equal((screen.getByRole('button', {name: '下一页'}) as HTMLButtonElement).disabled, false))
  fireEvent.click(screen.getByRole('button', {name: '下一页'}))
  await waitFor(() => assert.equal(requests.at(-1)?.get('page'), '2'))
  fireEvent.click(screen.getByRole('button', {name: '按上次登录时间降序排序'}))
  await waitFor(() => assert.equal(requests.at(-1)?.get('sort'), 'last_login_at'))
  assert.equal(requests.at(-1)?.get('page'), '1')
  assert.equal(requests.at(-1)?.get('direction'), 'desc')
  assert.equal(requests.at(-1)?.get('q'), '张')
  assert.equal((screen.getByLabelText('排序') as HTMLSelectElement).value, 'last_login_at')
  assert.equal(screen.getByRole('columnheader', {name: /上次登录时间/}).getAttribute('aria-sort'), 'descending')
  fireEvent.click(screen.getByRole('button', {name: '按上次登录时间升序排序'}))
  await waitFor(() => assert.equal(requests.at(-1)?.get('direction'), 'asc'))
  assert.equal(screen.getByRole('columnheader', {name: /上次登录时间/}).getAttribute('aria-sort'), 'ascending')
  fireEvent.change(screen.getByLabelText('排序'), {target: {value: 'created_at'}})
  await waitFor(() => assert.equal(requests.at(-1)?.get('sort'), 'created_at'))
  assert.equal(screen.getByRole('columnheader', {name: /上次登录时间/}).getAttribute('aria-sort'), 'none')
})


test('overview refreshes its snapshot and preserves permission-scoped sections', async () => {
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return Response.json({ roles: ['identity_admin'], users: { total: calls, pending: 0 },
      devices: null, projects: null, tasks: { running: null, unknown_projects: null },
      recent_actions: null })
  }
  render(<MemoryRouter><AdminOverviewPage /></MemoryRouter>)
  await screen.findByRole('heading', { name: '待处理事项' })
  assert.equal(screen.queryByRole('heading', { name: '设备运行状况' }), null)
  assert.equal(screen.queryByRole('link', { name: '查看全部审计记录' }), null)
  fireEvent.click(screen.getByRole('button', { name: '刷新概览' }))
  await waitFor(() => assert.equal(calls, 2))
  await waitFor(() => assert.equal(screen.getByRole('button', { name: '刷新概览' }).hasAttribute('disabled'), false))
  assert.match(document.body.textContent ?? '', /当前无待审核用户/)
})

test('overview shows readable audit outcomes without hiding original event names', async () => {
  globalThis.fetch = async () => Response.json({ roles: ['super_admin'], users: null,
    devices: null, projects: null, tasks: { running: 0, unknown_projects: 0 },
    recent_actions: [{ action: 'auth.desktop.login', result: 'success', created_at: '2026-11-02T03:41:50Z' },
      { action: 'custom.action', result: 'denied', created_at: '2026-11-02T03:40:00Z' }] })
  render(<MemoryRouter><AdminOverviewPage /></MemoryRouter>)
  await screen.findByText('桌面端登录')
  assert.ok(screen.getByText('auth.desktop.login'))
  assert.ok(screen.getByText('成功'))
  assert.ok(screen.getByText('custom.action'))
  assert.ok(screen.getByText('拒绝'))
})
