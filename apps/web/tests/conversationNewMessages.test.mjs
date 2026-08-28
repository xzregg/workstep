import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const assistantPanel = await readFile(
  new URL('../src/components/AssistantChatPanel.tsx', import.meta.url),
  'utf8',
)
const taskDetail = await readFile(
  new URL('../src/components/TaskDetailView.tsx', import.meta.url),
  'utf8',
)
const taskDetailPage = await readFile(
  new URL('../src/pages/TaskDetail.tsx', import.meta.url),
  'utf8',
)
const indicator = await readFile(
  new URL('../src/components/ConversationNewMessagesButton.tsx', import.meta.url),
  'utf8',
)

test('every streaming conversation offers the shared new-message action', () => {
  assert.match(assistantPanel, /<ConversationNewMessagesButton/)
  assert.match(taskDetail, /<ConversationNewMessagesButton/)
  assert.match(indicator, /aria-live="polite"/)
  assert.match(indicator, /Icon name="chevron-down"/)
})

test('the rendered conversation is the only owner of its scroll position', () => {
  assert.match(taskDetail, /container\.scrollTop = target/)
  assert.doesNotMatch(taskDetailPage, /container\.scrollTop = target/)
  assert.doesNotMatch(taskDetailPage, /addEventListener\('load', onMediaLoad/)
})
