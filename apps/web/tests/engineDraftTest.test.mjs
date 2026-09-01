import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const formSource = await readFile(new URL('../src/components/EngineConfigForm.tsx', import.meta.url), 'utf8')
const settingsSource = await readFile(new URL('../src/pages/SettingsPage.tsx', import.meta.url), 'utf8')
const clientSource = await readFile(new URL('../src/api/client.ts', import.meta.url), 'utf8')

test('engine connectivity test sends the current form values without saving them first', () => {
  assert.match(formSource, /getTestInput:\s*\(\)\s*=>/)
  assert.match(settingsSource, /engineFormRefs\.current\[engineId\]\?\.getTestInput\(\)/)
  assert.match(settingsSource, /engineApi\.test\(engineId, testInput\)/)
  assert.match(clientSource, /test:\s*\(engineId:\s*string,\s*config\?:\s*EngineConfigSaveInput\)/)
  assert.match(clientSource, /values:\s*config\?\.values\s*\?\?\s*\{\}/)
  assert.match(clientSource, /clear:\s*config\?\.clear\s*\?\?\s*\{\}/)
  assert.match(settingsSource, /if \(testResults\[engine\.id\]\?\.success\)/)
  assert.match(settingsSource, /void testEngine\(engine\.id\)/)
})
