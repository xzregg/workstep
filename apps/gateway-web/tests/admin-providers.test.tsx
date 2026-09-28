import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { JSDOM } from 'jsdom'
import { MemoryRouter } from 'react-router-dom'
import { AdminProvidersPage } from '../src/AdminProvidersPage'
import { AdminProviderDisableDialog, AdminProviderEditorDialog } from '../src/AdminProviderEditorDialog'
import { AdminProviderAssignments } from '../src/AdminProviderAssignments'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://gateway.test/admin/providers',
})
Object.assign(globalThis, { window: dom.window, document: dom.window.document,
  HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver,
  Event: dom.window.Event })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
const { cleanup, fireEvent, render, screen, waitFor, within } = await import('@testing-library/react')
const originalFetch = globalThis.fetch
afterEach(() => { cleanup(); globalThis.fetch = originalFetch })

test('provider directory pages on the server and shows PC application state', async () => {
  const urls: string[] = []
  let applicationFailures = 1
  globalThis.fetch = async input => {
    const url = String(input)
    urls.push(url)
    if (url === '/api/auth/session') return Response.json({ csrf_token: 'csrf' })
    if (url.startsWith('/api/admin/providers/applications?')) {
      if (applicationFailures--) return new Response(null, { status: 503 })
      return Response.json({ devices: [{ device_id: 'pc-1', device_name: 'Office PC',
        device_status: 'active', online: true, desired_revision: 3, applied_revision: 2,
        last_error: 'apply_failed' }], total: 1 })
    }
    if (url.startsWith('/api/admin/providers?')) {
      const params = new URLSearchParams(url.split('?')[1])
      return Response.json({ providers: [{ id: `provider-${params.get('page')}`,
        name: params.get('page') === '2' ? 'Beta API' : 'Alpha API', type: 'custom',
        enabled: true, revision: 3, protocols: ['openai_responses'], model_count: 2,
        protocol_base_urls: { openai_responses: 'https://api.example.test' },
        models: ['model-a', 'model-b'], prices: { version: 'v2', models: {} }, has_key: true,
        price_version: 'v2', assignment_users: 4, assignment_devices: 1, target_devices: 2,
        application: { applied: 1, pending: 0, failed: 0, offline: 1 },
      }], total: 26 })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  }
  render(<MemoryRouter><AdminProvidersPage /></MemoryRouter>)
  await screen.findByText('Alpha API')
  assert.match(document.body.textContent ?? '', /价格版本 v2 · 用户授权 4 · PC 授权 1/)
  fireEvent.change(screen.getByLabelText('搜索名称或类型'), { target: { value: 'Alpha' } })
  fireEvent.click(screen.getByRole('button', { name: '搜索' }))
  await waitFor(() => assert.ok(urls.some(url => url.includes('q=Alpha'))))
  fireEvent.click(screen.getByRole('button', { name: '下一页' }))
  await screen.findByText('Beta API')
  assert.ok(urls.some(url => url.includes('page=2')))
  fireEvent.click(screen.getByRole('button', { name: '查看 PC 应用状态' }))
  await screen.findByText(/设备应用状态加载失败/)
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  await screen.findByText('Office PC')
  assert.match(document.body.textContent ?? '', /失败 · 期望版本 3 · 已应用版本 2/)
  assert.match(document.body.textContent ?? '', /错误：apply_failed/)
})

test('provider editor protects changes and submits configuration with step-up', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    requests.push({ url, init })
    if (url === '/api/auth/step-up') return Response.json({})
    if (url === '/api/admin/providers' || url === '/api/admin/providers/provider-1') {
      return Response.json({ id: 'provider-1' })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  }
  let saved = 0
  render(<AdminProviderEditorDialog csrf="csrf" onClose={() => {}} onSaved={() => { saved++ }} />)
  const dialog = screen.getByRole('dialog', { name: '创建供应商' })
  fireEvent.change(within(dialog).getByLabelText('供应商名称'), { target: { value: 'Company API' } })
  fireEvent.click(within(dialog).getByRole('checkbox', { name: 'OpenAI Responses' }))
  fireEvent.change(within(dialog).getByLabelText('OpenAI Responses 地址'), {
    target: { value: 'https://api.example.test' },
  })
  fireEvent.change(within(dialog).getByLabelText('允许模型（每行一个）'), { target: { value: 'model-a' } })
  fireEvent.change(within(dialog).getByLabelText('model-a 输入单价'), { target: { value: '1' } })
  assert.equal((within(dialog).getByRole('button', { name: '保存供应商' }) as HTMLButtonElement).disabled, true)
  for (const label of ['输出', '缓存读取', '缓存写入']) {
    fireEvent.change(within(dialog).getByLabelText(`model-a ${label}单价`), { target: { value: '2' } })
  }
  fireEvent.change(within(dialog).getByLabelText('供应商凭据'), { target: { value: 'secret-key' } })
  fireEvent.change(within(dialog).getByLabelText('输入管理员密码确认'), { target: { value: 'password' } })
  fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
  const discard = screen.getByRole('dialog', { name: '放弃供应商修改' })
  fireEvent.click(within(discard).getByRole('button', { name: '取消' }))
  fireEvent.click(within(dialog).getByRole('button', { name: '保存供应商' }))
  await waitFor(() => assert.equal(saved, 1))
  const create = requests.find(request => request.url === '/api/admin/providers')
  assert.equal(create?.init?.method, 'POST')
  assert.deepEqual(JSON.parse(String(create?.init?.body)).prices['model-a'], {
    input_per_million: '1', output_per_million: '2',
    cache_read_per_million: '2', cache_write_per_million: '2',
  })
  assert.equal(JSON.parse(String(create?.init?.body)).api_key, 'secret-key')
  cleanup()

  const provider = { id: 'provider-1', name: 'Company API', type: 'custom', enabled: true,
    revision: 1, protocols: ['openai_responses'],
    protocol_base_urls: { openai_responses: 'https://api.example.test' },
    models: ['model-a'], prices: { version: 'v1', models: {} }, has_key: true }
  render(<AdminProviderEditorDialog provider={provider} csrf="csrf" onClose={() => {}}
    onSaved={() => { saved++ }} />)
  const edit = screen.getByRole('dialog', { name: '编辑供应商' })
  fireEvent.change(within(edit).getByLabelText('价格版本'), { target: { value: 'v2' } })
  fireEvent.change(within(edit).getByLabelText('输入管理员密码确认'), { target: { value: 'password' } })
  fireEvent.click(within(edit).getByRole('button', { name: '保存供应商' }))
  await waitFor(() => assert.equal(saved, 2))
  const update = requests.find(request => request.url === '/api/admin/providers/provider-1')
  assert.equal(update?.init?.method, 'PUT')
  assert.equal('api_key' in JSON.parse(String(update?.init?.body)), false)
  cleanup()
  render(<AdminProviderDisableDialog provider={provider} csrf="csrf" onClose={() => {}}
    onSaved={() => { saved++ }} />)
  const disable = screen.getByRole('dialog', { name: '停用供应商' })
  fireEvent.change(within(disable).getByLabelText('输入管理员密码确认'), { target: { value: 'password' } })
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), init })
    return String(input) === '/api/auth/step-up' ? Response.json({}) : new Response(null, { status: 204 })
  }
  fireEvent.click(within(disable).getByRole('button', { name: '确认停用' }))
  await waitFor(() => assert.equal(saved, 3))
  assert.ok(requests.some(request => request.url.endsWith('/disable') && request.init?.method === 'POST'))
})

test('provider assignments select a user or PC and revoke with step-up', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  let assignments: Array<{ id: string; subject_type: 'user' | 'device'; subject_id: string;
    subject_name: string }> = []
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    requests.push({ url, init })
    if (url.startsWith('/api/admin/providers/provider-1/assignments?')) {
      return Response.json({ assignments, total: assignments.length })
    }
    if (url.startsWith('/api/admin/users?')) return Response.json({ users: [
      { id: 'user-1', display_name: 'Alice', username: 'alice' },
    ], total: 1 })
    if (url.startsWith('/api/admin/devices?')) return Response.json({ devices: [
      { id: 'pc-1', name: 'Office PC' },
    ], total: 1 })
    if (url === '/api/auth/step-up') return Response.json({})
    if (url.endsWith('/assign') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body))
      assignments = [{ id: 'assignment-1', ...body,
        subject_name: body.subject_type === 'user' ? 'alice' : 'Office PC' }]
      return Response.json({ id: 'assignment-1' })
    }
    if (url.endsWith('/assign/revoke') && init?.method === 'POST') {
      assignments = []
      return new Response(null, { status: 204 })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  }
  render(<AdminProviderAssignments providerId="provider-1" enabled csrf="csrf" onChanged={() => {}} />)
  await screen.findByText('当前条件下没有授权。')
  fireEvent.click(screen.getByRole('button', { name: '新增分配' }))
  let dialog = screen.getByRole('dialog', { name: '分配供应商' })
  await within(dialog).findByRole('option', { name: 'Alice（alice）' })
  fireEvent.change(within(dialog).getByLabelText('授权对象'), { target: { value: 'user-1' } })
  fireEvent.change(within(dialog).getByLabelText('输入管理员密码确认'), { target: { value: 'password' } })
  fireEvent.click(within(dialog).getByRole('button', { name: '确认分配' }))
  await screen.findByText('alice')
  assert.deepEqual(JSON.parse(String(requests.find(request => request.url.endsWith('/assign'))?.init?.body)), {
    subject_type: 'user', subject_id: 'user-1',
  })
  fireEvent.click(screen.getByRole('button', { name: '撤销' }))
  dialog = screen.getByRole('dialog', { name: '撤销供应商授权' })
  fireEvent.change(within(dialog).getByLabelText('输入管理员密码确认'), { target: { value: 'password' } })
  fireEvent.click(within(dialog).getByRole('button', { name: '撤销授权' }))
  await screen.findByText('当前条件下没有授权。')
  assert.ok(requests.some(request => request.url.endsWith('/assign/revoke')))
  fireEvent.click(screen.getByRole('button', { name: '新增分配' }))
  dialog = screen.getByRole('dialog', { name: '分配供应商' })
  fireEvent.change(within(dialog).getByLabelText('对象类型'), { target: { value: 'device' } })
  await within(dialog).findByRole('option', { name: 'Office PC' })
  fireEvent.change(within(dialog).getByLabelText('授权对象'), { target: { value: 'pc-1' } })
  fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
  assert.ok(screen.getByRole('dialog', { name: '放弃供应商授权修改' }))
})
