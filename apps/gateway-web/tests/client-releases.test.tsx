import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { App } from '../src/App'
import { hasOnlineDevice } from '../src/ClientDownloadPage'

test('empty device portal offers the shared managed installer', () => {
  const html = renderToString(<MemoryRouter initialEntries={['/devices/empty']}><App /></MemoryRouter>)
  assert.match(html, /安装 WorkStep/)
  assert.match(html, /安装包/)
  assert.match(html, /平台地址/)
  assert.match(html, /我的 WorkStep/)
})

test('installer hands off only after an assigned PC is online', () => {
  assert.equal(hasOnlineDevice([]), false)
  assert.equal(hasOnlineDevice([{ online: false }]), false)
  assert.equal(hasOnlineDevice([{ online: false }, { online: true }]), true)
})
