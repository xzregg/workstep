const { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign,
  timingSafeEqual, verify } = require('node:crypto')

function createControlDelegation(authorization, devicePrivateKeyPem) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const fingerprint = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex')
  const delegationSignature = sign(null,
    Buffer.from(`workstep-control-delegate-v1:${authorization}:${fingerprint}`),
    createPrivateKey(devicePrivateKeyPem)).toString('base64url')
  return {
    controlPrivateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    controlPublicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    delegationSignature,
  }
}

function createAuthorizationRequest(managed, appInstanceId) {
  const origin = new URL(managed.gateway_origin)
  if (origin.protocol !== 'https:' || origin.origin !== managed.gateway_origin) {
    throw new Error('Invalid managed Gateway origin')
  }
  if (!managed.gateway_id || !appInstanceId) throw new Error('Gateway and app instance required')
  const state = randomBytes(32).toString('base64url')
  const nonce = randomBytes(32).toString('base64url')
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const url = new URL('/desktop/login', origin)
  for (const [key, value] of Object.entries({
    gateway_id: managed.gateway_id,
    app_instance_id: appInstanceId,
    state,
    nonce,
    code_challenge: challenge,
  })) url.searchParams.set(key, value)
  return {
    state, nonce, verifier, challenge, appInstanceId,
    gatewayId: managed.gateway_id, gatewayOrigin: origin.origin,
    authorizationUrl: url.toString(), createdAt: Date.now(), claimed: false,
  }
}

function claimAuthCallback(value, pending) {
  if (!pending || pending.claimed) throw new Error('Authorization callback already claimed')
  if (Date.now() - pending.createdAt > 5 * 60 * 1000) throw new Error('Authorization callback expired')
  let url
  try { url = new URL(value) } catch { throw new Error('Invalid authorization callback') }
  if (url.protocol !== 'workstep:' || url.hostname !== 'auth' || url.pathname !== '/callback'
      || url.hash || [...url.searchParams].length !== 2 || !url.searchParams.get('code')
      || !url.searchParams.get('state')) {
    throw new Error('Invalid authorization callback')
  }
  const actual = Buffer.from(url.searchParams.get('state'))
  const expected = Buffer.from(pending.state)
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error('Authorization state mismatch')
  }
  pending.claimed = true
  return { code: url.searchParams.get('code'), state: pending.state }
}

function verifyDeviceAuthorization(token, publicKeyPem, expectedFingerprint, gatewayId, appInstanceId) {
  const publicKey = createPublicKey(publicKeyPem)
  const fingerprint = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex')
  if (fingerprint !== expectedFingerprint || publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('Gateway public key fingerprint mismatch')
  }
  const parts = token?.split('.')
  if (!parts || parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) {
    throw new Error('Invalid device authorization')
  }
  const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString())
  if (header.alg !== 'EdDSA' || header.typ !== 'JWT') throw new Error('Invalid authorization algorithm')
  if (!verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), publicKey,
    Buffer.from(parts[2], 'base64url'))) throw new Error('Invalid device authorization signature')
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString())
  if (claims.gateway_id !== gatewayId) throw new Error('Wrong Gateway authorization')
  if (claims.app_instance_id !== appInstanceId) throw new Error('Wrong app instance authorization')
  if (!claims.device_id || !claims.user_id || !Number.isSafeInteger(claims.exp)
      || claims.exp <= Math.floor(Date.now() / 1000)) throw new Error('Expired device authorization')
  return claims
}

async function exchangeDesktopCode({ pending, code, managed, devicePublicKey, deviceName,
  version, rotationSignature, fetchImpl = fetch }) {
  if (managed.gateway_origin !== pending.gatewayOrigin || managed.gateway_id !== pending.gatewayId) {
    throw new Error('Managed Gateway binding mismatch')
  }
  const base = managed.gateway_origin
  const keyResponse = await fetchImpl(`${base}/api/platform/gateway-key`, {
    redirect: 'error', signal: AbortSignal.timeout(10_000),
  })
  if (!keyResponse.ok) throw new Error('Unable to load Gateway signing key')
  const key = await keyResponse.json()
  const publicKey = createPublicKey(key.public_key_pem)
  const actualFingerprint = createHash('sha256')
    .update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex')
  if (key.gateway_id !== managed.gateway_id || actualFingerprint !== managed.gateway_public_key_fingerprint
      || key.fingerprint !== actualFingerprint || publicKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('Gateway public key fingerprint mismatch')
  }
  const response = await fetchImpl(`${base}/api/desktop/token`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code, state: pending.state, nonce: pending.nonce, code_verifier: pending.verifier,
      app_instance_id: pending.appInstanceId, gateway_id: pending.gatewayId,
      device_public_key: devicePublicKey, device_name: deviceName, version,
      ...(rotationSignature ? { rotation_signature: rotationSignature } : {}),
    }),
  })
  if (!response.ok) throw new Error(`Desktop authorization rejected (${response.status})`)
  const result = await response.json()
  if (result.device_authorization) {
    const claims = verifyDeviceAuthorization(result.device_authorization, key.public_key_pem,
      actualFingerprint, pending.gatewayId, pending.appInstanceId)
    if (claims.device_id !== result.device?.id || claims.user_id !== result.user?.id
        || claims.device_public_key !== devicePublicKey) {
      throw new Error('Device authorization identity mismatch')
    }
  } else if (result.device?.status !== 'pending') {
    throw new Error('Device authorization missing')
  }
  return result
}

module.exports = {
  createAuthorizationRequest, claimAuthCallback, verifyDeviceAuthorization, exchangeDesktopCode,
  createControlDelegation,
}
