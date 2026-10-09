import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { JSDOM } from 'jsdom'
import { AdminDeviceNameDialog } from '../src/AdminDeviceNameDialog'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://gateway.test/admin/devices' })
Object.assign(globalThis, { window: dom.window, document: dom.window.document,
  HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver, Event: dom.window.Event })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
const { cleanup, fireEvent, render, screen, within, waitFor } = await import('@testing-library/react')
const originalFetch = globalThis.fetch
afterEach(() => { cleanup(); globalThis.fetch = originalFetch })
const device = { id: 'pc-1', name: '93a1f068d205', status: 'revoked', online: false, version: '1.0.9', app_instance_id: null }

test('device name validates, preserves edits on failure, and saves without changing device ID', async () => {
  let fail = true, saved = 0, closed = 0
  const writes: RequestInit[] = []
  globalThis.fetch = async (input, init) => {
    if (String(input) === '/api/auth/step-up') return new Response(null, { status: 200 })
    assert.equal(String(input), '/api/admin/devices/pc-1/name')
    writes.push(init!)
    return new Response(null, { status: fail ? 503 : 204 })
  }
  render(<AdminDeviceNameDialog device={device} csrf="csrf" onComplete={() => saved++} onClose={() => closed++} />)
  const name = screen.getByLabelText('设备名称')
  fireEvent.change(name, { target: { value: '   ' } })
  fireEvent.change(screen.getByLabelText('输入管理员密码确认'), { target: { value: 'test-password' } })
  assert.equal((screen.getByRole('button', { name: '保存名称' }) as HTMLButtonElement).disabled, true)
  fireEvent.change(name, { target: { value: ' 钊荣的工作电脑 ' } })
  fireEvent.click(screen.getByRole('button', { name: '保存名称' }))
  await screen.findByRole('alert')
  assert.equal((name as HTMLInputElement).value, ' 钊荣的工作电脑 ')
  fireEvent.click(screen.getByRole('button', { name: '取消' }))
  assert.equal(closed, 0)
  fireEvent.click(within(screen.getByRole('dialog', { name: '放弃修改设备名称' })).getByRole('button', { name: '继续编辑' }))
  fail = false
  fireEvent.click(screen.getByRole('button', { name: '保存名称' }))
  await waitFor(() => assert.equal(saved, 1))
  assert.deepEqual(JSON.parse(String(writes[1].body)), { name: '钊荣的工作电脑' })
  assert.equal(writes[1].method, 'PUT')
  assert.match(screen.getByText(/设备 ID：/).textContent ?? '', /pc-1/)
})
