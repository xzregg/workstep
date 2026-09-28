import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { App } from '../src/App'

test('portal and admin route have separate entry points', () => {
  const portal = renderToString(<MemoryRouter initialEntries={['/']}><App /></MemoryRouter>)
  const admin = renderToString(<MemoryRouter initialEntries={['/admin']}><App /></MemoryRouter>)
  assert.match(portal, /工作台/)
  assert.match(admin, /管理后台/)
  assert.match(admin, /平台服务正在建设中/)
})
