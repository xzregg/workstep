import assert from 'node:assert/strict'
import { test, afterEach } from 'node:test'
import { JSDOM } from 'jsdom'
import { useState } from 'react'
import Select from '../src/GatewaySelect'
import { GatewayModal } from '../src/GatewayModal'
import { PermissionPicker } from '../src/PermissionPicker'
const dom = new JSDOM('<html><body></body></html>', { url: 'https://gateway.test' })
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
const { cleanup, render, screen, fireEvent, waitFor } = await import('@testing-library/react')
const originalFetch = globalThis.fetch
afterEach(() => { cleanup(); globalThis.fetch = originalFetch })

test('shared dropdown filters names, skips disabled options and emits the native form change once', () => {
 const changes: string[] = []
 render(<><label htmlFor="device">设备</label><Select id="device" defaultValue="a" onChange={event => changes.push(event.target.value)}>
  <option value="a">Alpha</option><option value="b" disabled>Beta</option><option value="c">Charlie</option>
 </Select></>)
 const trigger = screen.getByRole('combobox', { name: '选择 设备' })
 fireEvent.click(trigger)
 const search = screen.getByRole('combobox', { name: '搜索选项 · 设备' })
 fireEvent.change(search, { target: { value: 'CHAR' } })
 assert.equal(screen.queryByRole('option', { name: 'Alpha' }), null)
 fireEvent.keyDown(search, { key: 'Enter' })
 assert.deepEqual(changes, ['c'])
 assert.equal(screen.queryByRole('listbox'), null)
 assert.equal(document.activeElement, trigger)
 fireEvent.click(trigger)
 fireEvent.change(screen.getByRole('combobox', { name: '搜索选项 · 设备' }), { target: { value: 'missing' } })
 assert.ok(screen.getByText('没有匹配的选项'))
 fireEvent.change(screen.getByRole('combobox', { name: '搜索选项 · 设备' }), { target: { value: '' } })
 fireEvent.keyDown(screen.getByRole('combobox', { name: '搜索选项 · 设备' }), { key: 'Home' })
 fireEvent.click(screen.getByRole('option', { name: 'Beta' }))
 assert.deepEqual(changes, ['c'])
})

test('a dropdown inside a modal uses the top layer and Escape leaves the parent open', () => {
 let closed = 0, shown = 0
 const prototype = dom.window.HTMLElement.prototype
 Object.defineProperty(prototype, 'showPopover', { configurable: true, value() { shown++ } })
 Object.defineProperty(prototype, 'hidePopover', { configurable: true, value() {} })
 try {
 render(<GatewayModal title="授权" onClose={() => closed++} footer={<button>保存</button>}>
  <label htmlFor="scope">资源</label><Select id="scope"><option value="p">项目</option><option value="d">设备</option></Select>
 </GatewayModal>)
 fireEvent.click(screen.getByRole('combobox', { name: '选择 资源' }))
 assert.equal(shown, 1)
 assert.ok(screen.getByRole('listbox').closest('dialog'))
 fireEvent.keyDown(screen.getByRole('combobox', { name: '搜索选项 · 资源' }), { key: 'Escape' })
 assert.equal(closed, 0)
 assert.equal(screen.queryByRole('listbox'), null)
 assert.ok(screen.getByRole('dialog', { name: '授权' }))
 } finally { cleanup(); Reflect.deleteProperty(prototype, 'showPopover'); Reflect.deleteProperty(prototype, 'hidePopover') }
})

test('authorized resources search the server from the popup and return selected value and name', async () => {
 const urls: string[] = [], changes: string[] = [], names: string[] = []
 globalThis.fetch = async input => {
  const url = String(input); urls.push(url)
  return Response.json({ resources: new URL(url, 'https://gateway.test').searchParams.get('q') === '沙箱'
   ? [{ id: 'sandbox', name: '测试机（沙箱）' }] : [{ id: 'host', name: '宿主机' }], total: 1 })
 }
 function Picker() {
  const [value, setValue] = useState('')
  return <PermissionPicker kind="resource" targetType="device" label="授权资源" value={value}
   onChange={next => { setValue(next); changes.push(next) }} onNameChange={name => names.push(name)} />
 }
 render(<Picker />)
 await screen.findByRole('option', { name: '宿主机', hidden: true })
 fireEvent.click(screen.getByRole('combobox', { name: '选择 授权资源' }))
 fireEvent.change(screen.getByRole('combobox', { name: '搜索选项 · 授权资源' }), { target: { value: '沙箱' } })
 fireEvent.click(await screen.findByRole('option', { name: '测试机（沙箱）' }))
 assert.deepEqual(changes, ['sandbox'])
 assert.deepEqual(names, ['测试机（沙箱）'])
 assert.ok(urls.some(url => new URL(url, 'https://gateway.test').searchParams.get('q') === '沙箱'))
 assert.equal(screen.queryByRole('button', { name: '搜索' }), null)
 assert.ok(screen.getByRole('combobox', { name: '选择 授权资源' }).textContent?.includes('测试机（沙箱）'))
})

test('switching resource scope clears cached choices from the previous scope', async () => {
 globalThis.fetch = async input => Response.json({ resources: String(input).includes('scope_type=device')
  ? [{ id: 'device-a', name: '设备甲' }] : [{ id: 'project-a', name: '项目甲' }], total: 1 })
 const { rerender } = render(<PermissionPicker kind="resource" targetType="device" label="授权资源" value="" onChange={() => {}} />)
 await screen.findByRole('option', { name: '设备甲', hidden: true })
 fireEvent.click(screen.getByRole('combobox', { name: '选择 授权资源' }))
 fireEvent.click(screen.getByRole('option', { name: '设备甲' }))
 rerender(<PermissionPicker kind="resource" targetType="project" label="授权资源" value="" onChange={() => {}} />)
 await screen.findByRole('option', { name: '项目甲', hidden: true })
 assert.ok(!screen.queryByRole('option', { name: '设备甲', hidden: true }), 'previous resource scope must not remain selectable')
})
