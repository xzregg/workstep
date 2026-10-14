import assert from 'node:assert/strict'
import { test, afterEach } from 'node:test'
import { JSDOM } from 'jsdom'
import { useState } from 'react'
import { GrantSubjectPicker, type GrantSubject } from '../src/GrantSubjectPicker'
const dom = new JSDOM('<html><body></body></html>', { url: 'https://gateway.test' })
Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, MutationObserver: dom.window.MutationObserver })
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
const { render, screen, fireEvent, cleanup, waitFor } = await import('@testing-library/react')
const oldFetch = globalThis.fetch
afterEach(() => { cleanup(); globalThis.fetch = oldFetch })
function Picker() {
 const [selected, setSelected] = useState<GrantSubject[]>([])
 return <><GrantSubjectPicker subjectType="user" selected={selected} onChange={setSelected} /><p>选择：{selected.map(item => item.name).join('、')}</p></>
}
test('group clicks filter members, member name search keeps selection and returns to all users', async () => {
 const calls: string[] = []
 globalThis.fetch = async input => {
  const url = String(input); calls.push(url)
  if (url.includes('user-groups/tree')) return Response.json({ groups: [{ id: 'group', name: '研发组', parent_id: null, source_type: 'manual', member_count: 1 }] })
  const params = new URL(url, 'https://gateway.test').searchParams
  const members = params.get('q') === '无人' ? [] : params.get('group_id') === 'group' ? [{ id: 'a', name: '张三' }] : [{ id: 'a', name: '张三' }, { id: 'b', name: '李四' }]
  return Response.json({ subjects: members, total: members.length })
 }
 render(<Picker />)
 fireEvent.click(await screen.findByRole('checkbox', { name: '李四' }))
 fireEvent.click(await screen.findByRole('button', { name: '研发组 1' }))
 await waitFor(() => assert.equal(screen.queryByRole('checkbox', { name: '李四' }), null))
 assert.ok(screen.getByText('选择：李四'))
 assert.ok(screen.getByRole('checkbox', { name: '张三' }))
 fireEvent.change(screen.getByLabelText('搜索授权对象'), { target: { value: '无人' } })
 fireEvent.click(screen.getByRole('button', { name: '搜索' }))
 await screen.findByText('没有匹配的用户，请尝试其他关键词。')
 assert.ok(calls.some(url => url.includes('group_id=group') && url.includes('q=')))
 assert.ok(screen.getByText('选择：李四'))
 fireEvent.change(screen.getByLabelText('搜索授权对象'), { target: { value: '' } })
 fireEvent.click(screen.getByRole('button', { name: '搜索' }))
 await screen.findByRole('checkbox', { name: '张三' })
 fireEvent.click(screen.getByRole('button', { name: '全部用户' }))
 assert.equal((await screen.findByRole('checkbox', { name: '李四' }) as HTMLInputElement).checked, true)
})
