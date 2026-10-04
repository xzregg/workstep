import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { App } from '../src/App'

test('portal and admin route have separate entry points', () => {
  const portal = renderToString(<MemoryRouter initialEntries={['/']}><App /></MemoryRouter>)
  const admin = renderToString(<MemoryRouter initialEntries={['/admin']}><App /></MemoryRouter>)
  assert.match(portal, /我的项目/)
  assert.match(admin, /正在检查管理权限/)
  assert.doesNotMatch(portal, /管理后台/)
})

test('project host renders a project workspace instead of the whole PC portal', () => {
  const project = renderToString(<MemoryRouter initialEntries={['/']}>
    <App deviceHost />
  </MemoryRouter>)
  assert.match(project, /远程项目/)
  assert.doesNotMatch(project, /管理后台/)
  assert.doesNotMatch(project, /我的电脑/)
})
