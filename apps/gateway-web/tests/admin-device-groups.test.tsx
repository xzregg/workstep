import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JSDOM } from 'jsdom'
import { AdminDeviceGroupsPage } from '../src/AdminDeviceGroupsPage'
const dom = new JSDOM('<html><body></body></html>', { url: 'https://gateway.test/admin/device-groups' })
Object.assign(globalThis, { window: dom.window, document: dom.window.document,
  HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver, Event: dom.window.Event })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
const { cleanup, fireEvent, render, screen, waitFor } = await import('@testing-library/react')

test('creating an empty device group does not request a password proof', async () => {
 const original = globalThis.fetch
 const posts: string[] = []
 globalThis.fetch = async (input, init) => {
  const path = String(input)
  if (init?.method === 'POST') {
   posts.push(path)
   assert.equal(path, '/api/admin/device-groups')
   return Response.json({ id: 'new' }, { status: 201 })
  }
  return Response.json({ csrf_token: 'csrf', groups: [], devices: [], departments: [] })
 }
 try {
  render(<AdminDeviceGroupsPage />)
  await waitFor(() => assert.equal((screen.getByLabelText('新设备组名称') as HTMLInputElement).disabled, false))
  fireEvent.change(screen.getByLabelText('新设备组名称'), { target: { value: '新组' } })
  await waitFor(() => assert.equal((screen.getByRole('button', { name: '创建设备组' }) as HTMLButtonElement).disabled, false))
  fireEvent.click(screen.getByRole('button', { name: '创建设备组' }))
  await screen.findByText('设备组已创建。')
  assert.deepEqual(posts, ['/api/admin/device-groups'])
 } finally { cleanup(); globalThis.fetch = original }
})

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
    await screen.findByRole('option', { name: 'Test PCs' , hidden: true})
    fireEvent.change(screen.getByLabelText('设备组'), { target: { value: 'g1' } })
    fireEvent.change(screen.getByLabelText('设备'), { target: { value: 'd1' } })
  fireEvent.click(screen.getByRole('tab', { name: '部门归属' }))
  assert.equal(screen.queryByRole('button', { name: '加入设备组' }), null)
  assert.ok(screen.getByRole('button', { name: '保存部门归属' }))
  fireEvent.click(screen.getByRole('tab', { name: '设备组管理' }))
  assert.equal((screen.getByLabelText('设备组') as HTMLSelectElement).value, 'g1')
  assert.equal((screen.getByLabelText('设备') as HTMLSelectElement).value, 'd1')
    const submit = screen.getByRole('button', { name: '加入设备组' }) as HTMLButtonElement
    assert.equal(submit.disabled, true)
    assert.equal(screen.getByLabelText('输入你的密码确认').closest('.gateway-dialog-actions'), submit.closest('.gateway-dialog-actions'))
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
