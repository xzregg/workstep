import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { JSDOM } from 'jsdom'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { App } from '../src/App'
import { PublicSharePage } from '../src/PublicSharePage'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://gateway.test/share/sample-token',
})
Object.assign(globalThis, { window: dom.window, document: dom.window.document,
  HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver,
  Event: dom.window.Event })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const originalFetch = globalThis.fetch
afterEach(() => { cleanup(); globalThis.fetch = originalFetch })

test('public share route works without portal authentication and unlocks task', async () => {
  const calls: Array<{ url: string; method: string; body?: string }> = []
  let unlocked = false
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    calls.push({ url, method: init?.method ?? 'GET', body: String(init?.body ?? '') })
    if (url.endsWith('/meta')) return Response.json({
      title: 'Demo share', mode: 'read_only', has_password: true, status: 'active',
    })
    if (url.endsWith('/session')) return unlocked
      ? Response.json({ share_id: 'share-1', mode: 'read_only', task_id: 'task-1' })
      : new Response(null, { status: 401 })
    if (url.endsWith('/unlock')) { unlocked = true; return Response.json({ unlocked: true }) }
    if (url.endsWith('/task')) return Response.json({
      id: 'task-1', title: 'Visible task', description: 'Visible description',
      status: 'running', created_at: '2026-09-29T10:00:00Z',
    })
    if (url.endsWith('/history')) return Response.json({ messages: [{
      id: 'message-1', role: 'assistant', content: 'Visible execution reply',
      step_key: 'build', created_at: '2026-09-29T10:05:00Z',
    }] })
    throw new Error(`Unexpected fetch: ${url}`)
  }
  render(<MemoryRouter initialEntries={['/share/sample-token']}><App /></MemoryRouter>)
  await screen.findByLabelText('分享密码')
  assert.equal(screen.queryByText('WorkStep Gateway'), null)
  assert.equal(calls.some(call => call.url.includes('/api/admin/')), false)
  fireEvent.change(screen.getByLabelText('分享密码'), { target: { value: 'secret' } })
  fireEvent.click(screen.getByRole('button', { name: '查看任务' }))
  await screen.findByText('Visible task')
  assert.match(document.body.textContent ?? '', /Visible description/)
  assert.match(document.body.textContent ?? '', /只读分享/)
  await screen.findByText('Visible execution reply')
  assert.equal(calls.find(call => call.url.endsWith('/unlock'))?.body,
    JSON.stringify({ password: 'secret' }))
})

test('public share reports offline host and allows retry', async () => {
  let offline = true
  globalThis.fetch = async input => {
    const url = String(input)
    if (url.endsWith('/meta')) return Response.json({
      title: 'Demo', mode: 'read_only', has_password: false, status: 'active',
    })
    if (url.endsWith('/session')) return new Response(null, { status: 401 })
    if (url.endsWith('/unlock')) return Response.json({ unlocked: true })
    if (url.endsWith('/task')) return offline
      ? new Response(null, { status: 503 })
      : Response.json({ id: 'task-1', title: 'Recovered', status: 'ready' })
    if (url.endsWith('/history')) return Response.json({ messages: [] })
    throw new Error(`Unexpected fetch: ${url}`)
  }
  render(<MemoryRouter initialEntries={['/share/sample-token']}><Routes>
    <Route path="/share/:token" element={<PublicSharePage />} />
  </Routes></MemoryRouter>)
  await screen.findByText(/宿主电脑暂时不可用/)
  offline = false
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  await screen.findByText('Recovered')
  await waitFor(() => assert.equal(screen.queryByText(/宿主电脑暂时不可用/), null))
})

test('public share retries metadata after a temporarily unavailable host', async () => {
  let unavailable = true
  globalThis.fetch = async input => {
    const url = String(input)
    if (url.endsWith('/meta')) return unavailable
      ? new Response(null, { status: 503 })
      : Response.json({ title: 'Demo', mode: 'read_only', has_password: false, status: 'active' })
    if (url.endsWith('/session')) return Response.json({ share_id: 'share-1',
      mode: 'read_only', task_id: 'task-1' })
    if (url.endsWith('/task')) return Response.json({ id: 'task-1', title: 'Available',
      status: 'ready' })
    if (url.endsWith('/history')) return Response.json({ messages: [] })
    throw new Error(`Unexpected fetch: ${url}`)
  }
  render(<MemoryRouter initialEntries={['/share/sample-token']}><Routes>
    <Route path="/share/:token" element={<PublicSharePage />} />
  </Routes></MemoryRouter>)
  await screen.findByText(/宿主电脑暂时不可用/)
  unavailable = false
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  await screen.findByText('Available')
  await screen.findByText('Demo')
})
