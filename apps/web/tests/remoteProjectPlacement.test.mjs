import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const layoutSource = await readFile(new URL('../src/components/Layout.tsx', import.meta.url), 'utf8')
const settingsSource = await readFile(new URL('../src/pages/SettingsPage.tsx', import.meta.url), 'utf8')
const remoteProjectsSource = await readFile(new URL('../src/pages/RemoteProjectSettings.tsx', import.meta.url), 'utf8')
const remoteDeviceAccessSource = await readFile(new URL('../src/components/RemoteDeviceAccessList.tsx', import.meta.url), 'utf8')

test('remote access is assembled as a dedicated settings category', () => {
  assert.doesNotMatch(layoutSource, /RemoteProjectsPage/)
  assert.doesNotMatch(layoutSource, /showRemoteProjects/)
  assert.match(settingsSource, /import RemoteAccessSettings from '\.\/RemoteAccessSettings'/)
  assert.match(settingsSource, /activeSection === 'remote'/)
  assert.match(settingsSource, /<RemoteAccessSettings \/>/)
})

test('remote access controls stay separate from the system category', () => {
  assert.doesNotMatch(settingsSource, /remoteProjectApi/)
  assert.match(remoteProjectsSource, /remoteProjectApi\.settings\(\)/)
  assert.match(remoteProjectsSource, /remoteProjectApi\.updateSettings/)
  assert.match(remoteProjectsSource, /remoteProjectApi\.devices\(\)/)
  assert.match(remoteProjectsSource, /<RemoteDeviceAccessList/)
  assert.match(remoteDeviceAccessSource, /remoteProjectApi\.revokeDevice/)
  assert.match(remoteDeviceAccessSource, /remoteProjectApi\.updateDeviceAccess/)
})
