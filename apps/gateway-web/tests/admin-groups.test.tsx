import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { JSDOM } from 'jsdom'
import { MemoryRouter } from 'react-router-dom'
import { AdminGroupsPage } from '../src/AdminGroupsPage'
import { AdminGroupCreateDialog } from '../src/AdminGroupCreateDialog'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://gateway.test/admin/groups',
})
Object.assign(globalThis, { window: dom.window, document: dom.window.document,
  HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver,
  Event: dom.window.Event })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const originalFetch = globalThis.fetch
afterEach(() => { cleanup(); globalThis.fetch = originalFetch })

test('super administrator creates a group, links a policy project and manages members', async () => {
  const writes: Array<{ url: string; method: string; body?: Record<string, unknown> }> = []
  let created = false
  let linked = false
  let member = false
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (method !== 'GET') writes.push({ url, method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (url === '/api/auth/session') return Response.json({ csrf_token: 'csrf-owner' })
    if (url === '/api/admin/user-groups/tree' && method === 'GET') return Response.json({ groups: created
      ? [{ id: 'group-1', name: '研发组', slug: 'dev', source_type: 'manual' }] : [] })
    if (url === '/api/auth/step-up') return Response.json({ expires_in_seconds: 300 })
    if (url === '/api/groups' && method === 'POST') {
      created = true; return Response.json({ id: 'group-1' }, { status: 201 })
    }
    if (url === '/api/groups/group-1/projects' && method === 'GET') return Response.json({
      projects: linked ? [{ id: 'project-1', name: '策略项目', purpose: 'skill_management' }] : [],
    })
    if (url === '/api/groups/group-1/members' && method === 'GET') return Response.json({
      members: member ? [{ user_id: 'user-1', username: 'leader', display_name: 'Leader',
        role: 'leader', source: 'manual' }] : [],
    })
    if (url.startsWith('/api/groups/linkable-projects?')) return Response.json({ projects: [{
      id: 'project-1', name: '策略项目', device_id: 'device-1', device_name: 'PC 一',
      access_mode: 'policy_only',
    }], total: 1 })
    if (url.startsWith('/api/admin/users?')) return Response.json({ users: [{
      id: 'user-1', username: 'leader', display_name: 'Leader', status: 'active',
    }], total: 1 })
    if (url === '/api/groups/group-1/projects' && method === 'POST') {
      linked = true; return Response.json({ group_id: 'group-1', project_id: 'project-1' })
    }
    if (url === '/api/groups/group-1/members/bulk' && method === 'POST') {
      member = init?.body ? JSON.parse(String(init.body)).action !== 'remove' : true; return Response.json({ updated: 1 })
    }
    if (url === '/api/groups/group-1/projects/project-1' && method === 'DELETE') {
      linked = false; return new Response(null, { status: 204 })
    }
    if (url === '/api/groups/group-1/members/user-1' && method === 'DELETE') {
      member = false; return new Response(null, { status: 204 })
    }
    throw new Error(`Unexpected fetch: ${url} ${method}`)
  }
  render(<MemoryRouter><AdminGroupsPage /></MemoryRouter>)
  const create = await screen.findByRole('button', { name: '创建用户组' })
  await waitFor(() => assert.equal((create as HTMLButtonElement).disabled, false))
  fireEvent.click(create)
  const { getByLabelText, getByRole } = await import('@testing-library/dom')
  let dialog = await screen.findByRole('dialog', { name: '创建用户组' })
  fireEvent.change(getByLabelText(dialog, '名称'), { target: { value: '研发组' } })
  fireEvent.change(getByLabelText(dialog, '标识'), { target: { value: 'dev' } })
  fireEvent.change(getByLabelText(dialog, '管理员密码'), { target: { value: 'secret' } })
  fireEvent.click(getByRole(dialog, 'button', { name: '确认创建' }))
  fireEvent.click(await screen.findByRole('button', { name: '研发组' }))
  fireEvent.change(screen.getByLabelText('搜索项目'), { target: { value: '策略' } })
  fireEvent.click(screen.getByRole('button', { name: '查找项目' }))
  await screen.findByRole('button', { name: '关联策略项目' })
  fireEvent.click(screen.getByRole('button', { name: '关联策略项目' }))
  await screen.findByRole('button', { name: '取消关联策略项目' })
  assert.deepEqual(writes.find(item => item.url === '/api/groups/group-1/projects'), {
    url: '/api/groups/group-1/projects', method: 'POST', body: { project_id: 'project-1' },
  })
  fireEvent.change(screen.getByLabelText('搜索用户'), { target: { value: 'leader' } })
  fireEvent.click(screen.getByRole('button', { name: '查找用户' }))
  fireEvent.change(screen.getByLabelText('成员角色'), { target: { value: 'leader' } })
  await screen.findByRole('button', { name: '添加 Leader 为组长' })
  fireEvent.click(screen.getByRole('button', { name: '添加 Leader 为组长' }))
  fireEvent.click(screen.getByRole('button', { name: '确认添加' }))
  await screen.findByRole('button', { name: '移除 Leader' })
  assert.deepEqual(writes.find(item => item.url === '/api/groups/group-1/members/bulk'), {
    url: '/api/groups/group-1/members/bulk', method: 'POST',
    body: { action: 'add', user_ids: ['user-1'], role: 'leader' },
  })
  fireEvent.click(screen.getByRole('button', { name: '取消关联策略项目' }))
  dialog = await screen.findByRole('dialog', { name: '取消项目关联' })
  fireEvent.click(getByRole(dialog, 'button', { name: '确认取消关联' }))
  await waitFor(() => assert.equal(linked, false))
  fireEvent.click(screen.getByRole('button', { name: '移除 Leader' }))
  dialog = await screen.findByRole('dialog', { name: '移除成员' })
  fireEvent.click(getByRole(dialog, 'button', { name: '确认移除' }))
  await waitFor(() => assert.equal(member, false))
})

test('administrator can map an external department to a user group', async () => {
  let body: Record<string, unknown> | null = null
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url.startsWith('/api/admin/departments?')) return Response.json({ departments: [
      { id: 'department-1', display_name: '工程部', provider: 'wecom', external_id: 'eng' },
    ] })
    if (url === '/api/auth/step-up') return Response.json({ expires_in_seconds: 300 })
    if (url === '/api/groups' && init?.method === 'POST') {
      body = JSON.parse(String(init.body)); return Response.json({ id: 'group-1' }, { status: 201 })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  }
  render(<AdminGroupCreateDialog csrf="csrf" onDone={() => undefined} onClose={() => undefined} />)
  fireEvent.change(screen.getByLabelText('名称'), { target: { value: '工程部' } })
  fireEvent.change(screen.getByLabelText('标识'), { target: { value: 'engineering' } })
  fireEvent.change(screen.getByLabelText('来源'), { target: { value: 'external_department' } })
  fireEvent.change(screen.getByLabelText('搜索部门'), { target: { value: '工程' } })
  fireEvent.click(screen.getByRole('button', { name: '查找部门' }))
  await screen.findByRole('option', { name: '工程部 · wecom' })
  fireEvent.change(screen.getByLabelText('映射部门'), { target: { value: 'department-1' } })
  fireEvent.change(screen.getByLabelText('管理员密码'), { target: { value: 'secret' } })
  fireEvent.click(screen.getByRole('button', { name: '确认创建' }))
  await waitFor(() => assert.deepEqual(body, {
    name: '工程部', slug: 'engineering', description: '',
    source_type: 'external_department', external_department_id: 'department-1',
  }))
})
