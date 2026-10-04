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
    if (url.startsWith('/api/admin/usage/reconciliation?')) return Response.json({ rows: [{
      day: '2026-09-29', provider_id: 'provider-1', model: 'model-a', status: 'different',
      device_event_count: 1, provider_line_count: 1, unmetered_count: 0,
      device_input_tokens: 10, device_output_tokens: 5,
      provider_input_tokens: 12, provider_output_tokens: 5,
      input_tokens_difference: 2, output_tokens_difference: 0,
      estimated_cost: '0.000030', billed_cost: '0.000040',
      cost_difference: '0.000010', currency: 'USD',
    }] })
    if (url.startsWith('/api/admin/usage/events?')) {
      if (detailFailures > 0) { detailFailures--; return new Response(null, { status: 503 }) }
      if (new URLSearchParams(url.split('?')[1]).get('source') === 'provider_reconciled') {
        return Response.json({ total: 1, events: [{
          id: 'bill-1', request_id: 'provider-line-1', source: 'provider_reconciled',
          metering_status: 'metered', occurred_at: '2026-09-29T00:00:00Z',
          user_id: null, initiated_by_user_id: null, device_id: 'provider-bill',
          project_id: null, task_id: null, run_id: null, message_id: null,
          session_id: null, provider_id: 'provider-1', provider_revision: null,
          model: 'model-a', input_tokens: 12, output_tokens: 5,
          cache_read_tokens: null, cache_write_tokens: null, total_tokens: 17,
          pricing_version: null, currency: 'USD', estimated_cost: null,
          billed_cost: '0.000040',
        }] })
      }
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
      estimated_cost: '0.000030', billed_cost: '0.000040', currency: 'USD', group_total: 1,
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
  fireEvent.change(screen.getByLabelText('对账供应商 ID'), { target: { value: 'provider-1' } })
  fireEvent.change(screen.getByLabelText('对账开始日期'), { target: { value: '2026-09-29' } })
  fireEvent.change(screen.getByLabelText('对账结束日期'), { target: { value: '2026-09-29' } })
  fireEvent.click(screen.getByRole('button', { name: '查看账单差异' }))
  await screen.findByText(/model-a · 差异/)
  assert.match(document.body.textContent ?? '', /账单 0.000040 USD/)
  fireEvent.change(screen.getByLabelText('计量来源'), { target: { value: 'provider_reconciled' } })
  fireEvent.click(screen.getByRole('button', { name: '查询用量' }))
  assert.ok((await screen.findAllByText(/账单金额 0.000040 USD/)).length >= 1)
  await screen.findByText(/供应商账单 · 供应商 provider-1/)
})

test('provider bill import requires step-up and submits only bounded billing fields', async () => {
  const requests: Array<{ url: string; body?: Record<string, unknown> }> = []
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (url === '/api/auth/session') return Response.json({ csrf_token: 'csrf-1' })
    if (url === '/api/auth/step-up') return Response.json({ expires_in_seconds: 300 })
    if (url === '/api/admin/usage/provider-bills') return Response.json({
      accepted: ['line-1'], duplicates: [],
    })
    if (url.startsWith('/api/admin/usage/events?')) return Response.json({ events: [], total: 0 })
    if (url.startsWith('/api/admin/usage?')) return Response.json({
      event_count: 0, unmetered_count: 0, input_tokens: null, output_tokens: null,
      cache_read_tokens: null, cache_write_tokens: null, total_tokens: null,
      estimated_cost: null, billed_cost: null, currency: null,
    })
    throw new Error(`Unexpected fetch: ${url}`)
  }
  render(<MemoryRouter><AdminUsagePage /></MemoryRouter>)
  fireEvent.click(screen.getByRole('button', { name: '导入供应商账单' }))
  const dialog = await screen.findByRole('dialog', { name: '导入供应商账单' })
  const { getByLabelText, getByRole } = await import('@testing-library/dom')
  fireEvent.change(getByLabelText(dialog, '供应商 ID'), { target: { value: 'provider-1' } })
  fireEvent.change(getByLabelText(dialog, '账单行 ID'), { target: { value: 'line-1' } })
  fireEvent.change(getByLabelText(dialog, '模型'), { target: { value: 'model-a' } })
  fireEvent.change(getByLabelText(dialog, 'UTC 日期'), { target: { value: '2026-09-29' } })
  fireEvent.change(getByLabelText(dialog, '输入 Token'), { target: { value: '12' } })
  fireEvent.change(getByLabelText(dialog, '输出 Token'), { target: { value: '5' } })
  fireEvent.change(getByLabelText(dialog, '账单金额'), { target: { value: '0.000040' } })
  fireEvent.change(getByLabelText(dialog, '管理员密码'), { target: { value: 'secret' } })
  fireEvent.click(getByRole(dialog, 'button', { name: '导入账单行' }))
  await screen.findByText(/已导入 1 条账单行/)
  assert.deepEqual(requests.filter(item => item.url === '/api/admin/usage/provider-bills')[0].body, {
    batch_id: 'line-1', lines: [{ line_id: 'line-1', provider_id: 'provider-1',
      model: 'model-a', day: '2026-09-29', input_tokens: 12, output_tokens: 5,
      currency: 'USD', billed_cost: '0.000040' }],
  })
  assert.ok(requests.findIndex(item => item.url === '/api/auth/step-up') <
    requests.findIndex(item => item.url === '/api/admin/usage/provider-bills'))
})


test('read-only usage page exposes scoped reports without global bill controls', async () => {
  const paths: string[] = []
  globalThis.fetch = async input => {
    const path = String(input); paths.push(path)
    if (path.startsWith('/api/admin/usage/events?')) return Response.json({ events: [], total: 0 })
    if (path.startsWith('/api/admin/usage?')) return Response.json({ event_count: 0, unmetered_count: 0, input_tokens: null, output_tokens: null, cache_read_tokens: null, cache_write_tokens: null, total_tokens: null, estimated_cost: null, billed_cost: null, currency: null, groups: [], group_total: 0 })
    throw new Error(path)
  }
  render(<MemoryRouter><AdminUsagePage readOnly /></MemoryRouter>)
  await screen.findByText('当前条件下没有计量事件。')
  assert.equal(screen.queryByRole('button', { name: '导入供应商账单' }), null)
  assert.equal(screen.queryByLabelText('对账供应商 ID'), null)
  assert.ok(paths.every(path => !path.includes('/reconciliation')))
})
