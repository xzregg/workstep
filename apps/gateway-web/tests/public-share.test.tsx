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
    if (url.endsWith('/host-status')) return Response.json({
      connected: true, daemon_health: false,
    })
    if (url.endsWith('/history')) return Response.json({ messages: [{
      id: 'message-1', role: 'assistant', content: 'Visible execution reply',
      step_key: 'build', created_at: '2026-09-29T10:05:00Z',
    }, {
      id: 'message-2', role: 'user', step_key: 'build',
      content: `[report.txt](.workstep/uploads/t${'a'.repeat(24)}-${'b'.repeat(32)}.txt)`,
      created_at: '2026-09-29T10:06:00Z',
    }, {
      id: 'message-3', role: 'user', step_key: 'build',
      content: '[private](.workstep/uploads/other-task-file.txt)',
      created_at: '2026-09-29T10:07:00Z',
    }] })
    if (url.endsWith('/artifacts')) return Response.json({ artifacts: [{
      id: 'a'.repeat(64), name: 'result.txt', step_key: 'build', size: 13,
    }] })
    if (url.endsWith(`/artifacts/${'a'.repeat(64)}/preview`)) return Response.json({
      type: 'text', content: 'Preview content', content_type: 'text/plain',
    })
    if (url.endsWith('/events/message-1/0')) return Response.json({ events: [{
      type: 'TEXT_MESSAGE_CHUNK', delta: 'Visible event detail',
    }], next_cursor: 100 })
    if (url.endsWith('/events/message-1/100')) return Response.json({ events: [{
      type: 'TEXT_MESSAGE_CHUNK', delta: 'Later event detail',
    }], next_cursor: null })
    throw new Error(`Unexpected fetch: ${url}`)
  }
  render(<MemoryRouter initialEntries={['/share/sample-token']}><App /></MemoryRouter>)
  await screen.findByLabelText('分享密码')
  assert.equal(screen.queryByText('WorkStep Gateway'), null)
  assert.equal(calls.some(call => call.url.includes('/api/admin/')), false)
  fireEvent.change(screen.getByLabelText('分享密码'), { target: { value: 'secret' } })
  fireEvent.click(screen.getByRole('button', { name: '查看任务' }))
  await screen.findByText('Visible task')
  await screen.findByText('宿主电脑已连接，WorkStep 服务暂时不可用。')
  assert.match(document.body.textContent ?? '', /Visible description/)
  assert.match(document.body.textContent ?? '', /只读分享/)
  await screen.findByText('Visible execution reply')
  assert.equal((await screen.findByRole('link', { name: 'report.txt' })).getAttribute('href'),
    `/api/public/shares/sample-token/uploads/t${'a'.repeat(24)}-${'b'.repeat(32)}.txt`)
  assert.equal(screen.queryByRole('link', { name: 'private' }), null)
  assert.equal(screen.queryByRole('button', { name: '发送消息' }), null)
  fireEvent.click(screen.getAllByRole('button', { name: '查看过程' })[0])
  await screen.findByText(/Visible event detail/)
  fireEvent.click(screen.getByRole('button', { name: '加载更多过程' }))
  await screen.findByText(/Later event detail/)
  const artifact = await screen.findByRole('link', { name: /result.txt/ })
  assert.equal(artifact.getAttribute('href'),
    `/api/public/shares/sample-token/artifacts/${'a'.repeat(64)}/content`)
  fireEvent.click(screen.getByRole('button', { name: '预览 result.txt' }))
  await screen.findByText('Preview content')
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
    if (url.endsWith('/host-status')) return Response.json({ connected: false, daemon_health: null })
    if (url.endsWith('/task')) return offline
      ? new Response(null, { status: 503 })
      : Response.json({ id: 'task-1', title: 'Recovered', status: 'ready' })
    if (url.endsWith('/history')) return Response.json({ messages: [] })
    if (url.endsWith('/artifacts')) return Response.json({ artifacts: [] })
    throw new Error(`Unexpected fetch: ${url}`)
  }
  render(<MemoryRouter initialEntries={['/share/sample-token']}><Routes>
    <Route path="/share/:token" element={<PublicSharePage />} />
  </Routes></MemoryRouter>)
  await screen.findByText(/宿主电脑暂时不可用/)
  await screen.findByText('宿主电脑当前离线。')
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
    if (url.endsWith('/artifacts')) return Response.json({ artifacts: [] })
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

test('public share loads older execution messages on demand', async () => {
  const calls: string[] = []
  globalThis.fetch = async input => {
    const url = String(input)
    calls.push(url)
    if (url.endsWith('/meta')) return Response.json({
      title: 'History', mode: 'read_only', has_password: false, status: 'active',
    })
    if (url.endsWith('/session')) return Response.json({ share_id: 'share-1',
      mode: 'read_only', task_id: 'task-1' })
    if (url.endsWith('/task')) return Response.json({ id: 'task-1', title: 'Task',
      status: 'ready' })
    if (url.endsWith('/history')) return Response.json({ messages: [{
      id: 'new', role: 'assistant', content: 'Newest message', step_key: 'build',
      created_at: '2026-09-29T10:00:00Z',
    }], next_offset: 100 })
    if (url.endsWith('/history/100')) return Response.json({ messages: [{
      id: 'old', role: 'assistant', content: 'Older message', step_key: 'build',
      created_at: '2026-09-29T09:00:00Z',
    }], next_offset: null })
    if (url.endsWith('/artifacts')) return Response.json({ artifacts: [] })
    throw new Error(`Unexpected fetch: ${url}`)
  }
  render(<MemoryRouter initialEntries={['/share/sample-token']}><Routes>
    <Route path="/share/:token" element={<PublicSharePage />} />
  </Routes></MemoryRouter>)
  await screen.findByText('Newest message')
  fireEvent.click(screen.getByRole('button', { name: '加载更早消息' }))
  await screen.findByText('Older message')
  assert.equal(calls.filter(url => url.endsWith('/history/100')).length, 1)
  assert.equal(screen.queryByRole('button', { name: '加载更早消息' }), null)
})

test('interactive public share sends a step message with session CSRF', async () => {
  const calls: Array<{ url: string; method: string; headers?: HeadersInit; body?: BodyInit | null }> = []
  let sent = false
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    calls.push({ url, method: init?.method ?? 'GET', headers: init?.headers, body: init?.body })
    if (url.endsWith('/meta')) return Response.json({
      title: 'Interactive', mode: 'interactive', has_password: false, status: 'active',
    })
    if (url.endsWith('/session')) return new Response(null, { status: 401 })
    if (url.endsWith('/unlock')) return Response.json({ unlocked: true, csrf_token: 'csrf-1' })
    if (url.endsWith('/task')) return Response.json({ id: 'task-1', title: 'Task',
      status: 'running', steps: [{ step_key: 'build', status: 'running', has_history: true }] })
    if (url.endsWith('/history')) return Response.json({ messages: sent ? [{
      id: 'sent-1', role: 'user', content: 'Please continue', step_key: 'build',
      created_at: '2026-09-29T10:00:00Z',
    }] : [], next_offset: null })
    if (url.endsWith('/artifacts')) return Response.json({ artifacts: [] })
    if (url.endsWith('/reviews')) return Response.json({ reviews: [] })
    if (url.endsWith('/interventions')) return Response.json({ interventions: [] })
    if (url.endsWith('/uploads') && init?.method === 'POST') return Response.json({
      filename: `t${'a'.repeat(24)}-${'b'.repeat(32)}.txt`, size: 7,
      url: `.workstep/uploads/t${'a'.repeat(24)}-${'b'.repeat(32)}.txt`,
    })
    if (url.endsWith('/steps/build/message')) {
      sent = true
      return Response.json({ message_id: 'sent-1' })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  }
  render(<MemoryRouter initialEntries={['/share/sample-token']}><Routes>
    <Route path="/share/:token" element={<PublicSharePage />} />
  </Routes></MemoryRouter>)
  await screen.findByText('Task')
  fireEvent.change(screen.getByLabelText('发送给步骤'), { target: { value: 'build' } })
  fireEvent.change(screen.getByLabelText('消息内容'), { target: { value: 'Please continue' } })
  fireEvent.click(screen.getByRole('button', { name: '发送消息' }))
  await screen.findByText('Please continue')
  const posted = calls.find(call => call.url.endsWith('/steps/build/message'))
  assert.equal(posted?.method, 'POST')
  assert.equal((posted?.headers as Record<string, string>)?.['X-Share-CSRF'], 'csrf-1')
  assert.equal(posted?.body, JSON.stringify({ content: 'Please continue' }))
  const file = new dom.window.File(['visible'], 'report.txt', { type: 'text/plain' })
  fireEvent.change(screen.getByLabelText('添加附件'), { target: { files: [file] } })
  await screen.findByRole('link', { name: 'report.txt' })
  const upload = calls.find(call => call.url.endsWith('/uploads') && call.method === 'POST')
  assert.equal((upload?.headers as Record<string, string>)?.['X-Share-CSRF'], 'csrf-1')
  assert.equal((upload?.headers as Record<string, string>)?.['X-Share-Filename'], 'report.txt')
  assert.equal(upload?.body, file)
  fireEvent.click(screen.getByRole('button', { name: '发送消息' }))
  await waitFor(() => assert.equal(calls.filter(call => call.url.endsWith('/steps/build/message')).length, 2))
  const withAttachment = calls.filter(call => call.url.endsWith('/steps/build/message'))[1]
  assert.equal(withAttachment.body, JSON.stringify({ content:
    `[report.txt](.workstep/uploads/t${'a'.repeat(24)}-${'b'.repeat(32)}.txt)`,
  }))
})
