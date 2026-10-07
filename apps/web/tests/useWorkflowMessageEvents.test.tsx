import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { workflowGenApi } from '../src/api/conversations'
import { I18nProvider } from '../src/i18n'
import { useWorkflowMessageEvents } from '../src/hooks/useWorkflowMessageEvents'
import { useWorkflowGenStore } from '../src/stores/workflowGenStore'

test('an HTML detail response leaves the workflow reply status intact and remains retryable', async () => {
  const { window } = installDomEnvironment()
  const originalFetch = globalThis.fetch
  let load!: (id: string) => Promise<void>
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  function Harness() {
    load = useWorkflowMessageEvents('project', 'workflow', 'session')
    return null
  }
  try {
    useWorkflowGenStore.setState({ sessions: {} })
    useWorkflowGenStore.getState().hydrateSession('session', [{
      id: 'reply', role: 'assistant', status: 'stopped', content: '已生成方案',
      event_detail: { available: true, loaded: false },
    }])
    globalThis.fetch = async () => new Response('<!doctype html><title>WorkStep</title>', {
      headers: { 'Content-Type': 'text/html' },
    })
    await act(async () => root.render(<I18nProvider><Harness /></I18nProvider>))
    await act(async () => load('reply'))
    let message = useWorkflowGenStore.getState().sessions.session.messages[0]
    assert.equal(message.status, 'stopped')
    assert.equal(message.content, '已生成方案')
    assert.equal(message.event_detail?.loading, false)
    assert.match(message.event_detail?.error || '', /接口返回了网页/)

    globalThis.fetch = async () => Response.json({
      message_id: 'reply', events: [{ type: 'TOOL_CALL_START', toolCallId: 'read', toolCallName: 'Read' }],
      event_count: 1, last_event_seq: 1, complete: true, next_cursor: null,
    })
    await act(async () => load('reply'))
    message = useWorkflowGenStore.getState().sessions.session.messages[0]
    assert.equal(message.event_detail?.loaded, true)
    assert.ok(!message.event_detail?.error)
    assert.equal(message.status, 'stopped')
  } finally {
    await act(async () => root.unmount())
    globalThis.fetch = originalFetch
    useWorkflowGenStore.setState({ sessions: {} })
    await window.happyDOM.close()
  }
})

test('workflow process details load all pages once and can retry a failure', async () => {
  const { window } = installDomEnvironment()
  const original = workflowGenApi.messageEvents
  let load!: (id: string) => Promise<void>
  let requests = 0
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  function Harness() {
    load = useWorkflowMessageEvents('project', 'workflow', 'session')
    return null
  }
  try {
    useWorkflowGenStore.setState({ sessions: {} })
    useWorkflowGenStore.getState().hydrateSession('session', [{
      id: 'reply', role: 'assistant', status: 'succeeded', content: '完成',
      event_summary: { tool_count: 1 }, event_detail: { available: true, loaded: false },
    }])
    workflowGenApi.messageEvents = async (_project, _workflow, message, cursor = 0) => {
      requests++
      if (requests === 1) throw new Error('读取失败')
      await Promise.resolve()
      return { message_id: message, events: cursor === 0
        ? [{ type: 'REASONING_MESSAGE_CHUNK', delta: '检查流程' }]
        : [{ type: 'TOOL_CALL_START', toolCallId: 'read', toolCallName: 'Read' }],
        event_count: 2, last_event_seq: 2, complete: cursor === 1, next_cursor: cursor === 0 ? 1 : null }
    }
    await act(async () => root.render(<I18nProvider><Harness /></I18nProvider>))
    await act(async () => load('reply'))
    assert.equal(useWorkflowGenStore.getState().sessions.session.messages[0].event_detail?.error, '读取失败')
    await act(async () => { await Promise.all([load('reply'), load('reply')]) })
    const message = useWorkflowGenStore.getState().sessions.session.messages[0]
    assert.equal(requests, 3)
    assert.equal(message.event_detail?.loaded, true)
    assert.deepEqual(message.events?.map(e => e.type), ['REASONING_MESSAGE_CHUNK', 'TOOL_CALL_START'])
    await act(async () => load('reply'))
    assert.equal(requests, 3)
  } finally {
    await act(async () => root.unmount())
    workflowGenApi.messageEvents = original
    useWorkflowGenStore.setState({ sessions: {} })
    await window.happyDOM.close()
  }
})
