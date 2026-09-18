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
).catch(() => '')
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

test('session chat queues drafts for confirmation instead of injecting immediately', () => {
  assert.doesNotMatch(panelSource, /if \(!input\.trim\(\) \|\| running\) return/)
  assert.match(panelSource, /disabled=\{running && !allowSendWhileRunning\}/)
  assert.match(pageSource, /if \(running\) \{[\s\S]*setPendingInserts/)
  assert.doesNotMatch(pageSource, /if \(running\) \{[\s\S]{0,240}chatSessionApi\.sendLiveMessage/)
  assert.match(pageSource, /sendPendingInserts[\s\S]*chatSessionApi\.sendLiveMessage/)
  const pendingSender = pageSource.slice(
    pageSource.indexOf('const sendPendingInserts'),
    pageSource.indexOf('const savePendingInsertEdit'),
  )
  assert.doesNotMatch(pendingSender, /chatSessionApi\.chat/)
  assert.match(pageSource, /<AssistantChatPanel[\s\S]*allowSendWhileRunning/)
  assert.match(clientSource, /sendLiveMessage:[\s\S]*\/live-message/)
})

test('session chat treats a running assistant bubble as an active turn', () => {
  assert.match(
    pageSource,
    /const running = Boolean\(session\?\.running \|\| messages\.some\([\s\S]{0,180}message\.status === 'running'/,
  )
})

test('pending inserts fall back to the session configuration, not page overrides', () => {
  assert.match(pageSource, /sendMessageNow\(first\.content, \{ useSessionDefaults: true \}\)/)
  assert.match(pageSource, /sendMessageNow\(content, \{ useSessionDefaults: true \}\)/)
  assert.match(
    pageSource,
    /engine: options\.useSessionDefaults \? undefined : selectedEngine \|\| undefined[\s\S]{0,320}provider_id: options\.useSessionDefaults \? undefined : selectedProvider \|\| undefined/,
  )
})

test('pending inserts auto-drain whenever the owning session is idle', () => {
  assert.match(
    pageSource,
    /owner\.sessionId !== queueSessionId \|\| sessionId !== queueSessionId/,
  )
  assert.match(
    pageSource,
    /sessionDetailReadyId !== queueSessionId[\s\S]{0,120}running[\s\S]{0,120}autoDrainingRef\.current[\s\S]{0,120}awaitingRunStartSessionIdsRef\.current\.has\(queueSessionId\)/,
  )
  assert.doesNotMatch(pageSource, /if \(!prev\.running \|\| running \|\| autoDrainingRef\.current\) return/)
})

test('task and session chats reuse one pending-insert panel with edit and retry actions', () => {
  assert.match(pendingSource, /export default function PendingMessageInserts/)
  assert.match(pendingSource, /onSend/)
  assert.match(pendingSource, /onEditSave/)
  assert.match(pendingSource, /onClear/)
  assert.match(taskDetailSource, /<PendingMessageInserts/)
  assert.match(pageSource, /<PendingMessageInserts/)
})

test('task stage inserts auto-drain after a stage becomes idle again', () => {
  assert.match(taskDetailChatSource, /export function shouldAutoDrainStageInsert/)
  assert.match(taskDetailChatSource, /previousKey === stageRunKey/)
  assert.match(taskDetailChatSource, /queueReady/)
  assert.match(
    taskDetailPageSource,
    /shouldAutoDrainStageInsert\(\{[\s\S]{0,260}previousKey: prev\.key[\s\S]{0,240}queueReady: stageQueueReady/,
  )
  assert.match(taskDetailPageSource, /awaitingStageRunStartKeysRef\.current\.has\(stageRunKey\)/)
  assert.doesNotMatch(taskDetailPageSource, /const transition = prev\.running[\s\S]{0,120}!activeStageRunning/)
})

test('task coordinator messages carry their channel before the request resolves', () => {
  assert.match(taskDetailChatSource, /export function createOptimisticCoordinatorMessage/)
  assert.match(
    taskDetailPageSource,
    /createOptimisticCoordinatorMessage\(\s*optimisticId,\s*(submittedPrompt|content),/,
  )
  assert.doesNotMatch(
    taskDetailPageSource,
    /const optimisticMessage = createOptimisticUserMessage\(\s*optimisticId,\s*submittedPrompt,/,
  )
})

test('pending insert queues are hydrated by session and task id only', () => {
  assert.match(pageSource, /loadInsertQueue\(queueSessionId, routeProjectId\)/)
  assert.match(pageSource, /saveInsertQueue\(owner\.sessionId, pendingInserts\)/)
  assert.match(taskDetailPageSource, /loadTaskInsertQueue\(taskId, projectId\)/)
  assert.match(taskDetailPageSource, /saveTaskInsertQueue\(owner\.taskId, stageInserts\)/)
  assert.match(taskDetailPageSource, /stageQueueReady/)
})
