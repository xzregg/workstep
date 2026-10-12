import assert from 'node:assert/strict'
import { test, afterEach } from 'node:test'
import { JSDOM } from 'jsdom'
import { AdminTabs } from '../src/AdminTabs'
const dom = new JSDOM('<html><body></body></html>', { url: 'https://gateway.test' })
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
const { render, screen, fireEvent, cleanup } = await import('@testing-library/react')
afterEach(cleanup)
test('horizontal tabs expose one panel, support keyboard navigation and retain drafts', () => {
 render(<AdminTabs label="管理功能" items={[
  { id: 'first', label: '基本设置', content: <label>草稿<input defaultValue="" /></label> },
  { id: 'second', label: '高级设置', content: <button>保存高级设置</button> },
 ]} />)
 assert.equal(screen.getAllByRole('tabpanel').length, 1)
 assert.equal(screen.queryByRole('button', { name: '保存高级设置' }), null)
 fireEvent.change(screen.getByLabelText('草稿'), { target: { value: '未保存内容' } })
 const first = screen.getByRole('tab', { name: '基本设置' })
 fireEvent.keyDown(first, { key: 'ArrowRight' })
 assert.equal(screen.getByRole('tab', { name: '高级设置' }).getAttribute('aria-selected'), 'true')
 assert.equal(document.activeElement, screen.getByRole('tab', { name: '高级设置' }))
 assert.ok(screen.getByRole('button', { name: '保存高级设置' }))
 assert.equal(screen.getAllByRole('tabpanel').length, 1)
 fireEvent.keyDown(document.activeElement!, { key: 'Home' })
 assert.equal((screen.getByLabelText('草稿') as HTMLInputElement).value, '未保存内容')
 fireEvent.keyDown(first, { key: 'ArrowLeft' })
 assert.equal(screen.getByRole('tab', { name: '高级设置' }).getAttribute('aria-selected'), 'true')
})
