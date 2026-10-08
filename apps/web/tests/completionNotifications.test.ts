import assert from 'node:assert/strict'
import test from 'node:test'
import { completionNotice, CompletionDeduplicator, notificationUrl } from '../src/utils/completionNotifications'
import { notifyCompletion, watchPendingCompletion, unwatchPendingCompletion, watchAcceptedCompletion } from '../src/utils/completionNotifications'
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
    { type: 'watch', id: 'p:s:pending', projectId: 'p', sessionId: 's', taskId: null, scopeName: '会话 s', url: '/' },
    { type: 'unwatch', id: 'p:s:pending' },
  ])
  await window.happyDOM.close()
})

test('accepted reply replaces the pending watch with its exact message id', async () => {
  const { window } = installDomEnvironment()
  const sent: Array<{ type: string; id: string }> = []
  window.WorkStepAndroid = { postMessage: (raw) => sent.push(JSON.parse(raw)) }
  watchAcceptedCompletion('p', { sessionId: 's' }, 'accepted-reply')
  assert.deepEqual(sent.map(({ type, id }) => ({ type, id })), [
    { type: 'unwatch', id: 'p:s:pending' }, { type: 'watch', id: 'p:s:accepted-reply' },
  ])
  const notice = completionNotice({ type: 'TEXT_MESSAGE_END', project_id: 'p', session_id: 's',
    messageId: 'fast-reply', status: 'succeeded' })!
  notifyCompletion(notice, '/chat?session=s')
  sent.length = 0
  watchAcceptedCompletion('p', { sessionId: 's' }, 'fast-reply')
  assert.deepEqual(sent.map(({ type, id }) => ({ type, id })), [{ type: 'unwatch', id: 'p:s:pending' }])
  await window.happyDOM.close()
})


test('notifications identify the actual session or task, including Android pending watches', async () => {
  const { window } = installDomEnvironment()
  const { useChatListStore } = await import('../src/stores/chatSessionStore')
  const { useTaskStore } = await import('../src/stores/taskStore')
  const { useProjectStore } = await import('../src/stores/projectStore')
  useChatListStore.setState({ sessionsByProject: { named: [{ id: 'session-name', title: '安卓排查' } as never] } })
  useProjectStore.setState({ activeProject: { id: 'named' } as never })
  useTaskStore.setState({ tasks: [{ id: 'task-name', title: '修复上传' } as never] })
  const sent: Array<{ type: string; title?: string; body?: string; scopeName?: string }> = []
  window.WorkStepAndroid = { postMessage: (raw) => sent.push(JSON.parse(raw)) }
  try {
    watchPendingCompletion('named', { sessionId: 'session-name' })
    watchAcceptedCompletion('named', { taskId: 'task-name' }, 'named-reply')
    assert.equal(sent[0].scopeName, '安卓排查')
    assert.equal(sent[2].scopeName, '修复上传')
    notifyCompletion(completionNotice({ type: 'TEXT_MESSAGE_END', channel: 'session_chat',
      project_id: 'named', session_id: 'session-name', task_id: 'task-name', messageId: 'named-session-reply', status: 'succeeded' })!, '/')
    assert.equal(sent.at(-1)?.scopeName, '安卓排查')
    assert.equal(sent.at(-1)?.title, '安卓排查 · 回复完成')
    assert.equal(sent.at(-1)?.body, '会话「安卓排查」的回复已完成')
    notifyCompletion(completionNotice({ type: 'RUN_ERROR', project_id: 'named', task_id: 'task-name',
      step_key: 'review', status: 'failed' })!, '/')
    assert.equal(sent.at(-1)?.title, '修复上传 · 步骤失败')
    assert.equal(sent.at(-1)?.body, '任务「修复上传」：步骤 review 执行失败')
  } finally {
    useChatListStore.setState({ sessionsByProject: {} })
    useTaskStore.setState({ tasks: [] })
    useProjectStore.setState({ activeProject: null })
    await window.happyDOM.close()
  }
})


test('long notification names are ellipsized without cutting emoji or completion status', async () => {
  const { window } = installDomEnvironment()
  const { useChatListStore } = await import('../src/stores/chatSessionStore')
  useChatListStore.setState({ sessionsByProject: { long: [{ id: 'long-session', title: '😀'.repeat(1000) } as never] } })
  const sent: Array<{ title?: string; body?: string; scopeName?: string }> = []
  window.WorkStepAndroid = { postMessage: raw => sent.push(JSON.parse(raw)) }
  try {
    watchPendingCompletion('long', { sessionId: 'long-session' })
    assert.equal(sent[0].scopeName, '😀'.repeat(19) + '…')
    notifyCompletion(completionNotice({ type: 'TEXT_MESSAGE_END', channel: 'session_chat',
      project_id: 'long', session_id: 'long-session', messageId: 'long-reply', status: 'failed' })!, '/')
    assert.equal(sent.at(-1)?.title, '😀'.repeat(19) + '… · 回复失败')
    assert.equal(sent.at(-1)?.body, '会话「' + '😀'.repeat(19) + '…」的回复失败')
  } finally {
    useChatListStore.setState({ sessionsByProject: {} })
    await window.happyDOM.close()
  }
})
