import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { JSDOM } from 'jsdom'
import { MemoryRouter } from 'react-router-dom'
import { AdminSharesPage } from '../src/AdminSharesPage'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://gateway.test/admin/shares',
})
Object.assign(globalThis, { window: dom.window, document: dom.window.document,
  HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver,
  Event: dom.window.Event })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
const { cleanup, fireEvent, render, screen, waitFor, within } = await import('@testing-library/react')
const originalFetch = globalThis.fetch
afterEach(() => { cleanup(); globalThis.fetch = originalFetch })

test('share management lists metadata without credentials and pauses, resumes, revokes', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  let status = 'active'
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    calls.push({ url, init })
    if (url === '/api/auth/session') return Response.json({ csrf_token: 'csrf-token' })
    if (url.startsWith('/api/admin/shares?')) return Response.json({ total: 1, shares: [{
      id: 'share-1', title: 'Review link', created_by: 'owner', device_name: 'PC',
      project_name: 'Project', task_id: 'task-1', mode: 'read_only',
      visit_count: 2, last_seen_at: '2026-09-29T12:00:00Z',
      created_at: '2026-09-29T10:00:00Z', expires_at: null, status,
    }] })
    if (url.endsWith('/pause')) { status = 'paused'; return new Response(null, { status: 204 }) }
    if (url.endsWith('/resume')) { status = 'active'; return new Response(null, { status: 204 }) }
    if (url.endsWith('/revoke')) { status = 'revoked'; return new Response(null, { status: 204 }) }
    throw new Error(`Unexpected fetch ${url}`)
  }
  render(<MemoryRouter><AdminSharesPage /></MemoryRouter>)
  await screen.findByText('Review link')
  assert.match(document.body.textContent ?? '', /owner/)
  assert.match(document.body.textContent ?? '', /PC/)
  assert.match(document.body.textContent ?? '', /2 次访问/)
  assert.equal(document.body.textContent?.includes('token_hash'), false)
  fireEvent.click(screen.getByRole('button', { name: '暂停' }))
  await screen.findByRole('button', { name: '恢复' })
  fireEvent.click(screen.getByRole('button', { name: '恢复' }))
  await screen.findByRole('button', { name: '暂停' })
  fireEvent.click(screen.getByRole('button', { name: '撤销' }))
  const dialog = screen.getByRole('dialog', { name: '确认撤销分享' })
  fireEvent.click(within(dialog).getByRole('button', { name: '确认撤销' }))
  await screen.findByText('已撤销')
  assert.equal(calls.filter(call => call.url.endsWith('/pause')).length, 1)
  assert.equal(calls.filter(call => call.url.endsWith('/resume')).length, 1)
  assert.equal(calls.filter(call => call.url.endsWith('/revoke')).length, 1)
  assert.ok(calls.filter(call => /\/(pause|resume|revoke)$/.test(call.url)).every(call =>
    (call.init?.headers as Record<string, string>)['X-CSRF-Token'] === 'csrf-token'))
  fireEvent.change(screen.getByLabelText('分享状态'), { target: { value: 'paused' } })
  await waitFor(() => assert.ok(calls.some(call => call.url.includes('status=paused'))))
})
