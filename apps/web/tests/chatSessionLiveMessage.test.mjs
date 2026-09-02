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

test('task and session chats reuse one pending-insert panel with edit and retry actions', () => {
  assert.match(pendingSource, /export default function PendingMessageInserts/)
  assert.match(pendingSource, /onSend/)
  assert.match(pendingSource, /onEditSave/)
  assert.match(pendingSource, /onClear/)
  assert.match(taskDetailSource, /<PendingMessageInserts/)
  assert.match(pageSource, /<PendingMessageInserts/)
})
