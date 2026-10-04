import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { JSDOM } from 'jsdom'
import { MemoryRouter } from 'react-router-dom'
import { AdminSkillsPage } from '../src/AdminSkillsPage'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://gateway.test/admin/skills',
})
Object.assign(globalThis, { window: dom.window, document: dom.window.document,
  HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver,
  Event: dom.window.Event, File: dom.window.File })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const originalFetch = globalThis.fetch
afterEach(() => { cleanup(); globalThis.fetch = originalFetch })

test('Skill administrator creates, uploads, reviews, grants, and revokes with step-up', async () => {
  const writes: Array<{ url: string; method: string; body?: Record<string, unknown> }> = []
  let skillExists = false
  let versionStatus = ''
  let granted = false
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (method !== 'GET') writes.push({ url, method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (url === '/api/auth/session') return Response.json({ csrf_token: 'csrf-admin' })
    if (url === '/api/admin/skills' && method === 'GET') return Response.json({ skills: skillExists
      ? [{ id: 'skill-1', name: '审核 Skill', slug: 'review', description: '', status: 'active' }] : [] })
    if (url === '/api/admin/groups') return Response.json({ groups: [
      { id: 'group-1', name: '研发组', slug: 'dev', source_type: 'manual' },
    ] })
    if (url === '/api/admin/skills/applications') return Response.json({ projects: [{
      project_id: 'project-1', project_name: '项目一', device_id: 'device-1', device_name: 'PC 一',
      desired_revision: 2, applied_revision: 1, status: 'pending', last_error_code: null,
    }] })
    if (url === '/api/admin/skills/skill-1/versions' && method === 'GET') {
      return Response.json({ versions: versionStatus ? [{ id: 'version-1', skill_id: 'skill-1',
        version: '1.0.0', status: versionStatus, digest: 'abc', file_count: 1, total_size: 10 }] : [] })
    }
    if (url === '/api/admin/groups/group-1/skills' && method === 'GET') {
      return Response.json({ skills: granted ? [{ skill_id: 'skill-1', name: '审核 Skill',
        slug: 'review', skill_version_id: 'version-1', version: '1.0.0', status: 'approved' }] : [] })
    }
    if (url === '/api/auth/step-up') return Response.json({ expires_in_seconds: 300 })
    if (url === '/api/admin/skills' && method === 'POST') {
      skillExists = true; return Response.json({ id: 'skill-1' }, { status: 201 })
    }
    if (url === '/api/admin/skills/skill-1/versions' && method === 'POST') {
      versionStatus = 'pending_review'; return Response.json({ id: 'version-1' }, { status: 201 })
    }
    if (url === '/api/admin/skills/skill-1/versions/version-1/approve' && method === 'POST') {
      versionStatus = 'approved'; return Response.json({ id: 'version-1' })
    }
    if (url === '/api/admin/groups/group-1/skills' && method === 'POST') {
      granted = true; return Response.json({ group_id: 'group-1' })
    }
    if (url === '/api/admin/groups/group-1/skills/skill-1' && method === 'DELETE') {
      granted = false; return new Response(null, { status: 204 })
    }
    throw new Error(`Unexpected fetch: ${url} ${method}`)
  }
  render(<MemoryRouter><AdminSkillsPage /></MemoryRouter>)
  await screen.findByText(/项目一 · PC 一/)
  fireEvent.click(screen.getByRole('button', { name: '创建 Skill' }))
  let dialog = await screen.findByRole('dialog', { name: '创建 Skill' })
  const { getByLabelText, getByRole } = await import('@testing-library/dom')
  fireEvent.change(getByLabelText(dialog, '名称'), { target: { value: '审核 Skill' } })
  fireEvent.change(getByLabelText(dialog, '标识'), { target: { value: 'review' } })
  fireEvent.change(getByLabelText(dialog, '管理员密码'), { target: { value: 'secret' } })
  fireEvent.click(getByRole(dialog, 'button', { name: '确认创建' }))
  await screen.findByRole('option', { name: '审核 Skill' })
  fireEvent.change(screen.getByLabelText('Skill'), { target: { value: 'skill-1' } })
  fireEvent.click(screen.getByRole('button', { name: '上传版本' }))
  dialog = await screen.findByRole('dialog', { name: '上传版本' })
  fireEvent.change(getByLabelText(dialog, '版本号'), { target: { value: '1.0.0' } })
  const file = new dom.window.File(['zip-content'], 'review.zip', { type: 'application/zip' })
  Object.defineProperty(file, 'arrayBuffer', { value: async () => new TextEncoder().encode('zip-content').buffer })
  fireEvent.change(getByLabelText(dialog, 'Skill ZIP 包'), { target: { files: [file] } })
  fireEvent.change(getByLabelText(dialog, '管理员密码'), { target: { value: 'secret' } })
  fireEvent.click(getByRole(dialog, 'button', { name: '确认上传' }))
  await screen.findByText(/1.0.0 · 待审核/)
  assert.equal(writes.find(item => item.url === '/api/admin/skills/skill-1/versions')?.body?.archive_base64,
    btoa('zip-content'))
  fireEvent.click(screen.getByRole('button', { name: '批准版本 1.0.0' }))
  dialog = await screen.findByRole('dialog', { name: '批准版本' })
  fireEvent.change(getByLabelText(dialog, '管理员密码'), { target: { value: 'secret' } })
  fireEvent.click(getByRole(dialog, 'button', { name: '确认批准' }))
  await screen.findByText(/1.0.0 · 已批准/)
  fireEvent.change(screen.getByLabelText('用户组'), { target: { value: 'group-1' } })
  fireEvent.click(screen.getByRole('button', { name: '授权用户组' }))
  dialog = await screen.findByRole('dialog', { name: '授权用户组' })
  fireEvent.change(getByLabelText(dialog, '管理员密码'), { target: { value: 'secret' } })
  fireEvent.click(getByRole(dialog, 'button', { name: '确认授权' }))
  await screen.findByText(/审核 Skill · 1.0.0 · 已授权/)
  fireEvent.click(screen.getByRole('button', { name: '撤销组授权 审核 Skill' }))
  dialog = await screen.findByRole('dialog', { name: '撤销组授权' })
  fireEvent.change(getByLabelText(dialog, '管理员密码'), { target: { value: 'secret' } })
  fireEvent.click(getByRole(dialog, 'button', { name: '确认撤销' }))
  await waitFor(() => assert.equal(granted, false))
  const stepUps = writes.filter(item => item.url === '/api/auth/step-up')
  assert.equal(stepUps.length, 5)
  assert.ok(writes.every(item => item.url === '/api/auth/step-up'
    || writes.findIndex(step => step.url === '/api/auth/step-up') < writes.indexOf(item)))
})

test('edited Skill action asks before discarding the form', async () => {
  globalThis.fetch = async input => {
    const url = String(input)
    if (url === '/api/auth/session') return Response.json({ csrf_token: 'csrf-admin' })
    if (url === '/api/admin/skills') return Response.json({ skills: [] })
    if (url === '/api/admin/groups') return Response.json({ groups: [] })
    if (url === '/api/admin/skills/applications') return Response.json({ projects: [] })
    throw new Error(`Unexpected fetch: ${url}`)
  }
  render(<MemoryRouter><AdminSkillsPage /></MemoryRouter>)
  fireEvent.click(await screen.findByRole('button', { name: '创建 Skill' }))
  const dialog = await screen.findByRole('dialog', { name: '创建 Skill' })
  const { getByLabelText, getByRole } = await import('@testing-library/dom')
  fireEvent.change(getByLabelText(dialog, '名称'), { target: { value: '草稿' } })
  fireEvent.click(getByRole(dialog, 'button', { name: '取消' }))
  const discard = await screen.findByRole('dialog', { name: '放弃 Skill 操作' })
  fireEvent.click(getByRole(discard, 'button', { name: '继续编辑' }))
  assert.equal((getByLabelText(dialog, '名称') as HTMLInputElement).value, '草稿')
  fireEvent.click(getByRole(dialog, 'button', { name: '取消' }))
  fireEvent.click(getByRole(await screen.findByRole('dialog', { name: '放弃 Skill 操作' }),
    'button', { name: '放弃并关闭' }))
  assert.equal(screen.queryByRole('dialog', { name: '创建 Skill' }), null)
})
