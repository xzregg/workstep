import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { JSDOM } from 'jsdom'
import { MemoryRouter } from 'react-router-dom'
import { AdminAuditPage } from '../src/AdminAuditPage'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://gateway.test/admin/audit',
})
Object.assign(globalThis, { window: dom.window, document: dom.window.document,
  HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver,
  Event: dom.window.Event })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')
const originalFetch = globalThis.fetch
afterEach(() => { cleanup(); globalThis.fetch = originalFetch })

test('audit workbench filters, retries, pages, and shows redacted event detail', async () => {
  const urls: string[] = []
  let failures = 1
  globalThis.fetch = async input => {
    const url = String(input)
    urls.push(url)
    if (failures-- > 0) return new Response(null, { status: 503 })
    const offset = Number(new URLSearchParams(url.split('?')[1]).get('offset'))
    return Response.json({ total: 26, items: [{
      id: offset ? 'audit-26' : 'audit-1', occurred_at: '2026-09-29T09:00:00Z',
      action: 'task.start', result: 'succeeded', actor_id: 'user-1',
      actor_username: 'alice', actor_name: 'Alice', actor_type: 'user',
      actor_device_id: 'browser-1', actor_device_name: 'Chrome', device_id: 'pc-1',
      mode: 'managed', initiated_by_user_id: 'user-1', initiated_by_username: 'alice',
      project_id: 'host-project-1', platform_project_id: 'project-1',
      project_name: 'Published', task_id: 'task-1',
      metadata: { step_key: 'build', workflow_run_id: 'run-1' },
    }] })
  }
  render(<MemoryRouter><AdminAuditPage /></MemoryRouter>)
  await screen.findByText(/审计记录加载失败/)
  fireEvent.click(screen.getByRole('button', { name: '重试' }))
  await screen.findByText('task.start')
  fireEvent.click(screen.getByText('审计详情'))
  assert.match(document.body.textContent ?? '', /流程运行 run-1/)
  assert.match(document.body.textContent ?? '', /宿主项目 host-project-1/)
  fireEvent.change(screen.getByLabelText('开始时间'), { target: { value: '2026-09-30T10:00' } })
  fireEvent.change(screen.getByLabelText('结束时间'), { target: { value: '2026-09-29T10:00' } })
  fireEvent.click(screen.getByRole('button', { name: '查询审计' }))
  assert.match(screen.getByRole('alert').textContent ?? '', /结束时间必须晚于开始时间/)
  fireEvent.change(screen.getByLabelText('开始时间'), { target: { value: '2026-09-28T10:00' } })
  fireEvent.change(screen.getByLabelText('用户 ID'), { target: { value: 'user-1' } })
  fireEvent.change(screen.getByLabelText('关键词'), { target: { value: 'task-1' } })
  fireEvent.click(screen.getByRole('button', { name: '查询审计' }))
  await waitFor(() => assert.ok(urls.some(url => url.includes('user_id=user-1')
    && url.includes('q=task-1') && url.includes('from_time='))))
  fireEvent.click(screen.getByRole('button', { name: '下一页' }))
  await screen.findByText(/事件 audit-26/)
  assert.ok(urls.some(url => url.includes('offset=25')))
})
