import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { App } from '../src/App'
import { buildUserListQuery } from '../src/AdminUsersPage'

test('admin users route is part of the management area', () => {
  const html = renderToString(<MemoryRouter initialEntries={['/admin/users']}><App /></MemoryRouter>)
  assert.match(html, /正在检查管理权限/)
})

test('administrator permissions have a dedicated management route', () => {
  const html = renderToString(<MemoryRouter initialEntries={['/admin/admins']}><App /></MemoryRouter>)
  assert.match(html, /正在检查管理权限/)
})

test('user search and pagination are sent to the server', () => {
  const query = buildUserListQuery({ q: ' 张三 ', status: 'pending', sort: 'username',
    direction: 'asc', page: 3, pageSize: 20 })
  const params = new URLSearchParams(query)
  assert.equal(params.get('q'), '张三')
  assert.equal(params.get('status'), 'pending')
  assert.equal(params.get('page'), '3')
  assert.equal(params.get('page_size'), '20')
})
