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
  new URL('../src/api/client.ts', import.meta.url),
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

test('provider settings can copy an existing provider into a new configuration', () => {
  assert.match(providerSource, /providerSettings\.copy/)
  assert.match(providerSource, /providerSettings\.copyTitle/)
  assert.match(providerSource, /providerApi\.reveal\(provider\.id\)/)
  assert.match(providerSource, /setEditingId\(null\)/)
  assert.match(providerSource, /name: t\('providerSettings\.copyName', \{ name: provider\.name \}\)/)
})
