import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const coordinatorSource = await readFile(
  new URL('../src/components/CoordinatorConfigBar.tsx', import.meta.url),
  'utf8',
)
const promptEnhanceSource = await readFile(
  new URL('../src/pages/PromptEnhanceSettings.tsx', import.meta.url),
  'utf8',
)
const providerSource = await readFile(
  new URL('../src/pages/ProviderSettings.tsx', import.meta.url),
  'utf8',
)
const providerEditorSource = await readFile(
  new URL('../src/components/ProviderEditorDialog.tsx', import.meta.url),
  'utf8',
)
const flowCanvasSource = await readFile(
  new URL('../src/components/NodeConfigPanel.tsx', import.meta.url),
  'utf8',
)
const flowAssistantSource = await readFile(
  new URL('../src/components/AiFlowChat.tsx', import.meta.url),
  'utf8',
)
const assistantApiSource = await readFile(
  new URL('../src/api/client.ts', import.meta.url),
  'utf8',
)

test('reset workflow assistant sessions restore the workflow assistant settings', () => {
  assert.match(
    flowAssistantSource,
    /const configured = assistantConfig\?\.configured[\s\S]*setSelectedEngine\(configured\?\.engine \|\| ''\)[\s\S]*setSelectedThinkingEffort\(configured\?\.thinking_effort \|\| ''\)/,
  )
})

test('workflow steps reload provider models and clear stale selections', () => {
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
    assert.match(providerEditorSource, new RegExp(protocol))
  }
  assert.match(providerEditorSource, /protocol_base_urls/)
  assert.match(providerEditorSource, /form\.protocols\.map/)
  assert.match(providerEditorSource, /protocol: form\.protocols\[0\]/)
  assert.match(providerEditorSource, /base_url: protocolBaseUrls\[form\.protocols\[0\]\]/)
})

test('provider settings can copy an existing provider into a new configuration', () => {
  assert.match(providerSource, /providerSettings\.copy/)
  assert.match(providerEditorSource, /providerSettings\.copyTitle/)
  assert.match(providerEditorSource, /providerApi\.reveal\(target\.provider\.id\)/)
  assert.match(providerEditorSource, /name: t\('providerSettings\.copyName', \{ name: target\.provider\.name \}\)/)
})

test('prompt enhancement selects and persists a provider protocol', () => {
  assert.match(promptEnhanceSource, /setProtocol\(result\.protocol \|\| configuredProvider\?\.protocols\?\.\[0\] \|\| ''\)/)
  assert.match(promptEnhanceSource, /providerApi\.models\(providerId, false, protocol\)/)
  assert.match(promptEnhanceSource, /setEnhanceConfig\(\{ providerId, model, protocol \}\)/)
  assert.match(assistantApiSource, /protocol: config\.protocol/)
})
