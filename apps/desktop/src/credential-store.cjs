const { generateKeyPair, randomUUID } = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')
const { promisify } = require('node:util')

const generateKeyPairAsync = promisify(generateKeyPair)

async function writeEncrypted(file, storage, identity) {
  const encrypted = await storage.encryptStringAsync(JSON.stringify(identity))
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, encrypted, { mode: 0o600, flag: 'wx' })
    await fs.rename(temporary, file)
  } finally {
    await fs.rm(temporary, { force: true })
  }
}

async function loadOrCreateDeviceIdentity(directory, storage, gatewayId) {
  if (!await storage.isAsyncEncryptionAvailable()
      || storage.getSelectedStorageBackend?.() === 'basic_text') {
    throw new Error('Secure storage is required for managed identity')
  }
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const file = path.join(directory, 'managed-identity.enc')
  let identity
  try {
    const decrypted = await storage.decryptStringAsync(await fs.readFile(file))
    if (decrypted.isTemporarilyUnavailable || !decrypted.result) {
      throw new Error('Secure storage temporarily unavailable')
    }
    identity = JSON.parse(decrypted.result)
    if (decrypted.shouldReEncrypt) await writeEncrypted(file, storage, identity)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    const { publicKey, privateKey } = await generateKeyPairAsync('ed25519')
    identity = {
      gatewayId,
      appInstanceId: randomUUID(),
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    }
    await writeEncrypted(file, storage, identity)
  }
  if (identity.gatewayId !== gatewayId) throw new Error('Managed Gateway binding mismatch')
  if (!identity.appInstanceId || !identity.publicKeyPem || !identity.privateKeyPem) {
    throw new Error('Invalid managed device identity')
  }
  return identity
}

module.exports = { loadOrCreateDeviceIdentity }
