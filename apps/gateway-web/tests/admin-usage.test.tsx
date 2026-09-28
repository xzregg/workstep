import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { JSDOM } from 'jsdom'
import { MemoryRouter } from 'react-router-dom'
import { AdminUsagePage } from '../src/AdminUsagePage'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://gateway.test/admin/usage',
})
Object.assign(globalThis, { window: dom.window, document: dom.window.document,
  HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver,
  Event: dom.window.Event })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const originalFetch = globalThis.fetch
afterEach(() => { cleanup(); globalThis.fetch = originalFetch })

test('usage page filters summaries and locates unmetered and metered events', async () => {
  const urls: string[] = []
  let detailFailures = 1
  globalThis.fetch = async input => {
    const url = String(input)
    urls.push(url)
    if (url.startsWith('/api/admin/usage/events?')) {
      if (detailFailures > 0) { detailFailures--; return new Response(null, { status: 503 }) }
      const page = new URLSearchParams(url.split('?')[1]).get('page')
      return Response.json({ total: 26, events: [page === '2' ? {
        id: 'usage-2', request_id: 'request-2', source: 'reported_by_device',
        metering_status: 'metered', occurred_at: '2026-09-29T10:00:00Z',
        user_id: 'user-1', initiated_by_user_id: 'user-1', device_id: 'pc-1',
        project_id: 'project-1', task_id: 'task-1', run_id: null, message_id: 'message-1',
        session_id: null, provider_id: 'provider-1', provider_revision: 2,
        model: 'model-a', input_tokens: 10, output_tokens: 5, cache_read_tokens: 0,
        cache_write_tokens: 0, total_tokens: 15, pricing_version: 'v1',
        currency: 'USD', estimated_cost: '0.000030',
      } : {
        id: 'usage-1', request_id: null, source: 'reported_by_device',
        metering_status: 'unmetered', occurred_at: '2026-09-29T09:00:00Z',
        user_id: 'user-1', initiated_by_user_id: 'user-1', device_id: 'pc-1',
        project_id: null, task_id: null, run_id: null, message_id: null, session_id: null,
        provider_id: null, provider_revision: null, model: 'model-b',
        input_tokens: null, output_tokens: null, cache_read_tokens: null,
        cache_write_tokens: null, total_tokens: null, pricing_version: null,
        currency: null, estimated_cost: null,
      }] })
    }
    if (url.startsWith('/api/admin/usage?')) return Response.json({
      event_count: 26, unmetered_count: 2, input_tokens: 10, output_tokens: 5,
      cache_read_tokens: 0, cache_write_tokens: 0, total_tokens: 15,
      estimated_cost: '0.000030', currency: 'USD', group_total: 1,
      groups: [{ value: 'model-a', event_count: 26, unmetered_count: 2,
        input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0,
        total_tokens: 15, estimated_cost: '0.000030', currency: 'USD' }],
    })
    throw new Error(`Unexpected fetch: ${url}`)
  }
  render(<MemoryRouter><AdminUsagePage /></MemoryRouter>)
  await screen.findByText(/26 条计量事件 · 2 条未完成计量/)
  await screen.findByText(/用量明细加载失败/)
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  await screen.findByText('model-b')
  assert.match(document.body.textContent ?? '', /总 Token 未知 · 估算成本 未完成计量/)
  fireEvent.change(screen.getByLabelText('开始时间'), { target: { value: '2026-09-30T10:00' } })
  fireEvent.change(screen.getByLabelText('结束时间'), { target: { value: '2026-09-29T10:00' } })
  fireEvent.click(screen.getByRole('button', { name: '查询用量' }))
  assert.match(screen.getByRole('alert').textContent ?? '', /结束时间必须晚于开始时间/)
  fireEvent.change(screen.getByLabelText('开始时间'), { target: { value: '2026-09-28T10:00' } })
  fireEvent.change(screen.getByLabelText('计量来源'), { target: { value: 'reported_by_device' } })
  fireEvent.change(screen.getByLabelText('模型'), { target: { value: 'model-a' } })
  fireEvent.click(screen.getByRole('button', { name: '查询用量' }))
  await waitFor(() => assert.ok(urls.some(url => url.includes('source=reported_by_device')
    && url.includes('model=model-a') && url.includes('from_time='))))
  fireEvent.change(screen.getByLabelText('分组维度'), { target: { value: 'model' } })
  await screen.findByText(/共 1 组/)
  fireEvent.click(screen.getAllByRole('button', { name: '下一页' })[1])
  await screen.findByText(/用量事件 usage-2/)
  assert.match(document.body.textContent ?? '', /请求 request-2/)
  assert.ok(urls.some(url => url.includes('/events?') && url.includes('page=2')))
})
