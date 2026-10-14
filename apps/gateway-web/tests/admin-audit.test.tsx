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
  Event: dom.window.Event, getComputedStyle: dom.window.getComputedStyle,
  SVGElement: dom.window.SVGElement, Element: dom.window.Element, ShadowRoot: dom.window.ShadowRoot })
dom.window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false }, media: '', onchange: null })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
const { cleanup, fireEvent, render, screen, waitFor, configure } = await import('@testing-library/react')
configure({ asyncUtilTimeout: 5000 })
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
  await screen.findByRole('cell',{name:'task.start'})
  assert.ok(screen.getByRole('columnheader',{name:'操作人'}))
  assert.ok(screen.getByRole('columnheader',{name:'用户名'}))
  assert.ok(screen.getByRole('cell',{name:'alice'}))
  fireEvent.click(screen.getByRole('button',{name:'审计详情 audit-1'}))
  assert.match(document.body.textContent ?? '', /流程运行 run-1/)
  assert.match(document.body.textContent ?? '', /宿主项目 host-project-1/)
  fireEvent.click(screen.getByRole('button',{name:'完成'}))
  fireEvent.click(await screen.findByPlaceholderText('开始时间'))
  fireEvent.click(await screen.findByText('最近 7 天'))
  fireEvent.change(screen.getByLabelText('用户 ID'), { target: { value: 'user-1' } })
  fireEvent.change(screen.getByLabelText('关键词'), { target: { value: 'task-1' } })
  fireEvent.click(screen.getByRole('button', { name: '查询审计' }))
  await waitFor(() => assert.ok(urls.some(url => url.includes('user_id=user-1')
    && url.includes('q=task-1') && url.includes('from_time='))))
  fireEvent.click(screen.getByRole('button', { name: '下一页' }))
  await screen.findByRole('button',{name:'审计详情 audit-26'})
  fireEvent.click(screen.getByRole('button',{name:'审计详情 audit-26'}))
  await screen.findByText(/事件 audit-26/)
  assert.ok(urls.some(url => url.includes('offset=25')))
})

for (const [method, label] of [['password', '账号密码'], ['dingtalk', '钉钉'], ['wecom', '企业微信']]) {
  test(`audit table shows ${label} desktop login with user, device and result`, async () => {
    globalThis.fetch = async () => Response.json({ total: 1, items: [{
      id: 'login-1', occurred_at: '2026-10-14T09:00:00Z', action: 'auth.desktop.login', result: 'success',
      actor_id: 'user-1', actor_name: '张三', actor_username: 'alice', device_id: 'pc-1',
      metadata: { login_method: method, device_name: '研发电脑', device_status: 'active' },
    }] })
    render(<MemoryRouter><AdminAuditPage /></MemoryRouter>)
    await screen.findByRole('cell', { name: '设备授权登录' })
    assert.ok(screen.getByRole('columnheader', { name: '登录方式' }))
    assert.ok(screen.getByRole('columnheader', { name: '设备' }))
    assert.ok(screen.getByRole('cell', { name: label }))
    assert.ok(screen.getByRole('cell', { name: '张三' }))
    assert.ok(screen.getByRole('cell', { name: '研发电脑' }))
    assert.ok(screen.getByRole('cell', { name: '成功' }))
  })
}

test('audit distinguishes pending device approval and unauthenticated password attempts', async () => {
  const urls: string[] = []
  globalThis.fetch = async input => {
    urls.push(String(input))
    return Response.json({ total: 2, items: [
      { id: 'pending', occurred_at: '2026-10-14T09:00:00Z', action: 'auth.desktop.login', result: 'denied',
        actor_name: '张三', device_id: 'pc-1', metadata: { login_method: 'dingtalk', device_name: '待审批电脑', reason_code: 'device_pending' } },
      { id: 'failed', occurred_at: '2026-10-14T09:00:00Z', action: 'auth.login', result: 'failed',
        actor_type: 'anonymous', actor_username: 'alice', metadata: { login_method: 'password' } },
    ] })
  }
  render(<MemoryRouter><AdminAuditPage /></MemoryRouter>)
  await screen.findByRole('cell', { name: '待设备审批' })
  assert.ok(screen.getByRole('cell', { name: '未认证（尝试账号：alice）' }))
  fireEvent.change(screen.getByLabelText('设备 ID'), { target: { value: 'pc-1' } })
  fireEvent.click(screen.getByRole('button', { name: '查询审计' }))
  await waitFor(() => assert.ok(urls.some(url => url.includes('device_id=pc-1'))))
})
