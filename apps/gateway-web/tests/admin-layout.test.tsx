import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { AdminLayout } from '../src/AdminLayout'

test('administration shows a persistent sidebar and current content', () => {
 const html = renderToString(<MemoryRouter initialEntries={['/admin/users']}><AdminLayout roles={['super_admin']}><table><tbody><tr><td>Alice</td></tr></tbody></table></AdminLayout></MemoryRouter>)
 assert.match(html, /aria-label="管理菜单"/)
 assert.match(html, /aria-current="page"/)
 assert.match(html, /用户管理/)
 assert.match(html, /<summary>用户与权限<\/summary>/)
 assert.match(html, /<summary>设备管理<\/summary>/)
 assert.match(html, /Alice/)
})

test('audit administrator only sees authorized navigation', () => {
 const html = renderToString(<MemoryRouter><AdminLayout roles={['audit_admin']}><p>内容</p></AdminLayout></MemoryRouter>)
 assert.match(html, /审计记录/)
 assert.doesNotMatch(html, /用户管理/)
 assert.doesNotMatch(html, /平台设置/)
})
