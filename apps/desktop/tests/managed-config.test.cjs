const assert = require('node:assert/strict')
const { createHash, generateKeyPairSync, sign } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { readManagedConfig, managedEnvironment } = require('../src/managed-config.cjs')
const { managedBuildConfig } = require('../scripts/build-managed.cjs')
const { createManagedBundle } = require('../scripts/create-managed-bundle.cjs')

test('local package has no managed Gateway configuration', () => {
  const resources = fs.mkdtempSync(path.join(os.tmpdir(), 'workstep-managed-'))
  try {
    assert.equal(readManagedConfig(resources), null)
    assert.throws(() => readManagedConfig(resources, 'a'.repeat(64)), /Invalid signed managed Gateway bundle/)
  }
  finally { fs.rmSync(resources, { recursive: true }) }
})

test('signed managed package is accepted and tampering is rejected', () => {
  const resources = fs.mkdtempSync(path.join(os.tmpdir(), 'workstep-managed-'))
  const bundle = path.join(resources, 'managed-gateway')
  fs.mkdirSync(bundle)
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const payload = {
    deployment_channel: 'stable', gateway_id: 'gateway-1',
    gateway_origin: 'https://gateway.example.com',
    gateway_public_key_fingerprint: 'a'.repeat(64), min_protocol_version: 1,
  }
  fs.writeFileSync(path.join(bundle, 'managed-root.pem'), publicKey.export({ type: 'spki', format: 'pem' }))
  const rootPin = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex')
  const signature = sign(null, Buffer.from(JSON.stringify(payload)), privateKey).toString('base64')
  const configPath = path.join(bundle, 'managed-gateway.json')
  fs.writeFileSync(configPath, JSON.stringify({ payload, signature }))
  try {
    assert.equal(readManagedConfig(resources, rootPin).gateway_id, 'gateway-1')
    assert.deepEqual(managedEnvironment(resources, rootPin), {
      WORKSTEP_MANAGED_BUNDLE_DIR: bundle,
      WORKSTEP_MANAGED_ROOT_PIN: rootPin,
    })
    assert.deepEqual(managedBuildConfig(bundle).extraResources.at(-1), { from: bundle, to: 'managed-gateway' })
    assert.equal(managedBuildConfig(bundle).extraMetadata.managedGatewayRootFingerprint, rootPin)
    assert.throws(() => readManagedConfig(resources, 'b'.repeat(64)), /Invalid signed managed Gateway bundle/)
    assert.throws(() => readManagedConfig(resources), /Invalid signed managed Gateway bundle/)
    payload.gateway_origin = 'https://attacker.example.com'
    fs.writeFileSync(configPath, JSON.stringify({ payload, signature }))
    assert.throws(() => readManagedConfig(resources, rootPin), /Invalid signed managed Gateway bundle/)
  } finally { fs.rmSync(resources, { recursive: true }) }
})

for (const origin of ['https://gateway.example.com', 'http://localhost:8700']) {
test(`bundle creator pins Gateway key for ${origin} without copying its signing secret`, () => {
  const resources = fs.mkdtempSync(path.join(os.tmpdir(), 'workstep-managed-'))
  const { publicKey: gatewayPublic } = generateKeyPairSync('ed25519')
  const { privateKey: packagePrivate } = generateKeyPairSync('ed25519')
  const bundle = path.join(resources, 'managed-gateway')
  try {
    createManagedBundle({
      outputDir: bundle, gatewayId: 'gateway-2', origin,
      gatewayPublicKey: gatewayPublic, packageSigningKey: packagePrivate, channel: 'stable',
    })
    const rootPin = managedBuildConfig(bundle).extraMetadata.managedGatewayRootFingerprint
    assert.equal(readManagedConfig(resources, rootPin).gateway_id, 'gateway-2')
    assert.equal(readManagedConfig(resources, rootPin).gateway_origin, origin)
    assert.equal(fs.readdirSync(bundle).sort().join(','), 'managed-gateway.json,managed-root.pem')
    assert.ok(!fs.readFileSync(path.join(bundle, 'managed-root.pem'), 'utf8').includes('PRIVATE KEY'))
  } finally { fs.rmSync(resources, { recursive: true }) }
})
}
