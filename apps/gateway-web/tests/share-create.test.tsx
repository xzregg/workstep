import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { JSDOM } from 'jsdom'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { GatewayShareCreatePage } from '../src/GatewayShareCreatePage'

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

test('Gateway share page validates and creates a task share with CSRF', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    calls.push({ url, init })
    if (url === '/api/auth/session') return Response.json({ csrf_token: 'csrf-token' })
    if (url.startsWith('/api/platform-shares?')) return Response.json({ shares: [] })
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

test('creator can revisit and revoke an existing share without recovering its token', async () => {
  let revoked = false
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url === '/api/auth/session') return Response.json({ csrf_token: 'csrf-token' })
    if (url.startsWith('/api/platform-shares?')) return Response.json({ shares: [{
      id: 'old-share', title: '旧链接', mode: 'read_only',
      status: revoked ? 'revoked' : 'active', created_at: '2026-09-29T10:00:00Z',
      expires_at: null,
    }] })
    if (url === '/api/platform-shares/old-share/revoke' && init?.method === 'POST') {
      revoked = true
      return new Response(null, { status: 204 })
    }
    throw new Error(`Unexpected fetch ${url}`)
  }
  render(<MemoryRouter initialEntries={['/shares/new?project_id=project-1&task_id=task-1']}>
    <Routes><Route path="/shares/new" element={<GatewayShareCreatePage />} /></Routes>
  </MemoryRouter>)
  await screen.findByText(/旧链接 · 有效/)
  assert.equal(screen.queryByText('https://gateway.test/share/old-share'), null)
  fireEvent.click(screen.getByRole('button', { name: '撤销旧链接' }))
  fireEvent.click(screen.getByRole('dialog', { name: '确认撤销分享' })
    .querySelector('button:last-child')!)
  await screen.findByText(/旧链接 · 已撤销/)
})
