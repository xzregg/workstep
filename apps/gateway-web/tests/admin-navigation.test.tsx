import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { JSDOM } from 'jsdom'
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom'
import { AdminAccessGate, useAdminAccess } from '../src/AdminAccessGate'
import { AdminLayout } from '../src/AdminLayout'
import { AdminNavigation } from '../src/AdminNavigation'

const dom = new JSDOM('<html><body></body></html>', { url: 'http://localhost/admin/users' })
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver, Event: dom.window.Event })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
// JSDOM lacks native modal dialogs; preserve their open/close events for our controller tests.
dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true }
dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new dom.window.Event('close')) }
const { render, screen, fireEvent, within, waitFor, cleanup } = await import('@testing-library/react')
afterEach(cleanup)

test('expanded categories survive navigation permission refresh and can still be collapsed manually', async () => {
 const view = render(<MemoryRouter><AdminNavigation roles={['super_admin']} /></MemoryRouter>)
 const group = screen.getByText('用户与权限').closest('details')!
 group.open = true
 fireEvent(group, new dom.window.Event('toggle'))
 await waitFor(() => assert.equal(group.open, true))
 fireEvent.click(screen.getByRole('link', { name: '用户管理' }))
 view.rerender(<MemoryRouter><AdminNavigation roles={[]} /></MemoryRouter>)
 assert.equal(screen.queryByText('用户与权限'), null)
 view.rerender(<MemoryRouter><AdminNavigation roles={['super_admin']} /></MemoryRouter>)
 const restored = screen.getByText('用户与权限').closest('details')!
 assert.equal(restored.open, true)
 assert.equal(screen.getByRole('link', { name: '用户管理' }).getAttribute('aria-current'), 'page')
 restored.open = false
 fireEvent(restored, new dom.window.Event('toggle'))
 view.rerender(<MemoryRouter><AdminNavigation roles={[]} /></MemoryRouter>)
 view.rerender(<MemoryRouter><AdminNavigation roles={['super_admin']} /></MemoryRouter>)
 assert.equal(screen.getByText('用户与权限').closest('details')!.open, false)
})

test('mobile menu opens collapsed, follows a destination and closes without losing page content', async () => {
 render(<MemoryRouter initialEntries={['/admin/users']}><AdminLayout roles={['super_admin']}><p>用户表格</p></AdminLayout></MemoryRouter>)
 const trigger = screen.getByRole('button', { name: '打开管理菜单' })
 assert.equal(trigger.getAttribute('aria-expanded'), 'false')
 assert.equal(screen.queryByRole('dialog'), null)
 fireEvent.click(trigger)
 const dialog = screen.getByRole('dialog', { name: '移动端管理菜单' })
 assert.equal(trigger.getAttribute('aria-expanded'), 'true')
 const group = within(dialog).getByText('系统设置').closest('details')!
 assert.equal(group.open, false)
 fireEvent.click(within(dialog).getByText('系统设置'))
 await waitFor(() => assert.equal(group.open, true))
 fireEvent.click(within(dialog).getByRole('link', { name: '平台设置' }))
 await waitFor(() => assert.equal(trigger.getAttribute('aria-expanded'), 'false'))
 assert.equal(screen.queryByRole('dialog'), null)
 assert.equal(document.querySelector('.gateway-admin-breadcrumb strong')?.textContent, '平台设置')
 assert.ok(screen.getByText('用户表格'))
})

test('native dismissal and the close button restore the collapsed mobile trigger', async () => {
 render(<MemoryRouter><AdminLayout roles={['audit_admin']}><p>审计表格</p></AdminLayout></MemoryRouter>)
 const trigger = screen.getByRole('button', { name: '打开管理菜单' })
 fireEvent.click(trigger)
 const dialog = screen.getByRole('dialog', { name: '移动端管理菜单' }) as HTMLDialogElement
 assert.equal(within(dialog).queryByText('用户与权限'), null)
 dialog.close()
 await waitFor(() => assert.equal(trigger.getAttribute('aria-expanded'), 'false'))
 fireEvent.click(trigger)
 fireEvent.click(screen.getByRole('button', { name: '关闭管理菜单' }))
 await waitFor(() => assert.equal(trigger.getAttribute('aria-expanded'), 'false'))
 assert.equal(screen.queryByRole('dialog'), null)
})

test('the brand returns to overview and closes the mobile menu', async () => {
 render(<MemoryRouter initialEntries={['/admin/users']}><AdminLayout roles={['super_admin']}><p>表格</p></AdminLayout></MemoryRouter>)
 const trigger = screen.getByRole('button', { name: '打开管理菜单' })
 fireEvent.click(trigger)
 const dialog = screen.getByRole('dialog', { name: '移动端管理菜单' })
 fireEvent.click(within(dialog).getByRole('link', { name: /WORKSTEP/ }))
 await waitFor(() => assert.equal(trigger.getAttribute('aria-expanded'), 'false'))
 assert.equal(document.querySelector('.gateway-admin-breadcrumb strong')?.textContent, '管理概览')
})

 test('resource and platform permission links belong to separate navigation sections', () => {
 render(<MemoryRouter><AdminNavigation roles={['super_admin']} /></MemoryRouter>)
 const users = screen.getByText('用户与权限').closest('details')!
 const system = screen.getByText('系统设置').closest('details')!
 assert.equal(within(users).getByText('用户与用户组权限').getAttribute('href'), '/admin/permissions')
 assert.equal(within(system).getByText('网关平台权限').getAttribute('href'), '/admin/platform-permissions')
 assert.equal(within(users).queryByText('网关平台权限'), null)
 assert.equal(within(system).queryByText('用户与用户组权限'), null)
 })

test('direct entry expands the current category so the active destination is visible', () => {
 render(<MemoryRouter initialEntries={['/admin/devices?health=unhealthy']}><AdminNavigation roles={['super_admin']} /></MemoryRouter>)
 assert.equal(screen.getByText('设备管理', { selector: 'summary' }).closest('details')!.open, true)
 assert.equal(screen.getByRole('link', { name: '设备管理' }).getAttribute('aria-current'), 'page')
 assert.equal(screen.getByText('用户与权限').closest('details')!.open, false)
})

function NavigationHarness() {
 const state = useAdminAccess()
 return <AdminLayout roles={state.access?.roles ?? []}>
  <Link to="/account">离开管理页</Link>
  <Routes>
   <Route path="/admin/users" element={<AdminAccessGate state={state}><p>用户内容</p></AdminAccessGate>} />
   <Route path="/admin/devices" element={<AdminAccessGate state={state}><p>设备内容</p></AdminAccessGate>} />
   <Route path="/account" element={<Link to="/admin/users">返回管理页</Link>} />
  </Routes>
 </AdminLayout>
}

test('admin navigation preserves menu nodes and permissions while updating only page content', async () => {
 const originalFetch = globalThis.fetch
 let requests = 0
 let roles = ['super_admin']
 globalThis.fetch = async () => { requests++; return Response.json({ roles, must_change_password: false }) }
 try {
  render(<MemoryRouter initialEntries={['/admin/users']}><NavigationHarness /></MemoryRouter>)
  await screen.findByText('用户内容')
  const sidebar = document.querySelector('.gateway-admin-desktop-sidebar')! as HTMLElement
  const group = within(sidebar).getByText('用户与权限').closest('details')!
  const users = within(sidebar).getByRole('link', { name: '用户管理' })
  sidebar.scrollTop = 120
  const mutations: MutationRecord[] = []
  const observer = new MutationObserver(records => mutations.push(...records))
  observer.observe(sidebar, { childList: true, subtree: true })
  try {
   fireEvent.click(within(sidebar).getByText('设备管理', { selector: 'a' }))
   await screen.findByText('设备内容')
   assert.equal(screen.queryByText('用户内容'), null)
   assert.equal(requests, 1)
   assert.equal(within(sidebar).getByText('用户与权限').closest('details'), group)
   assert.equal(within(sidebar).getByRole('link', { name: '用户管理' }), users)
   assert.equal(sidebar.scrollTop, 120)
   assert.equal(mutations.flatMap(record => Array.from(record.removedNodes)).length, 0)
   fireEvent.click(users)
   await screen.findByText('用户内容')
   assert.equal(requests, 1)
  } finally { observer.disconnect() }
  fireEvent.click(screen.getByText('离开管理页'))
  await waitFor(() => assert.equal(requests, 2))
  fireEvent.click(screen.getByText('返回管理页'))
  await screen.findByText('用户内容')
  assert.equal(requests, 3)
  roles = ['identity_admin']
  fireEvent(window, new dom.window.Event('gateway-auth-changed'))
  await screen.findByText('用户内容')
  assert.equal(requests, 4)
  assert.equal(within(sidebar).queryByText('设备管理', { selector: 'a' }), null)
 } finally { globalThis.fetch = originalFetch }
})
