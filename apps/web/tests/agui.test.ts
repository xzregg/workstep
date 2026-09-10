import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CUSTOM,
  appendMessageContent,
  customValue,
  isCustom,
  isReasoningEvent,
  isRunEvent,
  isToolEvent,
  messageId,
  toolArgs,
  toolCallId,
  toolName,
  toolOutput,
} from '../src/utils/agui.ts'
import { createAssistantStore } from '../src/stores/assistantStore.ts'
import { useTaskStore } from '../src/stores/taskStore.ts'

test('messageId prefers AG-UI camelCase and falls back to snake_case', () => {
  assert.equal(messageId({ messageId: 'm-1' }), 'm-1')
  assert.equal(messageId({ message_id: 'm-2' }), 'm-2')
  assert.equal(messageId({}), undefined)
})

test('isCustom / customValue work with workstep names', () => {
  const event = { type: 'CUSTOM', name: CUSTOM.taskDraft, value: { description: 'd' } }
  assert.equal(isCustom(event, CUSTOM.taskDraft), true)
  assert.equal(isCustom(event, CUSTOM.flowProposals), false)
  assert.deepEqual(customValue(event), { description: 'd' })
  assert.deepEqual(customValue({ type: 'CUSTOM' }), {})
})

test('reasoning / tool / run event predicates', () => {
  assert.equal(isReasoningEvent({ type: 'REASONING_MESSAGE_CHUNK' }), true)
  assert.equal(isReasoningEvent({ type: 'thinking_delta' }), false)
  for (const type of ['TOOL_CALL_START', 'TOOL_CALL_ARGS', 'TOOL_CALL_CHUNK', 'TOOL_CALL_RESULT']) {
    assert.equal(isToolEvent({ type }), true, type)
  }
  assert.equal(isToolEvent({ type: 'tool_use' }), false)
  for (const type of ['RUN_STARTED', 'RUN_FINISHED', 'RUN_ERROR']) {
    assert.equal(isRunEvent({ type }), true, type)
  }
})

test('tool helpers read AG-UI fields with legacy fallbacks', () => {
  assert.equal(toolCallId({ toolCallId: 'c-1' }), 'c-1')
  assert.equal(toolCallId({ tool_call_id: 'c-2' }), 'c-2')
  assert.equal(toolName({ toolCallName: 'Read' }), 'Read')
  assert.equal(toolName({ name: 'Bash' }), 'Bash')
  assert.deepEqual(toolArgs({ args: { path: 'a.py' } }), { path: 'a.py' })
  assert.equal(toolArgs({ delta: '{' }), '{')
  assert.equal(toolOutput({ output: 'ok' }), 'ok')
  assert.equal(toolOutput({ raw_output: 'ok' }), 'ok')
})

test('appendMessageContent appends chunks and replaces on CONTENT', () => {
  assert.equal(appendMessageContent('你好', { type: 'TEXT_MESSAGE_CHUNK', delta: '世界' }), '你好世界')
  assert.equal(appendMessageContent('旧', { type: 'TEXT_MESSAGE_CONTENT', content: '新' }), '新')
  assert.equal(appendMessageContent('旧', { type: 'TEXT_MESSAGE_CONTENT', delta: '新' }), '新')
  assert.equal(appendMessageContent('旧', { type: 'text_delta', delta: 'x' }), '旧')
})

test('assistant store consumes AG-UI text, reasoning and tool events in order', () => {
  const store = createAssistantStore({ channel: 'flow' })
  store.getState().newSession('session-1')
  const send = (event: Record<string, unknown>) =>
    store.getState().handleWsEvent({
      ...event,
      channel: 'flow',
      session_id: 'session-1',
      messageId: 'message-1',
    })
  send({ type: 'TEXT_MESSAGE_START' })
  send({ type: 'TEXT_MESSAGE_CHUNK', delta: '先检查。' })
  send({ type: 'REASONING_MESSAGE_CHUNK', delta: '内部推理。' })
  send({ type: 'TOOL_CALL_START', toolCallId: 'read-1', toolCallName: 'Read', args: { path: 'a.py' } })
  send({ type: 'TOOL_CALL_ARGS', toolCallId: 'read-1', args: { path: 'a.py', mode: 'r' } })
  send({ type: 'TOOL_CALL_RESULT', toolCallId: 'read-1', output: 'ok' })
  send({ type: 'TEXT_MESSAGE_CHUNK', delta: '检查完成。' })
  send({ type: 'TEXT_MESSAGE_END', status: 'succeeded' })

  const message = store.getState().sessions['session-1'].messages[0]
  assert.equal(message.content, '先检查。检查完成。')
  assert.equal(message.status, 'succeeded')
  assert.deepEqual(
    message.events?.map((event) => event.type),
    [
      'TEXT_MESSAGE_CHUNK',
      'REASONING_MESSAGE_CHUNK',
      'TOOL_CALL_START',
      'TOOL_CALL_ARGS',
      'TOOL_CALL_RESULT',
      'TEXT_MESSAGE_CHUNK',
    ],
  )
})

test('assistant store keeps a2ui surfaces and structured results per session', () => {
  const store = createAssistantStore({
    channel: 'task_create',
    resultEvent: CUSTOM.taskDraft,
    resultExtractor: (data) =>
      typeof data.description === 'string' ? data as Record<string, unknown> : undefined,
  })
  store.getState().newSession('draft-1')
  const send = (event: Record<string, unknown>) =>
    store.getState().handleWsEvent({
      ...event,
      channel: 'task_create',
      session_id: 'draft-1',
      messageId: 'assistant-1',
    })
  send({
    type: 'CUSTOM',
    name: CUSTOM.a2ui,
    value: { version: '0.9', v: { kind: 'createSurface', components: [] } },
  })
  send({
    type: 'CUSTOM',
    name: CUSTOM.taskDraft,
    value: { description: '## 验收标准', start_step_key: 'test' },
  })

  const session = store.getState().sessions['draft-1']
  assert.deepEqual(session.a2uiMessages?.['assistant-1']?.length, 1)
  assert.deepEqual(session.latestResult, { description: '## 验收标准', start_step_key: 'test' })
})

test('assistant store ignores events from other channels', () => {
  const store = createAssistantStore({ channel: 'flow_gen' })
  store.getState().handleWsEvent({
    type: 'TEXT_MESSAGE_START',
    channel: 'task_create',
    session_id: 'other',
    messageId: 'm-1',
  })
  assert.equal(store.getState().sessions['other'], undefined)
})

test('assistant store replaces session commands without a message id', () => {
  const store = createAssistantStore({ channel: 'session_chat' })
  store.getState().newSession('session-commands')
  const update = (name: string) => store.getState().handleWsEvent({
    type: 'CUSTOM',
    name: CUSTOM.availableCommandsUpdate,
    channel: 'session_chat',
    session_id: 'session-commands',
    value: {
      available_commands: [{ name, description: `${name} command`, input: { hint: 'argument' } }],
    },
  })

  update('test')
  update('review')

  assert.deepEqual(store.getState().sessions['session-commands'].availableCommands, [{
    kind: 'command',
    name: 'review',
    description: 'review command',
    input_hint: 'argument',
    insert_text: '/review ',
    action: 'prompt',
  }])
})

test('task store consumes AG-UI text and run events for live messages', () => {
  useTaskStore.setState({
    tasks: [],
    liveMessages: {},
    events: {},
    content: {},
    taskStatusEvents: 0,
  })
  const send = (event: Record<string, unknown>) =>
    useTaskStore.getState().handleWsEvent({
      ...event,
      task_id: 'task-1',
      channel: 'execution',
    })
  send({ type: 'TEXT_MESSAGE_START', messageId: 'm-1', step_key: 's1', prompt: '完整整理提示词' })
  send({ type: 'TEXT_MESSAGE_CHUNK', messageId: 'm-1', delta: '处理中' })
  send({ type: 'TEXT_MESSAGE_END', messageId: 'm-1', status: 'succeeded' })
  send({ type: 'RUN_FINISHED', status: 'succeeded' })

  const message = useTaskStore.getState().liveMessages['task-1']['m-1']
  assert.equal(message.content, '处理中')
  assert.equal(message.status, 'succeeded')
  assert.equal(message.step_key, 's1')
  assert.equal(message.prompt, '完整整理提示词')
  assert.deepEqual(
    useTaskStore.getState().events['task-1'].map((event) => event.type),
    ['RUN_FINISHED'],
  )
  assert.ok(useTaskStore.getState().taskStatusEvents > 0)
})

test('task store shows an automatic review as soon as its message starts', () => {
  useTaskStore.setState({ tasks: [], liveMessages: {}, events: {}, content: {} })

  useTaskStore.getState().handleWsEvent({
    type: 'TEXT_MESSAGE_START',
    task_id: 'task-reviewing',
    step_key: 'build',
    channel: 'review',
    messageId: 'review-message',
    role: 'assistant',
    status: 'running',
    content: '审核中',
  })

  const message = useTaskStore.getState().liveMessages['task-reviewing']['review-message']
  assert.equal(message.channel, 'review')
  assert.equal(message.status, 'running')
  assert.equal(message.content, '审核中')
})

test('task store keeps compacted events on the current stage message', () => {
  useTaskStore.setState({
    tasks: [],
    liveMessages: {},
    events: {},
    content: {},
    taskStatusEvents: 0,
  })
  const send = (event: Record<string, unknown>) =>
    useTaskStore.getState().handleWsEvent({
      ...event,
      task_id: 'task-compact',
      channel: 'execution',
      step_key: 'build',
      messageId: 'message-compact',
    })

  send({ type: 'TEXT_MESSAGE_START' })
  send({
    type: 'CUSTOM',
    name: CUSTOM.compacted,
    value: { summary: '保留阶段上下文' },
  })
  send({ type: 'TEXT_MESSAGE_CHUNK', delta: '压缩后继续输出' })

  const message = useTaskStore.getState().liveMessages['task-compact']['message-compact']
  assert.equal(message.content, '压缩后继续输出')
  const compacted = message.events.find((event) => event.name === CUSTOM.compacted)
  assert.ok(compacted)
  assert.equal(compacted.value?.summary, '保留阶段上下文')
})

test('task channels and legacy task accumulation exclude explicit commentary', () => {
  useTaskStore.setState({ tasks: [], liveMessages: {}, events: {}, content: {} })
  for (const channel of ['execution', 'review', 'coordinator', 'archive_experience']) {
    for (const [phase, delta] of [['commentary', '正在检查。'], ['final_answer', '完成。']]) {
      useTaskStore.getState().handleWsEvent({
        type: 'TEXT_MESSAGE_CHUNK', task_id: 'phases', channel,
        messageId: channel, phase, delta,
      })
    }
    const message = useTaskStore.getState().liveMessages.phases[channel]
    assert.equal(message.content, '完成。')
    assert.equal(message.events[0].phase, 'commentary')
  }
  for (const [phase, delta] of [['commentary', '我先检查。'], ['final_answer', '完成。']]) {
    useTaskStore.getState().handleWsEvent({ type: 'TEXT_MESSAGE_CHUNK', task_id: 'legacy-phases', phase, delta })
  }
  assert.equal(useTaskStore.getState().content['legacy-phases'], '完成。')
  assert.equal(useTaskStore.getState().events['legacy-phases'][0].phase, 'commentary')
})

test('task store keeps latest commands per task conversation target', () => {
  useTaskStore.setState({ availableCommands: {} })
  const update = (commands: Array<Record<string, unknown>>) =>
    useTaskStore.getState().handleWsEvent({
      type: 'CUSTOM',
      name: CUSTOM.availableCommandsUpdate,
      task_id: 'task-commands',
      channel: 'execution',
      step_key: 'test',
      value: { available_commands: commands },
    })

  update([{ name: 'test', description: 'Run tests' }])
  update([{ name: 'review', description: 'Review changes' }])

  assert.deepEqual(
    useTaskStore.getState().availableCommands['task-commands']['execution:test'],
    [{
      kind: 'command',
      name: 'review',
      description: 'Review changes',
      insert_text: '/review ',
      action: 'prompt',
    }],
  )
})

test('task store updates task status from workstep.status CUSTOM events', () => {
  useTaskStore.setState({
    tasks: [{
      id: 'task-1',
      title: 't',
      description: null,
      cwd: '/tmp',
      status: 'running',
      engine: 'codex',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      steps: [],
    }],
    liveMessages: {},
    events: {},
    content: {},
    taskStatusEvents: 0,
  })
  useTaskStore.getState().handleWsEvent({
    type: 'CUSTOM',
    name: CUSTOM.status,
    task_id: 'task-1',
    status: 'passed',
    step_key: 's1',
    value: { status: 'passed', step_key: 's1' },
  })
  assert.equal(useTaskStore.getState().tasks[0].status, 'ready')
})

test('task detail can refresh a stale created-task snapshot from the server', async () => {
  useTaskStore.setState({
    tasks: [{
      id: 'task-created-running',
      title: '立即执行任务',
      description: null,
      cwd: '/tmp',
      status: 'running',
      engine: 'claude',
      created_at: '2026-08-14T00:00:00Z',
      updated_at: '2026-08-14T00:00:00Z',
      steps: [{
        step_key: 'requirement',
        status: 'pending',
        engine: 'claude',
        started_at: null,
        ended_at: null,
        error: null,
      }],
    }],
  })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    assert.equal(
      String(input),
      '/api/task/task-created-running?project_id=project-1',
    )
    return new Response(JSON.stringify({
      ...useTaskStore.getState().tasks[0],
      steps: [{
        step_key: 'requirement',
        status: 'running',
        engine: 'claude',
        started_at: '2026-08-14T00:00:01Z',
        ended_at: null,
        error: null,
      }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  try {
    await useTaskStore.getState().refreshTask(
      'task-created-running',
      'project-1',
    )
    assert.equal(useTaskStore.getState().tasks[0].steps[0].status, 'running')
  } finally {
    globalThis.fetch = originalFetch
  }
})
