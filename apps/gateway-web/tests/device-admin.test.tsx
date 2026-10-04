import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { App } from '../src/App'

test('device approval has its own administrator route', () => {
  const html = renderToString(<MemoryRouter initialEntries={['/admin/devices']}><App /></MemoryRouter>)
  assert.match(html, /正在检查管理权限/)
})
