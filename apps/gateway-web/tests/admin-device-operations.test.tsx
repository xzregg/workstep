import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { JSDOM } from 'jsdom'
import { MemoryRouter } from 'react-router-dom'
import { AdminDeviceOperationsPage } from '../src/AdminDeviceOperationsPage'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://gateway.test/admin/device-operations' })
Object.assign(globalThis, { window: dom.window, document: dom.window.document,
  HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver,
  Event: dom.window.Event })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
const { cleanup, fireEvent, render, screen, waitFor, within } = await import('@testing-library/react')
const originalFetch = globalThis.fetch
afterEach(() => { cleanup(); globalThis.fetch = originalFetch })

test('device operation freezes selected targets and retries only failed commands', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  let created = false
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    requests.push({ url, init })
    if (url === '/api/auth/session') return Response.json({ csrf_token: 'csrf' })
    if (url.startsWith('/api/admin/devices?')) {
      const page = new URL(url, 'https://gateway.test').searchParams.get('page')
      return Response.json({ devices: [{ id: page === '1' ? 'pc-1' : 'pc-2',
        name: page === '1' ? 'PC One' : 'PC Two', online: true, version: '1.0' }], total: 26 })
    }
    if (url.startsWith('/api/admin/device-operations?')) return Response.json({ batches: created ? [{
      id: 'batch-1', action: 'install', engine_id: 'codex', version: '1.2.3',
      max_concurrency: 2, status: 'finished', created_at: '2026-01-01T00:00:00Z', commands: [
        { id: 'cmd-1', device_id: 'pc-1', status: 'failed', error: 'install_failed', expires_at: '2026-01-01' },
        { id: 'cmd-2', device_id: 'pc-2', status: 'succeeded', error: null, expires_at: '2026-01-01' },
      ],
    }] : [], total: created ? 1 : 0 })
    if (url === '/api/auth/step-up') return new Response(null, { status: 200 })
    if (url === '/api/admin/device-operations') { created = true; return Response.json({ id: 'batch-1' }) }
    if (url === '/api/admin/device-operations/batch-1/retry-failed') return Response.json({ id: 'batch-2' })
    throw new Error(`Unexpected fetch: ${url}`)
  }
  render(<MemoryRouter><AdminDeviceOperationsPage /></MemoryRouter>)
  await screen.findByText(/PC One/)
  const create = screen.getByRole('heading', { name: '创建批量作业' }).closest('section')!
  fireEvent.click(screen.getByLabelText(/PC One/))
  fireEvent.click(within(create).getByRole('button', { name: '下一页' }))
  await screen.findByText(/PC Two/)
  fireEvent.click(screen.getByLabelText(/PC Two/))
  fireEvent.change(screen.getByLabelText('引擎 ID'), { target: { value: 'codex' } })
  fireEvent.change(screen.getByLabelText('确切版本'), { target: { value: '1.2.3' } })
  fireEvent.change(screen.getByLabelText('并发数'), { target: { value: '2' } })
  fireEvent.click(screen.getByLabelText(/已在引擎发行方查看并接受/))
  fireEvent.click(screen.getByRole('button', { name: '核对并创建作业' }))
  const dialog = screen.getByRole('dialog', { name: '确认批量作业' })
  assert.match(dialog.textContent ?? '', /目标 2 台/)
  assert.match(dialog.textContent ?? '', /PC One、PC Two/)
  fireEvent.change(within(dialog).getByLabelText('输入管理员密码确认'), { target: { value: 'password' } })
  fireEvent.click(within(dialog).getByRole('button', { name: '创建作业' }))
  await screen.findByText(/pc-1 · 失败/)
  const posted = requests.find(request => request.url === '/api/admin/device-operations' && request.init?.method === 'POST')
  assert.ok(posted)
  assert.deepEqual(JSON.parse(String(posted.init?.body)).device_ids, ['pc-1', 'pc-2'])
  assert.equal(JSON.parse(String(posted.init?.body)).version, '1.2.3')
  fireEvent.click(screen.getByRole('button', { name: '只重试失败项' }))
  const retry = screen.getByRole('dialog', { name: '重试失败设备' })
  assert.match(retry.textContent ?? '', /共 1 台/)
  fireEvent.change(within(retry).getByLabelText('输入管理员密码确认'), { target: { value: 'password' } })
  fireEvent.click(within(retry).getByRole('button', { name: '创建重试作业' }))
  await waitFor(() => assert.ok(requests.some(request => request.url.endsWith('/retry-failed'))))
})
