import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const layoutSource = await readFile(new URL('../src/components/Layout.tsx', import.meta.url), 'utf8')
const settingsSource = await readFile(new URL('../src/pages/SettingsPage.tsx', import.meta.url), 'utf8')
const remoteProjectsSource = await readFile(new URL('../src/pages/RemoteProjectSettings.tsx', import.meta.url), 'utf8')
const remoteDeviceAccessSource = await readFile(new URL('../src/components/RemoteDeviceAccessList.tsx', import.meta.url), 'utf8')

test('remote projects is a dedicated category inside settings', () => {
  assert.doesNotMatch(layoutSource, /RemoteProjectsPage/)
  assert.doesNotMatch(layoutSource, /showRemoteProjects/)
  assert.match(settingsSource, /import RemoteProjectSettings from '\.\/RemoteProjectSettings'/)
  assert.match(settingsSource, /activeSection === 'remote'/)
  assert.match(settingsSource, /<RemoteProjectSettings \/>/)
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
