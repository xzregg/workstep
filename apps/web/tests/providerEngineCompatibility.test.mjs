import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const coordinatorSource = await readFile(
  new URL('../src/components/CoordinatorConfigBar.tsx', import.meta.url),
  'utf8',
)
const settingsSource = await readFile(
  new URL('../src/pages/SettingsPage.tsx', import.meta.url),
  'utf8',
)
const providerSource = await readFile(
  new URL('../src/pages/ProviderSettings.tsx', import.meta.url),
  'utf8',
)
const flowCanvasSource = await readFile(
  new URL('../src/components/FlowCanvas.tsx', import.meta.url),
  'utf8',
)

test('engine-owned provider selectors filter by declared wire protocol', () => {
  assert.match(coordinatorSource, /provider_protocols \|\| \[\]/)
  assert.match(coordinatorSource, /\.includes\(item\.protocol\)/)
  assert.match(settingsSource, /\.includes\(item\.protocol\)/)
})

test('assistant provider switching clears every selected model', () => {
  assert.match(
    settingsSource,
    /setProviderId\(event\.target\.value\)[\s\S]*?setModel\(''\)[\s\S]*?setFastModel\(''\)[\s\S]*?setVisionModel\(''\)/,
  )
})

test('workflow stages reload provider models and clear stale selections', () => {
  assert.match(flowCanvasSource, /fetchEngineModels\(draft\.engine, false, providerId\)/)
  assert.match(flowCanvasSource, /fetchEngineModels\(reviewEngine, false, providerId\)/)
  assert.match(flowCanvasSource, /key === 'provider_id'/)
  assert.match(flowCanvasSource, /config: next, model: ''/)
})

test('provider settings exposes all supported protocols', () => {
  for (const protocol of [
    'anthropic_messages',
    'openai_responses',
    'openai_chat_completions',
  ]) {
    assert.match(providerSource, new RegExp(protocol))
  }
})
