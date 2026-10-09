import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import { AdminDeviceGroupsPage } from '../src/AdminDeviceGroupsPage'
const dom = new JSDOM('<html><body></body></html>', { url: 'https://gateway.test/admin/device-groups' })
Object.assign(globalThis, { window: dom.window, document: dom.window.document,
  HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver, Event: dom.window.Event })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')

test('device group membership requires password and preserves a failed operation for retry', async () => {
  const oldFetch = globalThis.fetch
  const mutations: Array<{ path: string; init?: RequestInit }> = []
  let fail = true
  globalThis.fetch = async (input, init) => {
    const path = String(input)
    if (path === '/api/auth/session') return Response.json({ csrf_token: 'csrf' })
    if (path.startsWith('/api/admin/device-groups?')) return Response.json({ groups: [{ id: 'g1', name: 'Test PCs', device_ids: [] }] })
    if (path.startsWith('/api/admin/devices?')) return Response.json({ devices: [{ id: 'd1', name: 'Test PC' }] })
    if (path.startsWith('/api/admin/departments?')) return Response.json({ departments: [] })
    mutations.push({ path, init })
    if (path === '/api/auth/step-up') return Response.json({})
    if (path === '/api/admin/device-groups/g1/devices/d1') {
      if (fail) { fail = false; return new Response(null, { status: 503 }) }
      return new Response(null, { status: 204 })
    }
    throw new Error(path)
  }
  try {
    render(<AdminDeviceGroupsPage />)
    await screen.findByRole('option', { name: 'Test PCs' })
    fireEvent.change(screen.getByLabelText('设备组'), { target: { value: 'g1' } })
    fireEvent.change(screen.getByLabelText('设备'), { target: { value: 'd1' } })
    const submit = screen.getByRole('button', { name: '加入设备组' }) as HTMLButtonElement
    assert.equal(submit.disabled, true)
    const remove = screen.getByRole('button', { name: '移出设备组' }) as HTMLButtonElement
    assert.equal(remove.disabled, true)
    fireEvent.change(screen.getByLabelText('输入你的密码确认'), { target: { value: 'password-123' } })
    assert.equal(remove.disabled, true)
    fireEvent.click(submit)
    await screen.findByRole('alert')
    assert.equal((screen.getByLabelText('设备组') as HTMLSelectElement).value, 'g1')
    fireEvent.click(submit)
    await waitFor(() => assert.equal(mutations.filter(item => item.path.includes('/devices/d1')).length, 2))
    assert.equal(mutations.at(-1)?.init?.method, 'PUT')
    assert.equal((mutations.at(-1)?.init?.headers as Record<string, string>)['X-CSRF-Token'], 'csrf')
  } finally { cleanup(); globalThis.fetch = oldFetch }
})
