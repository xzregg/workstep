import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { JSDOM } from 'jsdom'
import { MemoryRouter } from 'react-router-dom'
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
