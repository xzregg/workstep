import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const storeSource = fs.readFileSync(new URL('../src/stores/taskStore.ts', import.meta.url), 'utf8')
const detailSource = fs.readFileSync(new URL('../src/pages/TaskDetail.tsx', import.meta.url), 'utf8')
const historySource = fs.readFileSync(new URL('../src/hooks/useTaskHistory.ts', import.meta.url), 'utf8')
const assistantStoreSource = fs.readFileSync(new URL('../src/stores/assistantStore.ts', import.meta.url), 'utf8')

test('task store surfaces remote user-message events without rendering live user bubbles', () => {
  assert.match(storeSource, /userMessageEvents: Record<string, number>/)
  assert.match(storeSource, /userMessageEvents: \{\}/)
  assert.match(storeSource, /event\.role === 'user'/)
  assert.match(storeSource, /User messages are rendered from persisted history/)
})

test('task details pass remote user-message refresh signals to their history module', () => {
  assert.match(detailSource, /s\.userMessageEvents\[taskId\]/)
  assert.match(detailSource, /useTaskHistory\(\{/)
  // Refresh requests and recovery are exercised by taskHistory.test.tsx.
  assert.match(detailSource, /userMessageEvents,\s*reviewEventSignal/)
})

test('task details load older history when the conversation is scrolled to the top', () => {
  assert.match(historySource, /const PAGE_SIZE = 300/)
  assert.match(historySource, /taskApi\.history\(taskId, projectId, PAGE_SIZE, offset\)/)
  assert.match(detailSource, /onLoadOlderHistory=\{loadOlderHistory\}/)
})

test('open task details do not poll history and overwrite loaded message details', () => {
  assert.doesNotMatch(historySource, /REMOTE_CHAT_HISTORY_SYNC_MS/)
  assert.doesNotMatch(historySource, /window\.setInterval\(syncHistory/)
  assert.match(historySource, /mergeRefreshedTaskHistory/)
})

test('assistant chat adopts optimistic user bubbles and carries sender identity', () => {
  assert.match(assistantStoreSource, /startsWith\('user-'\)/)
  assert.match(assistantStoreSource, /event\.actor\?\.name/)
  assert.match(assistantStoreSource, /author_device_id: event\.actor\?\.device_id/)
  assert.match(assistantStoreSource, /content: isUserEvent \? String\(event\.content \?\? ''\)/)
})
