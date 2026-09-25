import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const coordinatorSource = await readFile(
  new URL('../src/components/CoordinatorConfigBar.tsx', import.meta.url),
  'utf8',
)
const assistantSettingsSource = await readFile(
  new URL('../src/pages/AgentAssistantSettings.tsx', import.meta.url),
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
const flowCanvasSource = await readFile(
  new URL('../src/components/NodeConfigPanel.tsx', import.meta.url),
  'utf8',
)
const chatPageSource = await readFile(
  new URL('../src/pages/ChatPage.tsx', import.meta.url),
  'utf8',
)
const flowAssistantSource = await readFile(
  new URL('../src/components/AiFlowChat.tsx', import.meta.url),
  'utf8',
)
const taskCreateAssistantSource = await readFile(
  new URL('../src/components/AiTaskCreateChat.tsx', import.meta.url),
  'utf8',
)
const apiClientSource = await readFile(
  new URL('../src/api/conversations.ts', import.meta.url),
  'utf8',
)
const assistantApiSource = await readFile(
  new URL('../src/api/client.ts', import.meta.url),
  'utf8',
)

test('assistant provider switching clears every selected model', () => {
  assert.match(
    assistantSettingsSource,
    /setProviderId\(event\.target\.value\)[\s\S]*?setModel\(''\)[\s\S]*?setFastModel\(''\)[\s\S]*?setVisionModel\(''\)/,
  )
})

test('project chat loads its own assistant defaults', () => {
  assert.match(chatPageSource, /assistantApi\.list\(\)/)
  assert.match(chatPageSource, /item\.name === 'chat_session'/)
  assert.match(chatPageSource, /setSelectedProvider\(configured\.provider_id \|\| ''\)/)
  assert.doesNotMatch(chatPageSource, /engineApi\.coordinatorDefaults/)
})

test('internal assistants load their own vision configuration', () => {
  assert.match(flowAssistantSource, /assistantApi\.list\(\)/)
  assert.match(flowAssistantSource, /item\.name === 'workflow_gen'/)
  assert.match(taskCreateAssistantSource, /assistantApi\.list\(\)/)
  assert.match(taskCreateAssistantSource, /item\.name === 'task_create'/)
  for (const source of [chatPageSource, flowAssistantSource, taskCreateAssistantSource]) {
    assert.match(source, /visionModel: selectedVisionModel/)
    assert.match(source, /showVision: true/)
    assert.match(source, /onVisionModelChange: setSelectedVisionModel/)
  }
  assert.match(apiClientSource, /vision_model: options\.visionModel \|\| undefined/)
  assert.match(apiClientSource, /vision_model: options\.vision_model \|\| undefined/)
})

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
    assert.match(providerSource, new RegExp(protocol))
  }
  assert.match(providerSource, /protocol_base_urls/)
  assert.match(providerSource, /form\.protocols\.map/)
  assert.match(providerSource, /protocol: form\.protocols\[0\]/)
  assert.match(providerSource, /base_url: protocolBaseUrls\[form\.protocols\[0\]\]/)
})

test('provider protocols use switches and reveal their own address field', () => {
  assert.match(providerSource, /className="provider-protocol-toggle"/)
  assert.match(providerSource, /role="switch"/)
  assert.match(providerSource, /className="provider-protocol-switch"/)
  assert.match(
    providerSource,
    /form\.protocols\.includes\(option\.value\) && \([\s\S]*?provider-base-url-\$\{option\.value\}/,
  )
  assert.doesNotMatch(providerSource, /provider-protocol-checkmark/)
})

test('provider settings can copy an existing provider into a new configuration', () => {
  assert.match(providerSource, /providerSettings\.copy/)
  assert.match(providerSource, /providerSettings\.copyTitle/)
  assert.match(providerSource, /providerApi\.reveal\(provider\.id\)/)
  assert.match(providerSource, /setEditingId\(null\)/)
  assert.match(providerSource, /name: t\('providerSettings\.copyName', \{ name: provider\.name \}\)/)
})

test('prompt enhancement selects and persists a provider protocol', () => {
  assert.match(promptEnhanceSource, /setProtocol\(result\.protocol \|\| configuredProvider\?\.protocols\?\.\[0\] \|\| ''\)/)
  assert.match(promptEnhanceSource, /providerApi\.models\(providerId, false, protocol\)/)
  assert.match(promptEnhanceSource, /setEnhanceConfig\(\{ providerId, model, protocol \}\)/)
  assert.match(assistantApiSource, /protocol: config\.protocol/)
})
