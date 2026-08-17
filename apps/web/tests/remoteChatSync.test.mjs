import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const storeSource = fs.readFileSync(new URL('../src/stores/taskStore.ts', import.meta.url), 'utf8')
const detailSource = fs.readFileSync(new URL('../src/pages/TaskDetail.tsx', import.meta.url), 'utf8')

test('task store surfaces remote user-message events without rendering live user bubbles', () => {
  assert.match(storeSource, /userMessageEvents: Record<string, number>/)
  assert.match(storeSource, /userMessageEvents: \{\}/)
  assert.match(storeSource, /event\.role === 'user'/)
  assert.match(storeSource, /User messages are rendered from persisted history/)
})

test('open task details refresh persisted history when a user message arrives', () => {
  assert.match(detailSource, /s\.userMessageEvents\[taskId\]/)
  assert.match(detailSource, /taskApi\.history\(taskId, projectId, 50, 0\)/)
  assert.match(detailSource, /setHistoryMessages\(response\.messages \|\| \[\]\)/)
})
