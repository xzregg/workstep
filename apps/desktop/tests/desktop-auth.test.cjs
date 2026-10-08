const assert = require('node:assert/strict')
const { createHash, generateKeyPairSync, sign, verify, createPublicKey } = require('node:crypto')
const test = require('node:test')
const {
  createAuthorizationRequest,
  parseAuthCallback,
  claimAuthCallback,
  verifyDeviceAuthorization,
  exchangeDesktopCode,
  createControlDelegation,
} = require('../src/desktop-auth.cjs')

const managed = {
  gateway_id: 'gateway-test', gateway_origin: 'https://gateway.test',
}

test('Desktop request pins Gateway and generates PKCE, state, nonce', () => {
  const pending = createAuthorizationRequest(managed, 'app-instance-12345')
  const url = new URL(pending.authorizationUrl)
  assert.equal(url.origin, managed.gateway_origin)
  assert.equal(url.pathname, '/desktop/login')
  assert.equal(url.searchParams.get('gateway_id'), managed.gateway_id)
  assert.equal(url.searchParams.get('app_instance_id'), 'app-instance-12345')
  assert.equal(url.searchParams.get('code_challenge'), createHash('sha256')
    .update(pending.verifier).digest('base64url'))
  assert.ok(pending.state.length >= 32)
  assert.ok(pending.nonce.length >= 32)
})

test('Desktop delegates control challenge signing without exporting the device key', () => {
  const { privateKey } = generateKeyPairSync('ed25519')
  const token = 'signed-device-authorization'
  const delegation = createControlDelegation(token,
    privateKey.export({ type: 'pkcs8', format: 'pem' }).toString())
  const publicKey = createPublicKey(delegation.controlPrivateKeyPem)
  assert.equal(publicKey.export({ type: 'spki', format: 'pem' }).toString(), delegation.controlPublicKeyPem)
  const fingerprint = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex')
  assert.equal(verify(null, Buffer.from(`workstep-control-delegate-v1:${token}:${fingerprint}`),
    createPublicKey(privateKey), Buffer.from(delegation.delegationSignature, 'base64url')), true)
})

test('callback accepts only matching one-time code and state', () => {
  const pending = createAuthorizationRequest(managed, 'app-instance-12345')
  assert.throws(() => claimAuthCallback('workstep://auth/callback?code=secret&state=forged', pending), /state/i)
  assert.throws(() => claimAuthCallback('workstep://remote-project/v1/foo', pending), /callback/i)
  assert.throws(() => claimAuthCallback(`workstep://auth/callback?code=secret&state=${pending.state}&token=leak`, pending), /callback/i)
  const result = claimAuthCallback(`workstep://auth/callback?code=secret&state=${pending.state}`, pending)
  assert.equal(result.code, 'secret')
  assert.throws(() => claimAuthCallback(`workstep://auth/callback?code=secret&state=${pending.state}`, pending), /already/i)
})

test('configured desktop callback is parsed before the daemon verifies its state', () => {
  assert.deepEqual(parseAuthCallback('workstep://auth/callback?code=secret&state=state-value'), {
    code: 'secret', state: 'state-value',
  })
  assert.throws(() => parseAuthCallback('workstep://open?code=secret&state=state-value'), /callback/i)
  assert.throws(() => parseAuthCallback('workstep://auth/callback?code=secret&state=x&extra=y'), /callback/i)
})

test('device authorization checks pinned key and bound installation', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const fingerprint = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex')
  const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url')
  const claims = { gateway_id: 'gateway-test', app_instance_id: 'app-instance-12345',
    device_id: 'device-1', user_id: 'user-1', exp: Math.floor(Date.now() / 1000) + 900 }
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const signature = sign(null, Buffer.from(`${header}.${payload}`), privateKey).toString('base64url')
  const token = `${header}.${payload}.${signature}`
  assert.equal(verifyDeviceAuthorization(token, pem, fingerprint, managed.gateway_id,
    'app-instance-12345').device_id, 'device-1')
  assert.throws(() => verifyDeviceAuthorization(token, pem, '0'.repeat(64), managed.gateway_id,
    'app-instance-12345'), /fingerprint/i)
  assert.throws(() => verifyDeviceAuthorization(token, pem, fingerprint, managed.gateway_id,
    'other-instance'), /instance/i)
})

test('exchange sends PKCE only to the pinned Gateway and rejects key substitution', async () => {
  const pending = createAuthorizationRequest(managed, 'app-instance-12345')
  const { publicKey } = generateKeyPairSync('ed25519')
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const fingerprint = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex')
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, options })
    if (url.endsWith('/api/platform/gateway-key')) return {
      ok: true, json: async () => ({ gateway_id: managed.gateway_id,
        public_key_pem: pem, fingerprint }),
    }
    return { ok: true, json: async () => ({ user: { id: 'user-1' },
      device: { id: 'device-1', status: 'pending' }, device_authorization: null }) }
  }
  const result = await exchangeDesktopCode({ pending, code: 'one-time-code',
    managed: { ...managed, gateway_public_key_fingerprint: fingerprint },
    devicePublicKey: 'device-public-key', deviceName: 'PC', version: '1.0',
    os: 'macos', arch: 'arm64', fetchImpl })
  assert.equal(result.device.status, 'pending')
  assert.equal(calls.length, 2)
  assert.equal(calls[1].url, 'https://gateway.test/api/desktop/token')
  const body = JSON.parse(calls[1].options.body)
  assert.equal(body.code_verifier, pending.verifier)
  assert.equal(body.app_instance_id, pending.appInstanceId)
  assert.equal(body.os, 'macos')
  assert.equal(body.arch, 'arm64')
  await assert.rejects(() => exchangeDesktopCode({ pending, code: 'one-time-code',
    managed: { ...managed, gateway_public_key_fingerprint: '0'.repeat(64) },
    devicePublicKey: 'device-public-key', deviceName: 'PC', version: '1.0', fetchImpl }), /fingerprint/i)
  assert.equal(calls.length, 3)
})
