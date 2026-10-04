const assert = require('node:assert/strict')
const test = require('node:test')
const { validateGatewayOrigin } = require('../src/gateway-origin.cjs')
const { createAuthorizationRequest } = require('../src/desktop-auth.cjs')

for (const origin of ['http://localhost:8700', 'http://127.0.0.1:8700', 'http://[::1]:8700',
  'http://gateway.localhost:8700', 'https://gateway.test:8700']) {
  test(`Desktop accepts ${origin} and pins its login target`, () => {
    assert.equal(validateGatewayOrigin(origin).origin, origin)
    const request = createAuthorizationRequest({ gateway_origin: origin, gateway_id: 'local' }, 'app-1')
    assert.equal(request.gatewayOrigin, origin)
  })
}
for (const origin of ['http://gateway.test:8700', 'http://localhost.evil.test:8700',
  'http://192.168.1.2:8700', 'http://0.0.0.0:8700', 'http://user@localhost:8700',
  'http://localhost:8700/path']) {
  test(`Desktop rejects ${origin}`, () => assert.throws(() => validateGatewayOrigin(origin)))
}
