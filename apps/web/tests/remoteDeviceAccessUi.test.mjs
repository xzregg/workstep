import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const shareSource = await readFile(new URL('../src/components/ProjectShareDialog.tsx', import.meta.url), 'utf8')
const settingsSource = await readFile(new URL('../src/pages/RemoteProjectSettings.tsx', import.meta.url), 'utf8')
const clientSource = await readFile(new URL('../src/api/client.ts', import.meta.url), 'utf8')
const layoutSource = await readFile(new URL('../src/components/Layout.tsx', import.meta.url), 'utf8')

test('share dialog defaults device access to permanent and sends the selected expiry', () => {
  assert.match(shareSource, /useState<AccessDurationPreset>\('permanent'\)/)
  assert.match(shareSource, /resolveAccessExpiresAt/)
  assert.match(shareSource, /remoteProjectApi\.createShare\(project\.id, access, accessExpiresAt\)/)
  assert.match(shareSource, /<RemoteDeviceAccessList/)
})

test('owner surfaces reuse one device access list with expiry and revoke actions', () => {
  assert.match(settingsSource, /<RemoteDeviceAccessList/)
  assert.match(clientSource, /updateDeviceAccess/)
  assert.match(clientSource, /\/remote-project\/devices\/access/)
  assert.match(clientSource, /expires_at: number \| null/)
})

test('remote project rows expose revoked and expired authorization states', () => {
  assert.match(layoutSource, /p\.access_status === 'revoked'/)
  assert.match(layoutSource, /p\.access_status === 'expired'/)
  assert.match(layoutSource, /layout\.remoteAccessRevoked/)
  assert.match(layoutSource, /layout\.remoteAccessExpired/)
})
