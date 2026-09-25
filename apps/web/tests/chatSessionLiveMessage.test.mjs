import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const panelSource = await readFile(
  new URL('../src/components/AssistantChatPanel.tsx', import.meta.url),
  'utf8',
)
const pageSource = await readFile(
  new URL('../src/pages/ChatPage.tsx', import.meta.url),
  'utf8',
)
const clientSource = await readFile(
  new URL('../src/api/conversations.ts', import.meta.url),
  'utf8',
)
const pendingSource = await readFile(
  new URL('../src/components/PendingMessageInserts.tsx', import.meta.url),
  'utf8',
)
const assistantPendingSource = await readFile(
  new URL('../src/hooks/useAssistantPendingInserts.tsx', import.meta.url),
  'utf8',
)
const taskDetailSource = await readFile(
  new URL('../src/components/TaskDetailView.tsx', import.meta.url),
  'utf8',
)
const taskDetailPageSource = await readFile(
  new URL('../src/pages/TaskDetail.tsx', import.meta.url),
  'utf8',
)
const taskDetailChatSource = await readFile(
  new URL('../src/pages/taskDetailChat.ts', import.meta.url),
  'utf8',
)

test('session chat queues drafts against the running assistant message', () => {
  assert.match(panelSource, /useAssistantPendingInserts\(\{/)
  assert.match(panelSource, /running && queueEnabled/)
  assert.match(pageSource, /chatSessionApi\.sendLiveMessage\(/)
  assert.match(pageSource, /onSendContent=\{sendPendingContent\}/)
  assert.doesNotMatch(pageSource, /chatInsertQueue|loadInsertQueue|saveInsertQueue/)
})

test('session chat treats a running assistant bubble as an active turn', () => {
  assert.match(
    pageSource,
    /const running = Boolean\(session\?\.running \|\| messages\.some\([\s\S]{0,180}message\.status === 'running'/,
  )
})

test('all editable assistant chats reuse the backend pending-insert panel', () => {
  assert.match(pendingSource, /export default function PendingMessageInserts/)
  assert.match(assistantPendingSource, /<PendingMessageInserts/)
  assert.match(panelSource, /\{pendingPanel\}/)
  assert.match(taskDetailSource, /<PendingMessageInserts/)
  assert.match(clientSource, /pendingMessageInsertApi/)
  assert.match(clientSource, /\/pending-message-inserts/)
})

test('task step and coordinator queues are keyed by the active message id', () => {
  assert.match(taskDetailPageSource, /pendingTargetMessageId/)
  assert.match(taskDetailPageSource, /useTaskPendingInserts\(\{/)
  assert.match(taskDetailPageSource, /pendingInserts\.add\(submittedPrompt\)/)
  assert.doesNotMatch(taskDetailPageSource, /chatInsertQueue|loadTaskInsertQueue|saveTaskInsertQueue/)
})

test('task step pending inserts keep their immediate-send actions wired', () => {
  assert.match(taskDetailPageSource, /pendingInserts\.send\(\[insert\]\)/)
  assert.match(taskDetailPageSource, /pendingInserts\.send\(pendingInserts\.items\)/)
  assert.match(taskDetailPageSource, /onStepInsertSend=/)
  assert.match(taskDetailPageSource, /onSendAllInserts=/)
})

test('task coordinator messages carry their channel before the request resolves', () => {
  assert.match(taskDetailChatSource, /export function createOptimisticCoordinatorMessage/)
  assert.match(
    taskDetailPageSource,
    /createOptimisticCoordinatorMessage\(\s*optimisticId,\s*(submittedPrompt|content),/,
  )
})
