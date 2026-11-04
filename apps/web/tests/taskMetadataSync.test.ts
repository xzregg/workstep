import './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { taskApi, type Task } from '../src/api/client'
import { useProjectStore } from '../src/stores/projectStore'
import { useTaskStore } from '../src/stores/taskStore'

test('task metadata notifications refresh only the changed task from its project', async () => {
  const original = taskApi.get
  const state = useTaskStore.getState()
  const calls: string[][] = []
  taskApi.get = async (id, project) => {
    calls.push([id, project])
    return { id, title: 'Updated', description: 'Updated description', steps: [] } as unknown as Task
  }
  useTaskStore.setState({ tasks: [{ id: 'task', title: 'Before' }] as Task[] })
  try {
    useTaskStore.getState().handleWsEvent({ type: 'CUSTOM', name: 'workstep.task_updated',
      task_id: 'task', project_id: 'project', value: {} })
    await Promise.resolve()
    assert.deepEqual(calls, [['task', 'project']])
    assert.equal(useTaskStore.getState().tasks[0].description, 'Updated description')
  } finally { taskApi.get = original; useTaskStore.setState(state) }
})


test('a passed stage preserves task execution state until task completion arrives', () => {
  const state = useTaskStore.getState()
  const projectState = useProjectStore.getState()
  useProjectStore.setState({ activeProject: { id: 'project' } as any, projectRunningState: { project: true } })
  useTaskStore.setState({ tasks: [{ id: 'task', status: 'running', steps: [
    { step_key: 'build', status: 'running' }, { step_key: 'verify', status: 'pending' },
  ] }] as Task[] })
  try {
    useTaskStore.getState().handleWsEvent({ type: 'CUSTOM', name: 'workstep.status',
      task_id: 'task', project_id: 'project', step_key: 'build', value: { status: 'passed' } })
    assert.equal(useTaskStore.getState().tasks[0].steps[0].status, 'passed')
    assert.equal(useTaskStore.getState().tasks[0].status, 'running')
    useTaskStore.getState().handleWsEvent({ type: 'CUSTOM', name: 'workstep.status',
      task_id: 'task', project_id: 'project', step_key: '', value: { status: 'completed' } })
    assert.equal(useTaskStore.getState().tasks[0].status, 'completed')
    assert.equal(useProjectStore.getState().projectRunningState.project, false)
  } finally { useTaskStore.setState(state); useProjectStore.setState(projectState) }
})

test('live coordinator instructions retain source and initiator through completion', () => {
  const state = useTaskStore.getState()
  useTaskStore.setState({ liveMessages: {} })
  try {
    useTaskStore.getState().handleWsEvent({ type: 'TEXT_MESSAGE_START',
      task_id: 'task', messageId: 'dispatch', channel: 'execution', step_key: 'build', role: 'user',
      content: '执行构建', status: 'queued', actor: { id: 'coordinator', name: '协调助手',
        type: 'coordinator', initiated_by_user_id: 'requester', source_message_id: 'coordinator-reply' } })
    useTaskStore.getState().handleWsEvent({ type: 'TEXT_MESSAGE_END',
      task_id: 'task', messageId: 'dispatch', status: 'succeeded' })
    const message = useTaskStore.getState().liveMessages.task.dispatch
    assert.equal(message.author_type, 'coordinator')
    assert.equal(message.author_name, '协调助手')
    assert.equal(message.initiated_by_user_id, 'requester')
    assert.equal(message.reply_to_message_id, 'coordinator-reply')
    assert.equal(message.status, 'succeeded')
  } finally { useTaskStore.setState(state) }
})
