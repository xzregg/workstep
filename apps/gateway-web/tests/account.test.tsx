import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToString } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { AccountPage, validPasswordChange } from '../src/AccountPage'
import { App } from '../src/App'
import { validPortalAccount, validPortalPassword } from '../src/portalAccount'

test('account page validates a new distinct password and confirmation', () => {
  assert.equal(validPasswordChange('current-password', '12345678', '12345678'), false)
  assert.equal(validPasswordChange('current-password', '1234567', '1234567'), false)
  assert.equal(validPortalAccount('alice', 'Alice', '12345678'), false)
  assert.equal(validPortalAccount('alice', 'Alice', '1234567'), false)
  assert.equal(validPasswordChange('current-password', 'UniquePassphrase-2026!', 'UniquePassphrase-2026!'), true)
  assert.equal(validPasswordChange('current-password', 'short', 'short'), false)
  assert.equal(validPasswordChange('same-password', 'same-password', 'same-password'), false)
  assert.equal(validPasswordChange('current-password', 'UniquePassphrase-2026!', 'different-password'), false)
  assert.equal(validPasswordChange('', 'UniquePassphrase-2026!', 'UniquePassphrase-2026!', false), true)
  assert.equal(validPasswordChange('', 'UniquePassphrase-2026!', 'UniquePassphrase-2026!'), false)
  assert.equal(validPasswordChange('', 'short', 'short', false), false)
})

test('account area is present in the Gateway workbench', () => {
  const html = renderToString(<MemoryRouter initialEntries={['/account']}><App /></MemoryRouter>)
  assert.match(html, /个人账户/)
  assert.match(renderToString(<MemoryRouter><AccountPage /></MemoryRouter>), /正在检查登录状态/)
})

test('password policy rejects common and account-matching passwords', () => {
  for (const password of ['12345678', 'Password1!', 'Qwerty123!', 'aaaaaaaaA1!']) {
    assert.equal(validPortalPassword('alice', password), false)
  }
  assert.equal(validPortalPassword('owner123!', 'Owner123!'), false)
  assert.equal(validPortalPassword('alice', 'UniquePassphrase-2026!'), true)
})
