const { createHash, createPublicKey, verify } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { validateGatewayOrigin } = require('./gateway-origin.cjs')

function rootFingerprint(publicKey) {
  return createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex')
}

function readManagedConfig(resourcesPath, expectedRootFingerprint) {
  const bundleDir = path.join(resourcesPath, 'managed-gateway')
  if (!fs.existsSync(bundleDir)) {
    if (expectedRootFingerprint) throw new Error('Invalid signed managed Gateway bundle')
    return null
  }
  try {
    const signed = JSON.parse(fs.readFileSync(path.join(bundleDir, 'managed-gateway.json'), 'utf8'))
    const payload = signed.payload
    const expectedFields = [
      'deployment_channel', 'gateway_id', 'gateway_origin',
      'gateway_public_key_fingerprint', 'min_protocol_version',
    ]
    if (Object.keys(payload).sort().join(',') !== expectedFields.join(',')) throw new Error('invalid payload fields')
    if (Object.keys(signed).sort().join(',') !== 'payload,signature') throw new Error('invalid bundle fields')
    validateGatewayOrigin(payload.gateway_origin)
    if (typeof payload.gateway_id !== 'string' || !payload.gateway_id) throw new Error('invalid gateway ID')
    if (!/^[0-9a-f]{64}$/.test(payload.gateway_public_key_fingerprint)) throw new Error('invalid key pin')
    if (typeof payload.deployment_channel !== 'string' || !payload.deployment_channel) throw new Error('invalid channel')
    if (!Number.isInteger(payload.min_protocol_version) || payload.min_protocol_version < 1 || payload.min_protocol_version > 1) {
      throw new Error('unsupported protocol')
    }
    if (typeof signed.signature !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(signed.signature)) {
      throw new Error('invalid signature')
    }
    const encoded = Buffer.from(JSON.stringify(Object.fromEntries(Object.keys(payload).sort().map((key) => [key, payload[key]]))))
    const key = createPublicKey(fs.readFileSync(path.join(bundleDir, 'managed-root.pem')))
    if (!/^[0-9a-f]{64}$/.test(expectedRootFingerprint) || rootFingerprint(key) !== expectedRootFingerprint) {
      throw new Error('package signing root pin mismatch')
    }
    if (key.asymmetricKeyType !== 'ed25519' || !verify(null, encoded, key, Buffer.from(signed.signature, 'base64'))) {
      throw new Error('signature mismatch')
    }
    return payload
  } catch (error) {
    throw new Error('Invalid signed managed Gateway bundle', { cause: error })
  }
}

function managedEnvironment(resourcesPath, expectedRootFingerprint) {
  const config = readManagedConfig(resourcesPath, expectedRootFingerprint)
  if (!config) return {}
  return {
    WORKSTEP_MANAGED_BUNDLE_DIR: path.join(resourcesPath, 'managed-gateway'),
    WORKSTEP_MANAGED_ROOT_PIN: expectedRootFingerprint,
  }
}

module.exports = { readManagedConfig, managedEnvironment, rootFingerprint }
