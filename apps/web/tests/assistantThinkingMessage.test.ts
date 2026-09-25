import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { shouldShowAssistantThinking } from '../src/utils/assistantThinking.ts'

const assistantPanelSource = await readFile(
  new URL('../src/components/AssistantChatPanel.tsx', import.meta.url),
  'utf8',
)
const taskDetailSource = await readFile(
  new URL('../src/components/TaskDetailView.tsx', import.meta.url),
  'utf8',
)
const thinkingMessageSource = await readFile(
  new URL('../src/components/AssistantThinkingMessage.tsx', import.meta.url),
  'utf8',
)

test('shows a thinking reply until the running assistant message arrives', () => {
  assert.equal(shouldShowAssistantThinking(true, []), true)
  assert.equal(shouldShowAssistantThinking(false, []), false)
  assert.equal(shouldShowAssistantThinking(true, [{
    role: 'assistant', status: 'running',
  }]), false)
  assert.equal(shouldShowAssistantThinking(true, [
    { role: 'user', status: 'succeeded' },
    { role: 'assistant', status: 'succeeded' },
  ]), false)
  assert.equal(shouldShowAssistantThinking(true, [
    { role: 'user' },
    { role: 'assistant' },
    { role: 'user' },
  ]), true)
  assert.equal(shouldShowAssistantThinking(true, [{
    channel: 'execution', role: 'assistant', run_status: 'running',
  }], 'coordinator'), true)
  assert.equal(shouldShowAssistantThinking(true, [{
    channel: 'coordinator', role: 'assistant', run_status: 'running',
  }], 'coordinator'), false)
})

test('an action inserted during a coordinator reply does not create another coordinator bubble', () => {
  assert.equal(shouldShowAssistantThinking(true, [
    { channel: 'coordinator', role: 'user' },
    { channel: 'coordinator', role: 'assistant', run_status: 'running' },
    { channel: 'action', role: 'user' },
    { channel: 'action', role: 'assistant', run_status: 'failed' },
  ], 'coordinator'), false)
})

test('all editable conversation containers use the shared thinking reply', () => {
  assert.match(assistantPanelSource, /<AssistantThinkingMessage/)
  assert.match(taskDetailSource, /<AssistantThinkingMessage/)
})

test('optimistic assistant reply aligns a shared processing label directly with the avatar', () => {
  assert.match(thinkingMessageSource, /<StreamingStatusText label=\{t\('bubble\.thinking'\)\} \/>/)
  assert.doesNotMatch(thinkingMessageSource, /MessageMetaBar/)
  assert.doesNotMatch(thinkingMessageSource, /label:\s*string/)
  assert.doesNotMatch(assistantPanelSource, /<AssistantThinkingMessage[\s\S]*?label=\{copy\.thinking\}/)
  assert.doesNotMatch(taskDetailSource, /<AssistantThinkingMessage[\s\S]*?label=\{t\('aiFlow\.thinking'\)\}/)
})
