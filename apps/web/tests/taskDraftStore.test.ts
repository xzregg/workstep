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

test('keeps generated title and destination from the scheduled (agent) mode payload', () => {
  useTaskDraftStore.setState({ sessions: {} })
  const store = useTaskDraftStore.getState()
  store.newSession('schedule-1')
  store.handleWsEvent({
    type: 'CUSTOM',
    name: 'workstep.task_draft',
    channel: 'task_create',
    session_id: 'schedule-1',
    messageId: 'assistant-2',
    value: {
      title: '生成的标题',
      description: '## 任务内容',
      workflow_id: 'wf-1',
      start_step_key: 'test',
    },
  })

  assert.deepEqual(
    useTaskDraftStore.getState().sessions['schedule-1'].latestResult,
    {
      title: '生成的标题',
      description: '## 任务内容',
      workflow_id: 'wf-1',
      start_step_key: 'test',
    },
  )
})

test('allows an agent-mode result without a start step', () => {
  useTaskDraftStore.setState({ sessions: {} })
  const store = useTaskDraftStore.getState()
  store.newSession('schedule-2')
  store.handleWsEvent({
    type: 'CUSTOM',
    name: 'workstep.task_draft',
    channel: 'task_create',
    session_id: 'schedule-2',
    messageId: 'assistant-3',
    value: {
      title: '标题',
      description: '内容',
      workflow_id: 'wf-2',
    },
  })

  const result = useTaskDraftStore.getState().sessions['schedule-2'].latestResult
  assert.equal(result?.title, '标题')
  assert.equal(result?.workflow_id, 'wf-2')
  assert.equal(result?.start_step_key, '')
})
