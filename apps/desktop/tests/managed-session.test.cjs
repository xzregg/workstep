const assert = require('node:assert/strict')
const test = require('node:test')
const { managedSessionExpired } = require('../src/managed-session.cjs')

test('only marked 401 responses from loopback API request session recovery', () => {
  const root = 'http://127.0.0.1:8765'
  const details = {
    statusCode: 401, url: `${root}/api/project/list`,
    responseHeaders: { 'X-WorkStep-Managed-Session-Expired': ['1'] },
  }
  assert.equal(managedSessionExpired(details, root), true)
  assert.equal(managedSessionExpired({ ...details, statusCode: 403 }, root), false)
  assert.equal(managedSessionExpired({ ...details, url: `${root}/api/managed/bootstrap` }, root), false)
  assert.equal(managedSessionExpired({ ...details, url: 'http://127.0.0.1:9999/api/project/list' }, root), false)
  assert.equal(managedSessionExpired({ ...details, responseHeaders: {} }, root), false)
})
