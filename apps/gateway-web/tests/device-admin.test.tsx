import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { App } from '../src/App'

test('device approval has its own administrator route', () => {
  const html = renderToString(<MemoryRouter initialEntries={['/admin/devices']}><App /></MemoryRouter>)
  assert.match(html, /设备管理/)
  assert.match(html, /登录/)
})
