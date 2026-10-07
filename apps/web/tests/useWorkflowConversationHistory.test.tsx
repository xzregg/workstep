import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { workflowGenApi } from '../src/api/conversations'
import { useWorkflowConversationHistory } from '../src/hooks/useWorkflowConversationHistory'
import { useWorkflowGenStore } from '../src/stores/workflowGenStore'

test('workflow reconnect recovers split messages and completion without overlapping requests', async () => {
  const { window } = installDomEnvironment()
  const original = workflowGenApi.history
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const sid = 'wf:project:workflow'
  let requests = 0
  let selected = ''
  let unmounted = false
  let release!: () => void
  const pending = new Promise<void>((resolve) => { release = resolve })
  const row = (id: string, status = 'succeeded') => ({ id, role: 'assistant', content: id, status,
    event_summary: { tool_count: 1 }, author_name: '助手' })
  function Harness({ workflow = 'workflow' }) {
    useWorkflowConversationHistory('project', workflow, (id) => { selected = id })
    return null
  }
  try {
    useWorkflowGenStore.setState({ sessions: {} })
    workflowGenApi.history = (async () => {
      const request = ++requests
      if (request === 2) await pending
      return { session_id: sid, engine: 'codex_sdk', messages: request === 1
        ? [row('old', 'running')]
        : [row('old'), { ...row('insert'), role: 'user', content: '补充' }, row('new')] }
    }) as never
    await act(async () => root.render(<Harness />))
    assert.equal(selected, sid)
    assert.equal(useWorkflowGenStore.getState().sessions[sid].running, true)
    await act(async () => {
      window.dispatchEvent(new window.Event('workstep:reconnected'))
      window.dispatchEvent(new window.Event('workstep:reconnected'))
    })
    assert.equal(requests, 2)
    await act(async () => release())
    assert.equal(requests, 3)
    const session = useWorkflowGenStore.getState().sessions[sid]
    assert.equal(session.running, false)
    assert.deepEqual(session.messages.map((message) => message.id), ['old', 'insert', 'new'])
    assert.equal(session.messages[0].event_summary?.tool_count, 1)
    assert.equal(session.messages[0].author_name, '助手')
    await act(async () => root.unmount())
    unmounted = true
    await act(async () => window.dispatchEvent(new window.Event('workstep:reconnected')))
    assert.equal(requests, 3)
  } finally {
    if (!unmounted) await act(async () => root.unmount())
    workflowGenApi.history = original
    useWorkflowGenStore.setState({ sessions: {} })
    await window.happyDOM.close()
  }
})

test('workflow history preserves streamed changes during loading and ignores a switched workflow', async () => {
  const { window } = installDomEnvironment()
  const original = workflowGenApi.history
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const sid = 'wf:p:one'
  let release!: () => void
  const pending = new Promise<void>((resolve) => { release = resolve })
  let releaseSecond!: () => void
  const secondPending = new Promise<void>((resolve) => { releaseSecond = resolve })
  let requests = 0
  let selected = ''
  function Harness({ workflow }: { workflow: string }) {
    useWorkflowConversationHistory('p', workflow, (id) => { selected = id })
    return null
  }
  try {
    useWorkflowGenStore.setState({ sessions: {} })
    const state = useWorkflowGenStore.getState()
    state.hydrateSession(sid, [{ id: 'reply', role: 'assistant', content: '已有', status: 'running' }])
    workflowGenApi.history = (async (_project, workflow) => {
      const request = ++requests
      if (workflow === 'one') await (request === 1 ? pending : secondPending)
      return { session_id: `wf:p:${workflow}`, engine: '', messages: [
        { id: 'reply', role: 'assistant', content: '过时快照', status: 'succeeded' },
      ] }
    }) as never
    await act(async () => root.render(<Harness workflow="one" />))
    state.handleWsEvent({ type: 'TEXT_MESSAGE_CHUNK', channel: 'flow_gen', session_id: sid,
      messageId: 'reply', delta: '新的输出' })
    await act(async () => release())
    assert.equal(useWorkflowGenStore.getState().sessions[sid].messages[0].content, '已有新的输出')
    await act(async () => window.dispatchEvent(new window.Event('workstep:reconnected')))
    await act(async () => root.render(<Harness workflow="two" />))
    assert.equal(selected, 'wf:p:two')
    await act(async () => releaseSecond())
    assert.equal(requests, 3)
    assert.equal(selected, 'wf:p:two')
    assert.equal(useWorkflowGenStore.getState().sessions[sid].messages[0].content, '已有新的输出')
  } finally {
    await act(async () => root.unmount())
    workflowGenApi.history = original
    useWorkflowGenStore.setState({ sessions: {} })
    await window.happyDOM.close()
  }
})
