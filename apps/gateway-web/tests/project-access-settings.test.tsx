import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { JSDOM } from 'jsdom'
import { MemoryRouter } from 'react-router-dom'
import { ProjectWorkspacePage } from '../src/ProjectWorkspacePage'
import { ProjectAccessSettings } from '../src/ProjectAccessSettings'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://d-device-1.gateway.test/',
})
Object.assign(globalThis, { window: dom.window, document: dom.window.document,
  HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver,
  Event: dom.window.Event })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const originalFetch = globalThis.fetch
afterEach(() => { cleanup(); globalThis.fetch = originalFetch })

test('project settings shows grant sources and levels without exposing edits to members', async () => {
  const requests: string[] = []
  globalThis.fetch = async input => {
    const url = String(input)
    requests.push(url)
    if (url === '/api/remote/session') return Response.json({
      project_id: 'project-1', host_project_id: 'host-1', access_level: 'read',
      task_create: false, share_create: false, can_manage_project_access: false,
      gateway_url: 'https://gateway.test/devices',
    })
    if (url === '/api/project/host-1/summary') return Response.json({
      id: 'host-1', name: 'Project', workflows: [],
    })
    if (url === '/api/task/list?project_id=host-1') return Response.json({ tasks: [] })
    if (url === '/api/remote/project-grants') return Response.json({ grants: [
      { subject_type: 'group', subject_id: 'group-1', subject_name: 'Backend', access_level: 'read' },
      { subject_type: 'user', subject_id: 'user-1', subject_name: 'Alice', access_level: 'edit' },
    ] })
    throw new Error(`Unexpected fetch ${url}`)
  }
  render(<MemoryRouter><ProjectWorkspacePage /></MemoryRouter>)
  fireEvent.click(await screen.findByRole('button', { name: '项目设置' }))
  assert.equal(requests.includes('/api/remote/project-grants'), false)
  fireEvent.click(screen.getByRole('tab', { name: '访问授权' }))
  await screen.findByText('用户组 · Backend · 只读')
  assert.ok(screen.getByText('用户 · Alice · 可编辑'))
  assert.equal(screen.queryByRole('link', { name: '管理授权' }), null)
  await waitFor(() => assert.equal(requests.filter(url => url === '/api/remote/project-grants').length, 1))
})

test('project access managers get the Gateway admin entry', async () => {
  globalThis.fetch = async () => Response.json({ grants: [] })
  render(<ProjectAccessSettings projectName="Project" accessLevel="edit"
    canManage gatewayUrl="https://gateway.test/devices" />)
  fireEvent.click(screen.getByRole('tab', { name: '访问授权' }))
  const link = await screen.findByRole('link', { name: '管理授权' })
  assert.equal(link.getAttribute('href'), 'https://gateway.test/admin/projects')
})
