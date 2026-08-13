import assert from 'node:assert/strict'
import test from 'node:test'

import { useTaskDraftStore } from '../src/stores/taskDraftStore.ts'


test('stores the latest generated task description by session', () => {
  useTaskDraftStore.setState({ sessions: {} })
  const store = useTaskDraftStore.getState()
  store.newSession('draft-1')
  store.handleWsEvent({
    type: 'CUSTOM',
    name: 'workstep.task_draft',
    channel: 'task_create',
    session_id: 'draft-1',
    messageId: 'assistant-1',
    value: { description: '## 验收标准', start_step_key: 'test' },
  })

  assert.deepEqual(
    useTaskDraftStore.getState().sessions['draft-1'].latestResult,
    { description: '## 验收标准', start_step_key: 'test' },
  )
})

test('ignores events from a different assistant channel', () => {
  useTaskDraftStore.setState({ sessions: {} })
  const store = useTaskDraftStore.getState()
  store.handleWsEvent({
    type: 'CUSTOM',
    name: 'workstep.task_draft',
    channel: 'flow_gen',
    session_id: 'draft-2',
    value: { description: '不应写入' },
  })

  assert.equal(useTaskDraftStore.getState().sessions['draft-2'], undefined)
})
