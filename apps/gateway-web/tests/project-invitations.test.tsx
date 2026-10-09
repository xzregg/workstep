import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { JSDOM } from 'jsdom'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { ProjectInvitationsPage } from '../src/ProjectInvitationsPage'
import { ProjectInvitationAcceptPage } from '../src/ProjectInvitationAcceptPage'
import { ProjectInvitationRecords } from '../src/ProjectInvitationRecords'

const token = 'a'.repeat(43)
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://gateway.test/' })
Object.assign(globalThis, { window: dom.window, document: dom.window.document,
  HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver, Event: dom.window.Event })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const originalFetch = globalThis.fetch
afterEach(() => { cleanup(); globalThis.fetch = originalFetch })

test('owner creates a gateway project invitation and sees its link', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  globalThis.fetch = async (input, init) => {
    const url = String(input); calls.push({ url, init })
    if (url === '/api/auth/session') return Response.json({ csrf_token: 'csrf' })
    if (url === '/api/project-invitations/projects') return Response.json({ projects: [
      { id: 'p1', name: 'Demo', device_name: 'PC', invitations_enabled: true },
    ] })
    if (url === '/api/projects/p1/invitations' && init?.method === 'POST') return Response.json({
      id: 'i1', url: `https://gateway.test/project-invitations/${token}`,
    }, { status: 201 })
    if (url === '/api/projects/p1/invitations') return Response.json({ invitations_enabled: true, invitations: [] })
    throw Error(url)
  }
  render(<MemoryRouter initialEntries={['/project-invitations?project_id=p1']}><ProjectInvitationsPage /></MemoryRouter>)
  assert.equal(screen.getAllByRole('tab').length, 3)
  assert.equal(screen.queryByText('添加别人分享的项目'), null)
  await screen.findByRole('button', { name: '生成项目邀请' })
  fireEvent.change(screen.getByLabelText('访问级别'), { target: { value: 'edit' } })
  fireEvent.click(screen.getByRole('button', { name: '生成项目邀请' }))
  assert.equal((await screen.findByLabelText('项目邀请链接') as HTMLInputElement).value,
    `https://gateway.test/project-invitations/${token}`)
  const create = calls.find(c => c.init?.method === 'POST')!
  assert.deepEqual(JSON.parse(String(create.init?.body)), { access_level: 'edit', expires_at: null })
  assert.equal((create.init?.headers as Record<string, string>)['X-CSRF-Token'], 'csrf')
  fireEvent.click(screen.getByRole('tab', { name: '我的邀请' }))
  await screen.findByText('我创建的项目邀请')
  assert.equal(screen.queryByRole('button', { name: '生成项目邀请' }), null)
  fireEvent.click(screen.getByRole('tab', { name: '添加项目' }))
  assert.ok(screen.getByText('添加别人分享的项目'))
  assert.equal(screen.queryByText('我创建的项目邀请'), null)
  fireEvent.keyDown(screen.getByRole('tab', { name: '添加项目' }), { key: 'ArrowRight' })
  assert.equal(screen.getByRole('tab', { name: '分享项目' }).getAttribute('aria-selected'), 'true')
  assert.equal((screen.getByLabelText('项目邀请链接') as HTMLInputElement).value,
    `https://gateway.test/project-invitations/${token}`)
  assert.equal(calls.filter(c => c.url === '/api/project-invitations/projects').length, 1)
})

test('project invitation page starts with adding a project when no project was selected', async () => {
  globalThis.fetch = async input => String(input) === '/api/auth/session'
    ? Response.json({ csrf_token: 'csrf' }) : Response.json({ projects: [] })
  render(<MemoryRouter initialEntries={['/project-invitations']}><ProjectInvitationsPage /></MemoryRouter>)
  assert.equal(screen.getByRole('tab', { name: '添加项目' }).getAttribute('aria-selected'), 'true')
  assert.ok(screen.getByText('添加别人分享的项目'))
  assert.equal(screen.queryByRole('button', { name: '生成项目邀请' }), null)
})

test('guest with no devices previews then explicitly adds a project, failures can retry', async () => {
  let accepts = 0
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url === '/api/auth/session') return Response.json({ csrf_token: 'csrf' })
    if (url === `/api/project-invitations/${token}`) return Response.json({
      project_id: 'p1', project_name: 'Demo', device_name: 'PC', access_level: 'edit', created_by: 'Owner',
    })
    if (url.endsWith('/accept')) {
      assert.equal(init?.method, 'POST')
      assert.equal((init?.headers as Record<string, string>)['X-CSRF-Token'], 'csrf')
      accepts++
      return accepts === 1 ? new Response(null, { status: 503 }) : Response.json({ project_id: 'p1', access_level: 'edit' })
    }
    throw Error(url)
  }
  render(<MemoryRouter initialEntries={[`/project-invitations/${token}`]}><Routes>
    <Route path="/project-invitations/:token" element={<ProjectInvitationAcceptPage />} />
  </Routes></MemoryRouter>)
  await screen.findByRole('button', { name: '添加项目' })
  assert.equal(accepts, 0)
  fireEvent.click(screen.getByRole('button', { name: '添加项目' }))
  await screen.findByRole('alert')
  fireEvent.click(screen.getByRole('button', { name: '添加项目' }))
  await screen.findByText(/项目已添加/)
  assert.equal(accepts, 2)
  assert.ok(screen.getByRole('button', { name: '进入项目' }))
})

test('signed-out invite preserves token in login return path', async () => {
  globalThis.fetch = async () => new Response(null, { status: 401 })
  render(<MemoryRouter initialEntries={[`/project-invitations/${token}`]}><Routes>
    <Route path="/project-invitations/:token" element={<ProjectInvitationAcceptPage />} />
  </Routes></MemoryRouter>)
  const link = await screen.findByRole('link', { name: '登录 / 注册' })
  assert.equal(link.getAttribute('href'), `/auth?next=${encodeURIComponent('/project-invitations/' + token)}`)
  assert.equal(screen.queryByRole('button', { name: '添加项目' }), null)
})

test('admin sees join records and can prohibit additions with password confirmation', async () => {
  let enabled = true
  const mutations: string[] = []
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url === '/api/auth/step-up') { mutations.push(url); return Response.json({}) }
    if (url.endsWith('/invitation-policy')) {
      mutations.push(url); enabled = false; return Response.json({ invitations_enabled: false })
    }
    if (url.endsWith('/invitations')) return Response.json({ invitations_enabled: enabled, invitations: [{
      id: 'i1', status: 'active', access_level: 'edit', created_by: 'Owner', created_at: '2026-10-09T00:00:00Z',
      expires_at: null, members: [{ user_id: 'g1', name: 'Guest', status: 'active', access_level: 'edit',
        accepted_at: '2026-10-09T00:01:00Z' }],
    }] })
    throw Error(url)
  }
  render(<ProjectInvitationRecords projectId="p1" csrf="csrf" admin />)
  await screen.findByText(/Guest · 有效/)
  fireEvent.click(screen.getByRole('button', { name: '禁止邀请加入' }))
  assert.equal(mutations.length, 0)
  fireEvent.change(screen.getByLabelText('输入管理员密码确认'), { target: { value: 'password' } })
  fireEvent.click(screen.getByRole('button', { name: '确认禁止' }))
  await waitFor(() => assert.deepEqual(mutations, ['/api/auth/step-up', '/api/admin/projects/p1/invitation-policy']))
  await screen.findByRole('button', { name: '允许邀请加入' })
})
