import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { AccountPage, validPasswordChange } from '../src/AccountPage'
import { App } from '../src/App'

test('account page validates a new distinct password and confirmation', () => {
  assert.equal(validPasswordChange('current-password', 'replacement-password', 'replacement-password'), true)
  assert.equal(validPasswordChange('current-password', 'short', 'short'), false)
  assert.equal(validPasswordChange('same-password', 'same-password', 'same-password'), false)
  assert.equal(validPasswordChange('current-password', 'replacement-password', 'different-password'), false)
})

test('account area is present in the Gateway workbench', () => {
  const html = renderToString(<MemoryRouter initialEntries={['/account']}><App /></MemoryRouter>)
  assert.match(html, /个人账户/)
  assert.match(renderToString(<MemoryRouter><AccountPage /></MemoryRouter>), /正在检查登录状态/)
})
