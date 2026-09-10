import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const settings = await readFile(new URL('../src/pages/SettingsPage.tsx', import.meta.url), 'utf8')
const client = await readFile(new URL('../src/api/client.ts', import.meta.url), 'utf8')

test('installed SDK engines expose the update action', () => {
  assert.match(settings, /engine\.installed && engine\.updatable/)
  assert.match(settings, /updateEngine\(engine\.id\)/)
  assert.match(client, /\/engine\/\$\{encodeURIComponent\(engineId\)\}\/update/)
})
