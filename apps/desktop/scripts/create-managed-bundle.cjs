const { createHash, createPublicKey, sign } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

function createManagedBundle({ outputDir, gatewayId, origin, gatewayPublicKey, packageSigningKey, channel }) {
  const parsed = new URL(origin)
  if (parsed.protocol !== 'https:' || parsed.origin !== origin) throw new Error('Gateway origin must be HTTPS')
  if (!gatewayId || !channel) throw new Error('Gateway ID and release channel are required')
  const gatewayKey = gatewayPublicKey.type === 'public' ? gatewayPublicKey : createPublicKey(gatewayPublicKey)
  const packageKey = createPublicKey(packageSigningKey)
  if (gatewayKey.asymmetricKeyType !== 'ed25519' || packageKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('Gateway and package signing keys must be Ed25519')
  }
  const payload = {
    deployment_channel: channel,
    gateway_id: gatewayId,
    gateway_origin: origin,
    gateway_public_key_fingerprint: createHash('sha256').update(gatewayKey.export({ type: 'spki', format: 'der' })).digest('hex'),
    min_protocol_version: 1,
  }
  const signature = sign(null, Buffer.from(JSON.stringify(payload)), packageSigningKey).toString('base64')
  fs.mkdirSync(outputDir)
  fs.writeFileSync(path.join(outputDir, 'managed-gateway.json'), JSON.stringify({ payload, signature }, null, 2))
  fs.writeFileSync(path.join(outputDir, 'managed-root.pem'), packageKey.export({ type: 'spki', format: 'pem' }))
  return payload
}

if (require.main === module) {
  const env = process.env
  const required = [
    'WORKSTEP_GATEWAY_ID', 'WORKSTEP_GATEWAY_ORIGIN', 'WORKSTEP_GATEWAY_PUBLIC_KEY_FILE',
    'WORKSTEP_MANAGED_SIGNING_KEY_FILE', 'WORKSTEP_MANAGED_BUNDLE_DIR',
  ]
  for (const name of required) if (!env[name]) throw new Error(`${name} is required`)
  createManagedBundle({
    outputDir: path.resolve(env.WORKSTEP_MANAGED_BUNDLE_DIR),
    gatewayId: env.WORKSTEP_GATEWAY_ID,
    origin: env.WORKSTEP_GATEWAY_ORIGIN,
    gatewayPublicKey: fs.readFileSync(env.WORKSTEP_GATEWAY_PUBLIC_KEY_FILE),
    packageSigningKey: fs.readFileSync(env.WORKSTEP_MANAGED_SIGNING_KEY_FILE),
    channel: env.WORKSTEP_MANAGED_CHANNEL || 'stable',
  })
}

module.exports = { createManagedBundle }
