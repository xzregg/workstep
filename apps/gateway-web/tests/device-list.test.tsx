import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { App } from '../src/App'

test('assigned PC portal has a dedicated route', () => {
  const html = renderToString(<MemoryRouter initialEntries={['/devices']}><App /></MemoryRouter>)
  assert.match(html, /我的电脑/)
  assert.match(html, /登录/)
})
