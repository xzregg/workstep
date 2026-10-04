const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { loadOrCreateDeviceIdentity } = require('../src/credential-store.cjs')

const storage = {
  isAsyncEncryptionAvailable: async () => true,
  getSelectedStorageBackend: () => 'gnome_libsecret',
  encryptStringAsync: async (value) => Buffer.from(`encrypted:${value}`).reverse(),
  decryptStringAsync: async (value) => ({ result: Buffer.from(value).reverse().toString().slice(10),
    shouldReEncrypt: false }),
}

test('device identity survives restart without plaintext private key on disk', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'workstep-desktop-identity-'))
  try {
    const first = await loadOrCreateDeviceIdentity(directory, storage, 'gateway-a')
    const second = await loadOrCreateDeviceIdentity(directory, storage, 'gateway-a')
    assert.equal(first.appInstanceId, second.appInstanceId)
    assert.equal(first.privateKeyPem, second.privateKeyPem)
    assert.equal(first.gatewayId, 'gateway-a')
    const file = await fs.readFile(path.join(directory, 'managed-identity.enc'))
    assert.equal(file.includes(Buffer.from('PRIVATE KEY')), false)
    assert.equal((await fs.stat(path.join(directory, 'managed-identity.enc'))).mode & 0o777, 0o600)
    await assert.rejects(() => loadOrCreateDeviceIdentity(directory, storage, 'gateway-b'), /gateway/i)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('managed identity refuses plaintext storage fallback', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'workstep-desktop-identity-'))
  try {
    await assert.rejects(() => loadOrCreateDeviceIdentity(directory, {
      ...storage, getSelectedStorageBackend: () => 'basic_text',
    }, 'gateway-a'), /secure storage/i)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})
