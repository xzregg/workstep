import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { PortalAuthPage, validPortalAccount, safeNextPath } from '../src/PortalAuthPage'

test('portal account validation follows the Gateway schema', () => {
  assert.equal(validPortalAccount('alice', 'Alice', 'long-password-123'), true)
  assert.equal(validPortalAccount('A lice', 'Alice', 'long-password-123'), false)
  assert.equal(validPortalAccount('alice', ' ', 'long-password-123'), false)
  assert.equal(validPortalAccount('alice', 'Alice', 'short'), false)
})

test('login return path stays on this Gateway', () => {
  assert.equal(safeNextPath('/devices'), '/devices')
  assert.equal(safeNextPath('//evil.example'), '/')
  assert.equal(safeNextPath('https://evil.example'), '/')
  assert.equal(safeNextPath('/desktop/login?state=x'), '/desktop/login?state=x')
})

test('portal auth page starts with a loading state', () => {
  const html = renderToString(<MemoryRouter><PortalAuthPage /></MemoryRouter>)
  assert.match(html, /正在检查平台状态/)
})
