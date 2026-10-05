import assert from 'node:assert/strict'
import test from 'node:test'
import { completionNotice, CompletionDeduplicator, notificationUrl } from '../src/utils/completionNotifications'
import { notifyCompletion, watchPendingCompletion, unwatchPendingCompletion } from '../src/utils/completionNotifications'
import { installDomEnvironment } from './helpers/domEnv'

test('only assistant terminal messages produce completion notices', () => {
  const base = { type: 'TEXT_MESSAGE_END', channel: 'session_chat', project_id: 'p', session_id: 's', messageId: 'm' }
  assert.deepEqual(completionNotice({ ...base, status: 'succeeded' }), {
    id: 'p:s:m', projectId: 'p', sessionId: 's', taskId: null,
    outcome: 'succeeded', title: 'WorkStep 回复完成', body: '会话的回复已完成',
  })
  assert.equal(completionNotice({ ...base, status: 'failed' })?.outcome, 'failed')
  assert.equal(completionNotice({ ...base, status: 'cancelled' }), null)
  assert.equal(completionNotice({ ...base, type: 'TEXT_MESSAGE_CHUNK' }), null)
  assert.equal(completionNotice({ ...base, messageId: '' }), null)
})

test('completion deduplicator prevents a reconnect from alerting twice', () => {
  const dedup = new CompletionDeduplicator()
  assert.equal(dedup.take('p:s:m'), true)
  assert.equal(dedup.take('p:s:m'), false)
  assert.equal(dedup.take('p:s:m2'), true)
})

test('step results produce distinct completion notices', () => {
  const base = { project_id: 'p', task_id: 't', step_key: 'review', sequence: 12 }
  assert.deepEqual(completionNotice({ ...base, type: 'RUN_FINISHED', status: 'passed' }), {
    id: 'p:t:step:review:12', projectId: 'p', sessionId: null, taskId: 't', stepKey: 'review',
    outcome: 'succeeded', title: 'WorkStep 步骤完成', body: '步骤 review 已通过',
  })
  assert.equal(completionNotice({ ...base, type: 'RUN_ERROR', status: 'failed' })?.outcome, 'failed')
  assert.equal(completionNotice({ ...base, type: 'RUN_ERROR', status: 'cancelled' }), null)
  assert.equal(completionNotice({ ...base, type: 'RUN_FINISHED', step_key: '' }), null)
})

test('task notification URL keeps its workflow so the target board can load it', () => {
  const notice = completionNotice({ type: 'RUN_FINISHED', project_id: 'p', task_id: 'task',
    step_key: 'review', status: 'passed' })!
  assert.equal(notificationUrl(notice, 'Demo', 'flow-2'),
    '/tasks?project=Demo&workflow=flow-2&task=task')
})

test('session chat reply opens its session even when an event also carries a task id', () => {
  const notice = completionNotice({ type: 'TEXT_MESSAGE_END', channel: 'session_chat',
    project_id: 'p', session_id: 'session-1', task_id: 'unrelated-task',
    messageId: 'reply-1', status: 'succeeded' })!
  assert.equal(notice.taskId, null)
  assert.equal(notificationUrl(notice, 'Demo'), '/chat?project=Demo&session=session-1')
})

test('desktop bridge receives terminal notice even if the document remains visible', async () => {
  const { window } = installDomEnvironment()
  const delivered: string[] = []
  window.workstepDesktop = { notify: (notice) => delivered.push(notice.id) }
  const notice = completionNotice({ type: 'TEXT_MESSAGE_END', project_id: 'p',
    session_id: 's', messageId: 'desktop-visible', status: 'failed' })!
  notifyCompletion(notice, '/chat?session=s')
  notifyCompletion(notice, '/chat?session=s')
  assert.deepEqual(delivered, ['p:s:desktop-visible'])
  await window.happyDOM.close()
})

test('Android reply watch is registered before the assistant start event', async () => {
  const { window } = installDomEnvironment()
  const sent: Array<{ type: string; id: string; sessionId?: string }> = []
  window.WorkStepAndroid = { postMessage: (raw) => sent.push(JSON.parse(raw)) }
  watchPendingCompletion('p', { sessionId: 's' })
  unwatchPendingCompletion('p', { sessionId: 's' })
  assert.deepEqual(sent, [
    { type: 'watch', id: 'p:s:pending', projectId: 'p', sessionId: 's', taskId: null, url: '/' },
    { type: 'unwatch', id: 'p:s:pending' },
  ])
  await window.happyDOM.close()
})
