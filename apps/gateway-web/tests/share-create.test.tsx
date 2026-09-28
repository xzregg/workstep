import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { JSDOM } from 'jsdom'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { GatewayShareCreatePage } from '../src/GatewayShareCreatePage'
import { ProjectWorkspacePage } from '../src/ProjectWorkspacePage'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://gateway.test/shares/new?project_id=project-1&task_id=task-1',
})
Object.assign(globalThis, { window: dom.window, document: dom.window.document,
  HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver,
  Event: dom.window.Event })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const originalFetch = globalThis.fetch
afterEach(() => { cleanup(); globalThis.fetch = originalFetch })

test('project task opens Gateway-owned share creation on the main host', async () => {
  globalThis.fetch = async input => {
    const url = String(input)
    if (url === '/api/remote/session') return Response.json({
      project_id: 'project-1', host_project_id: 'host-1', access_level: 'edit',
      task_create: false, share_create: true, gateway_url: 'https://gateway.test/devices',
    })
    if (url === '/api/project/host-1/summary') return Response.json({
      id: 'host-1', name: 'Project', workflows: [],
    })
    if (url === '/api/task/list?project_id=host-1') return Response.json({
      tasks: [{ id: 'task-1', title: 'Task', status: 'ready' }],
    })
    if (url === '/api/task/task-1?project_id=host-1') return Response.json({
      id: 'task-1', title: 'Task', status: 'ready',
    })
    throw new Error(`Unexpected fetch ${url}`)
  }
  render(<MemoryRouter><ProjectWorkspacePage /></MemoryRouter>)
  fireEvent.click(await screen.findByRole('button', { name: '查看任务' }))
  const link = await screen.findByRole('link', { name: '创建平台分享' })
  assert.equal(link.getAttribute('href'),
    'https://gateway.test/shares/new?project_id=project-1&task_id=task-1')
})

test('Gateway share page validates and creates a task share with CSRF', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    calls.push({ url, init })
    if (url === '/api/auth/session') return Response.json({ csrf_token: 'csrf-token' })
    if (url === '/api/platform-shares') return Response.json({
      id: 'share-1', url: 'https://gateway.test/share/public-token',
      status: 'active', mode: 'read_only', title: 'Task for review',
    }, { status: 201 })
    if (url === '/api/platform-shares/share-1/revoke') return new Response(null, { status: 204 })
    throw new Error(`Unexpected fetch ${url}`)
  }
  render(<MemoryRouter initialEntries={['/shares/new?project_id=project-1&task_id=task-1']}>
    <Routes><Route path="/shares/new" element={<GatewayShareCreatePage />} /></Routes>
  </MemoryRouter>)
  await screen.findByRole('button', { name: '创建分享' })
  fireEvent.change(screen.getByLabelText('分享标题'), { target: { value: 'Task for review' } })
  fireEvent.click(screen.getByRole('button', { name: '创建分享' }))
  const link = await screen.findByRole('link', { name: '打开分享链接' })
  assert.equal(link.getAttribute('href'), 'https://gateway.test/share/public-token')
  const create = calls.find(call => call.url === '/api/platform-shares')
  assert.equal(create?.init?.headers && (create.init.headers as Record<string, string>)['X-CSRF-Token'],
    'csrf-token')
  assert.deepEqual(JSON.parse(String(create?.init?.body)), {
    project_id: 'project-1', task_id: 'task-1', mode: 'read_only',
    title: 'Task for review', password: null, expires_at: null,
  })
  fireEvent.click(screen.getByRole('button', { name: '撤销分享' }))
  fireEvent.click(screen.getByRole('dialog', { name: '确认撤销分享' })
    .querySelector('button:last-child')!)
  await waitFor(() => assert.ok(calls.some(call => call.url === '/api/platform-shares/share-1/revoke')))
  await screen.findByText('分享已撤销。')
})
