import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const chatPageSource = await readFile(
  new URL('../src/pages/ChatPage.tsx', import.meta.url),
  'utf8',
)
const assistantPanelSource = await readFile(
  new URL('../src/components/AssistantChatPanel.tsx', import.meta.url),
  'utf8',
)

test('session chat metadata displays the WorkStep session id', () => {
  assert.match(chatPageSource, /<AssistantChatPanel[\s\S]*sessionId=\{sessionId\}/)
  assert.match(assistantPanelSource, /sessionId\?: string \| null/)
  assert.match(assistantPanelSource, /<MessageMetaBar[\s\S]*sessionId=\{sessionId\}/)
})
