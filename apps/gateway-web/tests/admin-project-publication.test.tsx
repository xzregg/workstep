import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { JSDOM } from 'jsdom'
import { MemoryRouter } from 'react-router-dom'
import { AdminProjectsPage } from '../src/AdminProjectsPage'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://gateway.test/admin/projects' })
Object.assign(globalThis, { window: dom.window, document: dom.window.document,
  HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver,
  Event: dom.window.Event })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
const { cleanup, fireEvent, render, screen, waitFor, within } = await import('@testing-library/react')
const originalFetch = globalThis.fetch
afterEach(() => { cleanup(); globalThis.fetch = originalFetch })

test('administrator publishes from live PC catalog and unpublishes without deleting host data', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  let published = false
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    requests.push({ url, init })
    if (url === '/api/auth/session') return Response.json({ csrf_token: 'csrf' })
    if (url.startsWith('/api/admin/projects?')) return Response.json({ projects: published ? [{
      id: 'project-1', name: 'Backend', device_id: 'pc-1', device_name: 'PC One',
      device_online: true, publisher: 'owner', published_at: '2026-01-01',
      grant_users: 0, grant_groups: 0, grant_levels: { read: 0, edit: 0 }, running_tasks: null,
    }] : [], total: published ? 1 : 0 })
    if (url.startsWith('/api/admin/devices?')) return Response.json({ devices: [{
      id: 'pc-1', name: 'PC One', online: true, daemon_health: true,
    }], total: 1 })
    if (url.startsWith('/api/admin/devices/pc-1/publishable-projects?')) return Response.json({
      projects: [{ host_project_id: 'host-1', name: 'Backend', published }], total: 1,
    })
    if (url === '/api/auth/step-up') return Response.json({})
    if (url === '/api/admin/devices/pc-1/projects/host-1/publish') {
      published = true
      return Response.json({ project_id: 'project-1', status: 'published' })
    }
    if (url === '/api/admin/projects/project-1/unpublish') {
      published = false
      return Response.json({ project_id: 'project-1', status: 'unpublished' })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  }
  render(<MemoryRouter><AdminProjectsPage /></MemoryRouter>)
  await screen.findByText('当前条件下没有已发布项目。')
  assert.equal(requests.some(request => request.url.startsWith('/api/admin/devices?')), false)
  fireEvent.click(screen.getByRole('button', { name: '从 PC 发布项目' }))
  assert.ok(screen.getByRole('dialog', { name: '从 PC 发布项目' }))
  await screen.findByText('PC One')
  fireEvent.click(screen.getByRole('button', { name: '查看可发布项目' }))
  await screen.findByText('host-1 · 未发布')
  assert.equal(screen.queryByRole('button', { name: '查看可发布项目' }), null)
  fireEvent.click(screen.getByRole('button', { name: '重新选择电脑' }))
  fireEvent.click(screen.getByRole('button', { name: '查看可发布项目' }))
  await screen.findByText('host-1 · 未发布')
  fireEvent.click(screen.getByRole('button', { name: '发布' }))
  const publish = screen.getByRole('dialog', { name: '发布平台项目' })
  assert.match(publish.textContent ?? '', /再次向在线 PC 核对项目/)
  fireEvent.click(within(screen.getByRole('dialog', { name: '从 PC 发布项目' })).getByRole('button', { name: '关闭弹窗' }))
  assert.ok(screen.getByRole('dialog', { name: '发布平台项目' }))
  fireEvent.change(within(publish).getByLabelText('输入管理员密码确认'), { target: { value: 'password' } })
  fireEvent.click(within(publish).getByRole('button', { name: '确认发布' }))
  await screen.findByRole('button', { name: '取消发布' })
  assert.equal(screen.queryByRole('dialog', { name: '从 PC 发布项目' }), null)
  assert.ok(requests.some(request => request.url.endsWith('/projects/host-1/publish')
    && request.init?.method === 'POST'))
  fireEvent.click(screen.getByRole('button', { name: '取消发布' }))
  const unpublish = screen.getByRole('dialog', { name: '取消项目发布' })
  assert.match(unpublish.textContent ?? '', /不删除宿主 PC 的项目目录或数据/)
  fireEvent.change(within(unpublish).getByLabelText('输入管理员密码确认'), { target: { value: 'password' } })
  fireEvent.click(within(unpublish).getByRole('button', { name: '取消发布' }))
  await waitFor(() => assert.ok(requests.some(request => request.url.endsWith('/project-1/unpublish'))))
  await screen.findByText('当前条件下没有已发布项目。')
})
