import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const appSource = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
const settingsSource = await readFile(new URL('../src/pages/SettingsPage.tsx', import.meta.url), 'utf8')

test('the app presents first-use user-name setup', () => {
  assert.match(appSource, /<FirstUseDialog \/>/)
})

test('language and user name live together under system settings', () => {
  assert.match(settingsSource, /activeSection === 'system'/)
  assert.match(settingsSource, /settings\.systemNav/)
  assert.match(settingsSource, /settings\.userName/)
  assert.doesNotMatch(settingsSource, /activeSection === 'language'/)
})
