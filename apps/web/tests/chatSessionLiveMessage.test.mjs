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
  new URL('../src/api/client.ts', import.meta.url),
  'utf8',
)
const pendingSource = await readFile(
  new URL('../src/components/PendingMessageInserts.tsx', import.meta.url),
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
  assert.match(panelSource, /message\.role === 'assistant' && message\.status === 'running'/)
  assert.match(panelSource, /pendingActions\.addPending\(projectId, activeMessageId, content\)/)
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
  assert.match(panelSource, /<PendingMessageInserts/)
  assert.match(panelSource, /onSend=\{\(item\) => void sendPendingInserts\(\[item\]\)\}/)
  assert.match(panelSource, /onSendAll=\{\(\) => void sendPendingInserts\(pendingInserts\)\}/)
  assert.match(taskDetailSource, /<PendingMessageInserts/)
  assert.match(clientSource, /pendingMessageInsertApi/)
  assert.match(clientSource, /\/pending-message-inserts/)
})

test('task stage and coordinator queues are keyed by the active message id', () => {
  assert.match(taskDetailPageSource, /pendingTargetMessageId/)
  assert.match(taskDetailPageSource, /pendingInsertQueueKey\(projectId, pendingTargetMessageId\)/)
  assert.match(taskDetailPageSource, /pendingInsertActions\.add\(projectId, pendingTargetMessageId, submittedPrompt\)/)
  assert.doesNotMatch(taskDetailPageSource, /chatInsertQueue|loadTaskInsertQueue|saveTaskInsertQueue/)
})

test('task stage pending inserts keep their immediate-send actions wired', () => {
  assert.match(taskDetailPageSource, /const sendStageInserts = async/)
  assert.match(taskDetailPageSource, /const sendCoordinatorInserts = async/)
  assert.match(taskDetailPageSource, /taskApi\.sendStageMessage\(/)
  assert.match(taskDetailPageSource, /taskApi\.chat\([\s\S]{0,180}sendingIds/)
  assert.match(taskDetailPageSource, /onStageInsertSend=/)
  assert.match(taskDetailPageSource, /onSendAllInserts=/)
})

test('task coordinator messages carry their channel before the request resolves', () => {
  assert.match(taskDetailChatSource, /export function createOptimisticCoordinatorMessage/)
  assert.match(
    taskDetailPageSource,
    /createOptimisticCoordinatorMessage\(\s*optimisticId,\s*(submittedPrompt|content),/,
  )
})
