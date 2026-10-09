import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { JSDOM } from 'jsdom'
import { MemoryRouter } from 'react-router-dom'
import { AdminPermissionsPage } from '../src/AdminPermissionsPage'
import { PermissionDialog } from '../src/PermissionDialogs'
import { PermissionSubjectTable } from '../src/PermissionSubjectTable'

const dom = new JSDOM('<html><body></body></html>', { url: 'https://gateway.test/admin/permissions' })
Object.assign(globalThis, { window: dom.window, document: dom.window.document,
  HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver, Event: dom.window.Event })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
const { cleanup, fireEvent, render, screen, waitFor, within } = await import('@testing-library/react')
const originalFetch = globalThis.fetch
afterEach(() => { cleanup(); globalThis.fetch = originalFetch })

test('multiple compatible permissions save together and retry only the failed rules', async () => {
  const posts: string[] = []
  let fail = true
  let saved = 0
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url === '/api/auth/session') return Response.json({ csrf_token: 'csrf' })
    if (url === '/api/auth/step-up') return Response.json({})
    if (url.startsWith('/api/admin/permissions/subjects')) return Response.json({ subjects: [{ id: 'u1', name: 'Test' }], total: 1 })
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)); posts.push(body.permission)
      assert.equal(body.scope_type, 'global')
      if (body.permission === 'project.publish' && fail) return Response.json({ error: { message: '暂时失败' } }, { status: 503 })
      return Response.json({ id: body.permission })
    }
    throw Error(url)
  }
  render(<PermissionDialog csrf="csrf" onClose={() => {}} onSaved={() => saved++} catalog={[
    { id: 'task.create', name: '创建任务', category: '业务操作', scopes: ['global', 'project'], effects: ['allow', 'deny'] },
    { id: 'project.publish', name: '发布项目', category: '业务操作', scopes: ['global'], effects: ['allow', 'deny'] },
    { id: 'admin.super_admin', name: '超级管理员', category: '平台管理', scopes: ['platform'], effects: ['allow'] },
  ]} />)
  await screen.findByRole('option', { name: 'Test' })
  fireEvent.change(screen.getByLabelText('授权对象'), { target: { value: 'u1' } })
  fireEvent.click(screen.getByRole('checkbox', { name: '创建任务' }))
  fireEvent.click(screen.getByRole('checkbox', { name: '发布项目' }))
  assert.equal((screen.getByRole('checkbox', { name: '超级管理员' }) as HTMLInputElement).disabled, true)
  fireEvent.change(screen.getByLabelText('输入管理员密码确认'), { target: { value: 'password' } })
  fireEvent.click(screen.getByRole('button', { name: '保存权限' }))
  await screen.findByText('暂时失败')
  assert.equal(saved, 0)
  assert.match(screen.getByText(/已保存 1 项权限/).textContent ?? '', /重试/)
  assert.equal((screen.getByLabelText('授权对象') as HTMLSelectElement).disabled, true)
  fail = false
  fireEvent.click(screen.getByRole('button', { name: '保存权限' }))
  await waitFor(() => assert.equal(saved, 1))
  assert.deepEqual(posts, ['task.create', 'project.publish', 'project.publish'])
})

test('subject summary groups rules by subject type and id and exposes each rule for adjustment', () => {
  const rules = [
    { id: 'one', subject_type: 'user' as const, subject_id: 'same', subject_name: 'Test', permission: 'task.create', scope_type: 'global', scope_id: null, scope_name: '全局', effect: 'allow' as const },
    { id: 'two', subject_type: 'user' as const, subject_id: 'same', subject_name: 'Test', permission: 'task.create', scope_type: 'project', scope_id: 'p1', scope_name: '项目一', effect: 'deny' as const },
    { id: 'three', subject_type: 'group' as const, subject_id: 'same', subject_name: 'Team', permission: 'task.create', scope_type: 'global', scope_id: null, scope_name: '全局', effect: 'allow' as const },
  ]
  let edited = ''
  render(<PermissionSubjectTable assignments={rules} name={() => '创建任务'} canEdit canRevoke
    onEdit={row => { edited = row.id }} onRevoke={() => {}} />)
  assert.equal(screen.getAllByRole('button', { name: '查看规则' }).length, 2)
  assert.equal(screen.getAllByText('Test').length, 1)
  fireEvent.click(screen.getAllByRole('button', { name: '查看规则' })[0])
  assert.ok(screen.getByText('禁止'))
  fireEvent.click(screen.getAllByRole('button', { name: '调整' })[1])
  assert.equal(edited, 'two')
})

test('one permission entry assigns a group rule, preserves errors and revokes it', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  let assignments: object[] = []
  let failSave = true
  globalThis.fetch = async (input, init) => {
    const url = String(input); requests.push({ url, init })
    if (url === '/api/auth/session') return Response.json({ csrf_token: 'csrf' })
    if (url === '/api/auth/step-up') return Response.json({})
    if (url === '/api/admin/permissions/catalog') return Response.json({ permissions: [
      { id: 'task.create', name: '创建任务', category: '业务操作', scopes: ['global', 'device', 'project'], effects: ['allow', 'deny'] },
      { id: 'admin.super_admin', name: '超级管理员', category: '平台管理', scopes: ['platform'], effects: ['allow'] },
    ] })
    if (url.startsWith('/api/admin/permissions/subjects?')) return Response.json({ subjects: [
      { id: 'group-1', name: '研发组' }], total: 1 })
    if (url.startsWith('/api/admin/permissions/resources?')) return Response.json({ resources: [
      { id: 'project-1', name: '项目一' }], total: 1 })
    if (url === '/api/admin/permissions' && init?.method === 'POST') {
      if (failSave) return Response.json({ error: { message: '保存失败，请重试' } }, { status: 503 })
      const body = JSON.parse(String(init.body))
      assignments = [{ id: 'capability:1', ...body, subject_name: '研发组', scope_name: '全局' }]
      return Response.json({ id: 'capability:1' })
    }
    if (url === '/api/admin/permissions/capability%3A1' && init?.method === 'DELETE') {
      assignments = []; return new Response(null, { status: 204 })
    }
    if (url.startsWith('/api/admin/permissions')) return Response.json({ assignments })
    throw new Error(`Unexpected fetch ${url}`)
  }
  render(<MemoryRouter><AdminPermissionsPage /></MemoryRouter>)
  await screen.findByRole('heading', { name: '权限管理' })
  await screen.findByText(/尚无权限规则/)
  fireEvent.click(screen.getByRole('button', { name: '分配权限' }))
  const editor = screen.getByRole('dialog', { name: '分配权限' })
  assert.equal(within(editor).getByRole('button', { name: '保存权限' }).hasAttribute('disabled'), true)
  fireEvent.change(within(editor).getByLabelText('对象类型'), { target: { value: 'group' } })
  await within(editor).findByRole('option', { name: '研发组' })
  fireEvent.change(within(editor).getByLabelText('授权对象'), { target: { value: 'group-1' } })
  fireEvent.click(within(editor).getByRole('checkbox', { name: '创建任务' }))
  fireEvent.change(within(editor).getByLabelText('规则'), { target: { value: 'deny' } })
  fireEvent.change(within(editor).getByLabelText('输入管理员密码确认'), { target: { value: 'password' } })
  fireEvent.click(within(editor).getByRole('button', { name: '保存权限' }))
  await within(editor).findByRole('alert')
  assert.equal((within(editor).getByLabelText('授权对象') as HTMLSelectElement).value, 'group-1')
  failSave = false
  fireEvent.click(within(editor).getByRole('button', { name: '保存权限' }))
  await screen.findByText('研发组')
  fireEvent.click(await screen.findByRole('button', { name: '查看规则' }))
  await screen.findByText('禁止')
  const posted = requests.filter(row => row.url === '/api/admin/permissions' && row.init?.method === 'POST').at(-1)
  assert.deepEqual(JSON.parse(String(posted?.init?.body)), { subject_type: 'group', subject_id: 'group-1',
    permission: 'task.create', scope_type: 'global', scope_id: null, effect: 'deny', include_subdepartments: true })
  fireEvent.click(screen.getByRole('button', { name: '撤销' }))
  const revoke = screen.getByRole('dialog', { name: '撤销权限' })
  fireEvent.change(within(revoke).getByLabelText('输入管理员密码确认'), { target: { value: 'password' } })
  fireEvent.click(within(revoke).getByRole('button', { name: '撤销权限' }))
  await waitFor(() => assert.ok(requests.some(row => row.url.endsWith('capability%3A1') && row.init?.method === 'DELETE')))
  await screen.findByText(/尚无权限规则/)
})
