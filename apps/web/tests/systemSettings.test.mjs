import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const appSource = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
const settingsSource = await readFile(new URL('../src/pages/SettingsPage.tsx', import.meta.url), 'utf8')
const firstUseSource = await readFile(new URL('../src/components/FirstUseDialog.tsx', import.meta.url), 'utf8')

test('the app presents first-use user-name setup', () => {
  assert.match(appSource, /<FirstUseDialog \/>/)
})

test('first-use setup can start or skip the guided checklist after saving a name', () => {
  assert.match(firstUseSource, /useOnboardingStore/)
  assert.match(firstUseSource, /startGuide/)
  assert.match(firstUseSource, /skipGuide/)
  assert.match(firstUseSource, /onboarding\.quickStart/)
  assert.match(firstUseSource, /onboarding\.skipGuide/)
})

test('language and user name live together under system settings', () => {
  assert.match(settingsSource, /activeSection === 'system'/)
  assert.match(settingsSource, /settings\.systemNav/)
  assert.match(settingsSource, /settings\.userName/)
  assert.match(settingsSource, /settings\.fontSize/)
  assert.match(settingsSource, /<SegmentedControl/)
  assert.doesNotMatch(settingsSource, /activeSection === 'language'/)
})

test('execution engine settings show the saved model and only refresh from the refresh button', () => {
  const modelSelect = settingsSource.match(/<Select\s+id=\{`default-model-\$\{engine\.id\}`\}[\s\S]*?<\/Select>/)?.[0] || ''
  assert.match(settingsSource, /engine\.default_model/)
  assert.doesNotMatch(modelSelect, /loadEngineModels/)
  assert.match(settingsSource, /onClick=\{\(\) => void loadEngineModels\(engine\.id, true\)\}/)
  assert.match(settingsSource, /if \(!isExpanded\) void loadEngineModels\(engineId, false\)/)
  assert.match(settingsSource, /providerApi\.models\(providerId, true\)/)
})
