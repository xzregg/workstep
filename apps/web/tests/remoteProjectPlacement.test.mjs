import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const layoutSource = await readFile(new URL('../src/components/Layout.tsx', import.meta.url), 'utf8')
const settingsSource = await readFile(new URL('../src/pages/SettingsPage.tsx', import.meta.url), 'utf8')
const remoteProjectsSource = await readFile(new URL('../src/pages/RemoteProjectsPage.tsx', import.meta.url), 'utf8')

test('remote projects has its own top-level sidebar entry and page', () => {
  assert.match(layoutSource, /import RemoteProjectsPage from '\.\.\/pages\/RemoteProjectsPage'/)
  assert.match(layoutSource, /setShowRemoteProjects\(true\)/)
  assert.match(layoutSource, /t\('nav\.remoteProjects'\)/)
  assert.match(layoutSource, /<RemoteProjectsPage onClose=/)
})

test('remote access controls live outside system settings', () => {
  assert.doesNotMatch(settingsSource, /remoteProjectApi/)
  assert.doesNotMatch(settingsSource, /settings\.remoteAccessTitle/)
  assert.match(remoteProjectsSource, /remoteProjectApi\.settings\(\)/)
  assert.match(remoteProjectsSource, /remoteProjectApi\.updateSettings/)
  assert.match(remoteProjectsSource, /remoteProjectApi\.devices\(\)/)
  assert.match(remoteProjectsSource, /remoteProjectApi\.revokeDevice/)
})
